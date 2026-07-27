"""検索で見つけたマニュアル抜粋をもとに、回答文を生成するプロバイダ。

- StubAnswerGenerator: ローカル開発用。定型文を返す(AWS不要)
- BedrockAnswerGenerator: 本番用。Claude(Bedrock)がマニュアルに基づいた回答を書く

環境変数 ANSWER_PROVIDER=stub|bedrock で切り替える。
"""

import os
from typing import Protocol

# RAGの心臓部: 「抜粋だけを根拠に答えろ」と縛ることで、
# モデルが知らないことを勝手に創作する(ハルシネーション)のを防ぐ。
# さらに「曖昧なら絞り込み質問を返す」ことで、何も分からない人でも対話でたどり着ける
SYSTEM_PROMPT = """あなたは社内マニュアル検索の案内係です。相手は社内の仕組みやマニュアルに詳しくない人だと考えて、専門用語を避け、やさしい言葉で案内してください。

次のルールを必ず守ってください。

- 提供された「マニュアル抜粋」の内容だけを根拠にする。抜粋に書かれていないことは推測しない
- 質問が具体的で該当マニュアルが明確な場合: マニュアル名とページ(例: p.3)を示し、手順を簡潔に案内する
- 状況が曖昧、または複数のマニュアルが当てはまりそうな場合: すぐに答えを出さず、状況を絞り込むための質問を1つだけ返す
- 絞り込みの選択肢(2〜4個)は、メッセージの最後に次の形式で1行ずつ書く(この行は画面上でクリックできるボタンになる):
[選択肢] 選択肢の内容
  - 選択肢は違いが誰にでも分かる短い言葉にする。必要なら「どれにも当てはまらない」も入れる
  - 本文の中で選択肢を番号付きリストとして繰り返さないこと
- 相手が選択肢に答えたら、その内容を踏まえて絞り込んだ案内をする
- 具体的に回答できた場合も、メッセージの最後に「次に知りたくなりそうなこと」を[選択肢]形式で2〜3個提案する(例: 関連する手順、注意点、別のケース、お客様への説明例)。ただし抜粋から答えられる内容に限る
- どのマニュアルにも該当しそうにない場合: 正直にそう伝え、問い合わせ先(担当部署など)への相談を提案する
- 手順を説明するときは箇条書きを使う"""


class Context:
    """回答の根拠となるマニュアル抜粋"""

    def __init__(self, title: str, content: str):
        self.title = title
        self.content = content


class HistoryMessage(Protocol):
    """会話のこれまでのやりとり(役割は 'user' | 'assistant')"""

    role: str
    content: str


class AnswerGenerator(Protocol):
    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
        history: list[HistoryMessage] | None = None,
    ) -> str: ...

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str: ...


class StubAnswerGenerator:
    """開発用: LLMを呼ばずに定型文を返す"""

    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
        history: list[HistoryMessage] | None = None,
    ) -> str:
        return (
            f"「{question}」に関連しそうなマニュアルが{len(contexts)}件見つかりました。"
            "詳しくは以下をご覧ください。(回答文の生成はANSWER_PROVIDER=bedrockで有効になります)"
        )

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        # LLM無しの簡易版: 直近のユーザー発言をつなげるだけ
        recent = " ".join(h.content for h in history[-4:] if h.role == "user")
        return f"{recent} {question}".strip()


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
        history: list[HistoryMessage] | None = None,
    ) -> str:
        excerpts = "\n\n".join(
            f"【{c.title}】\n{c.content}" for c in contexts
        )
        user_message = f"# マニュアル抜粋\n{excerpts}\n\n# 質問\n{question}"

        # これまでの会話をそのまま前段のターンとして渡す。
        # 「1と2どちら？」→「1です」のような絞り込みの文脈をClaudeが理解できる
        messages: list[dict] = [
            {
                "role": "user" if h.role == "user" else "assistant",
                "content": [{"text": h.content}],
            }
            for h in (history or [])
        ]

        # 質問に画像が添付されていたら、Claudeに画像も一緒に見せる
        content: list[dict] = []
        if image is not None:
            image_bytes, image_format = image
            content.append(
                {"image": {"format": image_format, "source": {"bytes": image_bytes}}}
            )
            user_message += "\n(質問には上の画像が添付されています。画像の内容も踏まえて回答してください)"
        content.append({"text": user_message})
        messages.append({"role": "user", "content": content})

        res = self.client.converse(
            modelId=self.model_id,
            system=[{"text": SYSTEM_PROMPT}],
            messages=messages,
            inferenceConfig={
                "maxTokens": 1024,
                "temperature": 0.2,  # 事実ベースの回答なので低め(創造性を抑える)
            },
        )
        return res["output"]["message"]["content"][0]["text"]

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        """会話の文脈を織り込んだ「独立した検索クエリ」を作る(クエリ書き換え)。

        「2です」のような返事は単体ではベクトル検索できないため、
        直前のやりとりと合わせて「トイレの水漏れ 対応手順」のような形に変換する
        """
        convo = "\n".join(
            f"{'質問者' if h.role == 'user' else '案内係'}: {h.content[:300]}"
            for h in history[-6:]
        )
        prompt = (
            "以下は社内マニュアル検索での会話です。最後の発言の意図を踏まえて、"
            "マニュアルを検索するための独立した検索クエリを1行だけ作ってください。"
            "クエリ本文のみを出力してください。\n\n"
            f"{convo}\n質問者: {question}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 200, "temperature": 0},
        )
        return res["output"]["message"]["content"][0]["text"].strip()


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
