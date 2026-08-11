"""検索で見つけたマニュアル抜粋をもとに、回答文を生成するプロバイダ。

- StubAnswerGenerator: ローカル開発用。定型文を返す(AWS不要)
- BedrockAnswerGenerator: 本番用。Claude(Bedrock)がマニュアルに基づいた回答を書く

環境変数 ANSWER_PROVIDER=stub|bedrock で切り替える。
"""

import json
import os
import re
from typing import Protocol

# RAGの心臓部: 「抜粋だけを根拠に答えろ」と縛ることで、
# モデルが知らないことを勝手に創作する(ハルシネーション)のを防ぐ。
# さらに「曖昧なら絞り込み質問を返す」ことで、何も分からない人でも対話でたどり着ける
SYSTEM_PROMPT = """あなたは社内マニュアル検索の案内係です。相手は社内の仕組みやマニュアルに詳しくない人だと考えて、専門用語を避け、やさしい言葉で案内してください。

次のルールを必ず守ってください。

- 提供された「マニュアル抜粋」の内容だけを根拠にする。抜粋に書かれていないことは推測しない
- 質問が具体的で該当マニュアルが明確な場合: マニュアル名とページ(例: p.3)を示し、手順を簡潔に案内する
- 状況が曖昧、または複数のマニュアルが当てはまりそうな場合: すぐに答えを出さず、状況を絞り込むための質問を1つだけ返す
- 選択肢を提示するとき(絞り込みの質問・次の提案のどちらも)は、必ずメッセージの最後に、1行につき1つ、次の形式だけで書く(この行は画面上でクリックできるボタンになる):
[選択肢] 選択肢の内容
  - この形式以外(番号付きリスト、スラッシュ区切り、「選択肢:」というラベル書き)は絶対に使わない
  - 選択肢は2〜4個、違いが誰にでも分かる短い言葉にする
  - 本文の中で選択肢の内容を繰り返さないこと
- 相手が選択肢に答えたら、その内容を踏まえて絞り込んだ案内をする
- 具体的に回答できた場合も、メッセージの最後に「次に知りたくなりそうなこと」を[選択肢]形式で2〜3個提案する(例: 関連する手順、注意点、別のケース、お客様への説明例)。ただし抜粋から答えられる内容に限る
- どのマニュアルにも該当しそうにない場合: 正直にそう伝え、問い合わせ先(担当部署など)への相談を提案する
- 手順を説明するときは箇条書きを使う
- メッセージの一番最後に、実際に回答の根拠として使った抜粋の番号を「[参照] 1,3」の形式で1行だけ書く。読んだが使わなかった抜粋は含めない。どの抜粋も使っていない場合は「[参照] なし」と書く。[選択肢]行がある場合は[参照]行をその前に置く"""


# 管理者のチャットにだけ渡す「道具」。Claudeは依頼内容から使うべきツールを判断して
# 呼び出しを返すだけで、実行するのはNestJS側(このサービスはDBの分類を直接触らない)
ADMIN_TOOLS = [
    {
        "toolSpec": {
            "name": "create_folder",
            "description": (
                "マニュアルを整理するフォルダ(カテゴリ)を新しく作成する。"
                "管理者に「フォルダを作って」と明確に頼まれたときだけ使う。"
                "複数作る場合は1つずつ複数回呼び出す"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "フォルダ名(誰にでも分かる簡潔な日本語)",
                        }
                    },
                    "required": ["name"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "reclassify_all_manuals",
            "description": (
                "登録済みの全マニュアルを、現在存在するフォルダへAIが再分類し直す。"
                "フォルダ構成を作り直した後の一括整理に使う。"
                "実行前にシステムが管理者へ確認を取るので、このツールは提案として呼んでよい"
            ),
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    },
]

# 管理者モードのときだけシステムプロンプトに足す補足。
# 本則の「抜粋だけを根拠に・曖昧なら絞り込み質問」が管理操作にまで効くと
# ツールを呼ばずに聞き返してしまうため、管理操作は別扱いだと明確に書く
ADMIN_SYSTEM_ADDENDUM = """

補足(管理者モード): あなたはツールでフォルダ(カテゴリ)の作成と全マニュアルの再分類ができます。
- 「〇〇というフォルダを作って」「マニュアルを再分類して」のような依頼は、マニュアルの内容に関する質問ではなく、この検索システム自体への操作依頼。マニュアル抜粋に根拠を求めず、絞り込み質問もせず、ためらわずに対応するツールを呼び出す
- フォルダ名が指定されていれば、その名前のままcreate_folderを呼ぶ(勝手に変えない)
- マニュアルの内容を知りたい通常の質問には、これまで通り抜粋から回答する(ツールは使わない)
- ツールを使うときは、何をするのかを本文で一言だけ添える(結果の報告はシステムが行うので不要)
- 管理操作の応答では[選択肢]や[参照]の行は書かない"""


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
        tools: list[dict] | None = None,
    ) -> tuple[str, list[dict]]: ...

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str: ...

    def classify_manuals(
        self, manuals: list[dict], categories: list[str], allow_new: bool = True
    ) -> list[dict]: ...


