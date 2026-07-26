"""検索で見つけたマニュアル抜粋をもとに、回答文を生成するプロバイダ。

- StubAnswerGenerator: ローカル開発用。定型文を返す(AWS不要)
- BedrockAnswerGenerator: 本番用。Claude(Bedrock)がマニュアルに基づいた回答を書く

環境変数 ANSWER_PROVIDER=stub|bedrock で切り替える。
"""

import os
from typing import Protocol

# RAGの心臓部: 「抜粋だけを根拠に答えろ」と縛ることで、
# モデルが知らないことを勝手に創作する(ハルシネーション)のを防ぐ
SYSTEM_PROMPT = """あなたは社内マニュアル検索アシスタントです。次のルールを必ず守ってください。

- 提供された「マニュアル抜粋」の内容だけを根拠に、日本語で簡潔に回答する
- 抜粋に書かれていないことは推測せず、「マニュアルには該当する記載が見つかりませんでした」と正直に答える
- どのマニュアルを根拠にしたか分かるように、回答の中でマニュアル名に触れる
- 手順を説明するときは箇条書きを使う"""


class Context:
    """回答の根拠となるマニュアル抜粋"""

    def __init__(self, title: str, content: str):
        self.title = title
        self.content = content


class AnswerGenerator(Protocol):
    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
    ) -> str: ...


class StubAnswerGenerator:
    """開発用: LLMを呼ばずに定型文を返す"""

    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
    ) -> str:
        return (
            f"「{question}」に関連しそうなマニュアルが{len(contexts)}件見つかりました。"
            "詳しくは以下をご覧ください。(回答文の生成はANSWER_PROVIDER=bedrockで有効になります)"
        )


class BedrockAnswerGenerator:
    """本番用: Claude(Bedrock Converse API)で回答を生成する"""

    def __init__(self, model_id: str, region: str):
        import boto3  # type: ignore[import-untyped]

        self.client = boto3.client("bedrock-runtime", region_name=region)
        self.model_id = model_id

    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
    ) -> str:
        excerpts = "\n\n".join(
            f"【{c.title}】\n{c.content}" for c in contexts
        )
        user_message = f"# マニュアル抜粋\n{excerpts}\n\n# 質問\n{question}"

        # 質問に画像が添付されていたら、Claudeに画像も一緒に見せる
        content: list[dict] = []
        if image is not None:
            image_bytes, image_format = image
            content.append(
                {"image": {"format": image_format, "source": {"bytes": image_bytes}}}
            )
            user_message += "\n(質問には上の画像が添付されています。画像の内容も踏まえて回答してください)"
        content.append({"text": user_message})

        res = self.client.converse(
            modelId=self.model_id,
            system=[{"text": SYSTEM_PROMPT}],
            messages=[{"role": "user", "content": content}],
            inferenceConfig={
                "maxTokens": 1024,
                "temperature": 0.2,  # 事実ベースの回答なので低め(創造性を抑える)
            },
        )
        return res["output"]["message"]["content"][0]["text"]


def create_answer_generator() -> AnswerGenerator:
    provider = os.environ.get("ANSWER_PROVIDER", "stub")
    if provider == "bedrock":
        return BedrockAnswerGenerator(
            model_id=os.environ.get(
                "BEDROCK_CHAT_MODEL_ID",
                "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
            ),
            region=os.environ.get("AWS_REGION", "ap-northeast-1"),
        )
    return StubAnswerGenerator()