class StubAnswerGenerator:
    """開発用: LLMを呼ばずに定型文を返す"""

    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
    ) -> tuple[str, list[dict]]:
        return (
            f"「{question}」に関連しそうなマニュアルが{len(contexts)}件見つかりました。"
            "詳しくは以下をご覧ください。(回答文の生成はANSWER_PROVIDER=bedrockで有効になります)",
            [],
        )

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        # LLM無しの簡易版: 直近のユーザー発言をつなげるだけ
        recent = " ".join(h.content for h in history[-4:] if h.role == "user")
        return f"{recent} {question}".strip()

    def classify_manuals(
        self, manuals: list[dict], categories: list[str], allow_new: bool = True
    ) -> list[dict]:
        return []  # LLM無しでは分類できない(空=何も割り当てない)


class BedrockAnswerGenerator:
    """本番用: Claude(Bedrock Converse API)で回答を生成する"""

    def __init__(self, model_id: str, region: str):
        from bedrock import create_bedrock_client

        self.client = create_bedrock_client(region)
        self.model_id = model_id

    def generate(
        self,
        question: str,
        contexts: list[Context],
        image: tuple[bytes, str] | None = None,
        history: list[HistoryMessage] | None = None,
        tools: list[dict] | None = None,
    ) -> tuple[str, list[dict]]:
        # 抜粋に番号を振る([参照]行で「どれを使ったか」を申告してもらうため)
        excerpts = "\n\n".join(
            f"【抜粋{i}】{c.title}\n{c.content}"
            for i, c in enumerate(contexts, start=1)
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

        system_prompt = SYSTEM_PROMPT + (ADMIN_SYSTEM_ADDENDUM if tools else "")
        res = self.client.converse(
            modelId=self.model_id,
            system=[{"text": system_prompt}],
            messages=messages,
            inferenceConfig={
                "maxTokens": 1024,
                "temperature": 0.2,  # 事実ベースの回答なので低め(創造性を抑える)
            },
            # ツール(管理操作)は管理者のリクエストのときだけ渡される
            **({"toolConfig": {"tools": tools}} if tools else {}),
        )

        # 応答は「本文テキスト」と「ツール呼び出し」が混在しうるので分けて返す
        answer_parts: list[str] = []
        actions: list[dict] = []
        for block in res["output"]["message"]["content"]:
            if "text" in block:
                answer_parts.append(block["text"])
            elif "toolUse" in block:
                tool_use = block["toolUse"]
                actions.append(
                    {"name": tool_use["name"], "input": tool_use.get("input") or {}}
                )
        return "\n".join(answer_parts).strip(), actions

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str:
        """質問(+会話の文脈)を「検索用キーワード列」に展開する(クエリ拡張)。

        - 「2です」のような返事は、直前のやりとりと合わせて独立したクエリにする
        - 同義語や言い換えも足す(例: フリーダイヤル → 電話番号 連絡先 0800)。
          マニュアル側と質問者の語彙のずれをここで吸収する
        """
        convo = "\n".join(
            f"{'質問者' if h.role == 'user' else '案内係'}: {h.content[:300]}"
            for h in history[-6:]
        )
        prompt = (
            "以下は社内マニュアル検索での会話です。最後の発言の意図を踏まえて、"
            "マニュアル検索に使うキーワード列を作ってください。\n"
            "- 質問の言い換え・同義語・関連する正式名称や表記も含める"
            "(例:「フリーダイヤル」なら 電話番号 連絡先 0800 0120 コールセンター など)\n"
            "- スペース区切りで10語以内。キーワード列だけを出力\n\n"
            f"{convo}\n質問者: {question}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 200, "temperature": 0},
        )
        return res["output"]["message"]["content"][0]["text"].strip()

    def classify_manuals(
        self, manuals: list[dict], categories: list[str], allow_new: bool = True
    ) -> list[dict]:
        """マニュアル一覧をカテゴリに割り当てる(全体を1回のリクエストで見せて
        一貫性のある分類にする)。戻り値: [{"manual_id":…, "category":…}]

        allow_new=False のときは既存カテゴリだけに割り当てる(全件再分類で
        管理者が承認していないフォルダを勝手に増やさないため)。
        """
        lines = "\n".join(
            f"- id={m['manual_id']} タイトル: {m['title']}\n  冒頭: {m['snippet'][:100]}"
            for m in manuals
        )
        existing = "、".join(categories) if categories else "(まだ無い)"
        if allow_new:
            category_rules = (
                "- できるだけ「既存カテゴリ」を使う。適切なものが無い場合だけ新しいカテゴリ名を作る\n"
                "- 新しいカテゴリ名は誰にでも分かる簡潔な日本語(2〜10文字程度)にする\n"
                "- カテゴリを細かく増やしすぎない(マニュアル10件あたり2〜4カテゴリが目安)\n"
            )
        else:
            category_rules = (
                "- 必ず「既存カテゴリ」のいずれかをそのままの名前で割り当てる。"
                "新しいカテゴリ名を作ってはいけない\n"
            )
        prompt = (
            "あなたは社内マニュアルの整理係です。以下のマニュアル一覧を内容ごとにカテゴリ分けしてください。\n\n"
            "ルール:\n"
            f"{category_rules}"
            '- JSON配列のみを出力する: [{"manual_id": "...", "category": "カテゴリ名"}, ...]\n\n'
            f"既存カテゴリ: {existing}\n\nマニュアル一覧:\n{lines}"
        )
        res = self.client.converse(
            modelId=self.model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 4000, "temperature": 0},
        )
        text = res["output"]["message"]["content"][0]["text"]
        match = re.search(r"\[.*\]", text, re.DOTALL)  # コードフェンス等を除去
        if not match:
            raise ValueError("分類結果のJSONを取り出せませんでした")
        return json.loads(match.group(0))


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
