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

- 挨拶・お礼・前置きは書かず、最初の1文から用件(答え、または絞り込みの質問)に入る。「ありがとうございます」「こんにちは」「マニュアル抜粋をいただきました」のような書き出しは禁止
- 「マニュアル抜粋」は利用者には見えない内部の仕組みなので、回答の中でその存在に触れない。根拠を示すときは「抜粋によると」ではなく「〇〇(マニュアル名)によると」と書く
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
- そのままコピーして使える文章(メール本文・件名・お客様への説明文・テンプレート文など)は、必ずコードブロック(```で囲む)で示す。画面上でその部分だけをコピーできるボタンが付くため。説明や補足はコードブロックの外に書く
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
            "name": "move_manual",
            "description": (
                "特定のマニュアル1件を、指定のフォルダへ今すぐ移動する。"
                "「〇〇のマニュアルを△△に入れて」のように、その1件をどうしたいかの"
                "指示に使う。今後の分類方針を決めたい場合は"
                "add_classification_ruleを使う(両方の意図があるなら両方呼ぶ)"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "manual": {
                            "type": "string",
                            "description": "移動するマニュアル名(一部でもよい)。例:「床鳴り」",
                        },
                        "folder": {
                            "type": "string",
                            "description": (
                                "移動先のフォルダ名(一部でもよい)。"
                                "分類を外して未分類に戻す場合は「未分類」"
                            ),
                        },
                    },
                    "required": ["manual", "folder"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "add_classification_rule",
            "description": (
                "分類ルールを追加する。管理者が「今後〜は〜のフォルダに分類して」のように、"
                "以後の自動分類で守ってほしい方針・好みを伝えたときに使う。"
                "保存されたルールは、アップロード時の自動分類や全件再分類のすべてで最優先適用される"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "ルールの内容(自然文のまま。例:「床暖房関連はフローリング関連に入れる」)",
                        }
                    },
                    "required": ["text"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "list_classification_rules",
            "description": "登録済みの分類ルールを一覧表示する。「分類ルールを見せて」のような依頼で使う",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    },
    {
        "toolSpec": {
            "name": "remove_classification_rule",
            "description": (
                "分類ルールを削除する。どのルールかは可能な限りtextで指定する"
                "(番号は会話の途中でずれるため信頼できない)。"
                "削除対象が曖昧なときはシステムが候補を返すので、"
                "推測で番号を埋めず、分かっている手がかりをtextに入れる"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "削除するルールの文言(一部でもよい)。例:「床暖房」",
                        },
                        "number": {
                            "type": "integer",
                            "description": (
                                "補助。直前に表示した一覧の番号(1始まり)が確実に分かる場合だけ使う"
                            ),
                        },
                    },
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "reclassify_all_manuals",
            "description": (
                "登録済みの全マニュアルをAIがフォルダへ再分類し直す(必要なら新しい"
                "フォルダも作られる)。フォルダ構成の一括整理に使う。"
                "実行前にシステムが管理者へ確認を取るので、このツールは提案として呼んでよい"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "instruction": {
                            "type": "string",
                            "description": (
                                "分類の方針(任意)。管理者の依頼に方針が含まれていたら"
                                "そのまま渡す。例:「工種ごとに」「部署ごとに」"
                            ),
                        }
                    },
                }
            },
        }
    },
]

# 管理者モードのときだけシステムプロンプトに足す補足。
# 本則の「抜粋だけを根拠に・曖昧なら絞り込み質問」が管理操作にまで効くと
# ツールを呼ばずに聞き返してしまうため、管理操作は別扱いだと明確に書く
ADMIN_SYSTEM_ADDENDUM = """

補足(管理者モード): あなたはツールでフォルダ(カテゴリ)の作成・全マニュアルの再分類・分類ルールの管理ができます。
- 「特定の1件をどうするか」と「今後の方針」を取り違えない。前者(例:「〇〇のマニュアルをフローリング関連に入れて」)はmove_manualで今すぐ動かす。後者(例:「床暖房関連は今後フローリング関連に入れて」「延長保証の資料はまとめて」)はadd_classification_ruleで保存する。ルールは次の分類まで反映されないので、目の前の1件を動かしてほしい依頼にルールだけで応えてはいけない(両方の意図があるなら両方呼ぶ)
- 「〇〇というフォルダを作って」「マニュアルを再分類して」のような依頼は、マニュアルの内容に関する質問ではなく、この検索システム自体への操作依頼。マニュアル抜粋に根拠を求めず、絞り込み質問もせず、ためらわずに対応するツールを呼び出す
- 対象のマニュアル名やフォルダ名が曖昧でも、聞き返さずにmove_manualを呼ぶ。当てはまるものが複数あったり見つからない場合は、システムが候補を出して確認するので、あなたが候補を推測して並べる必要はない
- あなたの応答は1回で完結する。ツールの実行結果を見てから次のツールを呼ぶことはできない。複数の操作が必要な依頼(例:「フォルダを作って再分類して」)では、必要なツールをすべて同じ応答の中でまとめて呼ぶ
- 会話履歴にある「📏 分類ルールを追加しました」「📁 フォルダを作成しました」等の実行結果はシステムが書いたもの。あなたがそれを真似て書いてはいけない。どの操作も、対応するツールをその応答で呼ばない限り実行されない
- 「再分類して」と依頼されたら、分類の方針を聞き返さずにすぐreclassify_all_manualsを呼ぶ(方針が依頼文に書かれていた場合だけinstructionに渡す。実行前の確認はシステムが行う)
- 本文で「再分類します」と宣言するだけでは何も実行されない。再分類する意図があるなら、必ずreclassify_all_manualsを同じ応答で呼ぶ(再分類はフォルダが足りなければ自動で作るので、フォルダ作成を先に済ませる必要はない)
- フォルダ名が指定されていれば、その名前のままcreate_folderを呼ぶ(勝手に変えない)
- マニュアルの内容を知りたい通常の質問には、これまで通り抜粋から回答する(ツールは使わない)。例えば「Boxへの資料保管ルール」「共有フォルダの命名規則」のような、業務でのフォルダ運用についての質問は、この検索システムのフォルダ操作ではないのでツールを使わずに抜粋から答える
- ツールを使うときは、何をするのかを本文で一言だけ添える(結果の報告はシステムが行うので不要)
- 管理操作の応答では[選択肢]や[参照]の行は書かない"""

# 一般ユーザー(MEMBER)のときに足す補足。
# 管理者専用の操作を頼まれたときに、マニュアル検索で代用しようとして
# 話が噛み合わなくなるのを防ぐ
MEMBER_SYSTEM_ADDENDUM = """

補足(権限について): この検索システムには管理者だけが行える操作があります。
具体的には、フォルダ(カテゴリ)の作成・名前変更・削除・並び替え、マニュアルの分類や全体の再分類、マニュアルの追加・削除、利用者の管理です。

- 相手がこれらの操作を「してほしい」と依頼している場合は、マニュアルを検索して似た情報で代用しようとせず、その操作は管理者のみが行えることを伝え、管理者へ依頼するよう案内する。この場合は[参照]なしとする
- ただし、マニュアルに書かれている業務上のやり方についての質問は、これまで通り抜粋から回答する。例えば「Boxへの資料保管ルール」「共有フォルダの命名規則」「書類の格納先」などは業務の質問であり、この検索システムの操作ではない
- 見分け方: この検索システムの画面を操作してほしいのか、業務のやり方を知りたいのか。「(この)アプリで」「ここで」「マニュアル検索の」といった言い方や、画面に見えているフォルダを指している場合は前者
- どちらか判断できないときは、勝手にどちらかに決めず、どちらの意味かを確かめる質問を1つだけ返す"""


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
        is_admin: bool = False,
    ) -> tuple[str, list[dict]]: ...

    def rewrite_query(self, question: str, history: list[HistoryMessage]) -> str: ...

    def classify_manuals(
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
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
        is_admin: bool = False,
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
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
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
        is_admin: bool = False,
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

        system_prompt = SYSTEM_PROMPT + (
            ADMIN_SYSTEM_ADDENDUM if is_admin else MEMBER_SYSTEM_ADDENDUM
        )
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
        self,
        manuals: list[dict],
        categories: list[str],
        allow_new: bool = True,
        instruction: str | None = None,
        rules: list[str] | None = None,
    ) -> list[dict]:
        """マニュアル一覧をカテゴリに割り当てる(全体を1回のリクエストで見せて
        一貫性のある分類にする)。戻り値: [{"manual_id":…, "category":…}]

        allow_new=False のときは既存カテゴリだけに割り当てる。
        instruction は管理者が指定した分類方針(例:「工種ごとに」)。
        rules は管理者が蓄積した分類ルール(最優先で適用する)。
        """
        lines = "\n".join(
            f"- id={m['manual_id']} タイトル: {m['title']}\n  冒頭: {m['snippet'][:100]}"
            for m in manuals
        )
        existing = "、".join(categories) if categories else "(まだ無い)"
        if allow_new:
            # 「大雑把すぎる分類」を防ぐため、軸(工種・業務分野)と粒度の目安を明示する
            category_rules = (
                "- 工種・業務分野ごとにカテゴリを分ける"
                "(例: 漏水・水回り、床・フローリング、窓・ガラス、屋根・外壁、"
                "定期点検、顛末書・決裁書類、電話・お客様対応、社内システム・入力ルール など。"
                "例はあくまで参考にし、実際のマニュアルの内容に合わせて命名する)\n"
                "- 既存カテゴリに合うものがあればそれを使い、無ければ新しいカテゴリ名を作る\n"
                "- 新しいカテゴリ名は誰にでも分かる簡潔な日本語(2〜10文字程度)にする\n"
                "- 粒度の目安: 1カテゴリに5〜15件程度。全体を2〜3個の大きなカテゴリに"
                "まとめてしまう大雑把な分け方はしない(逆に1件だけのカテゴリを乱発しない)\n"
            )
        else:
            category_rules = (
                "- 必ず「既存カテゴリ」のいずれかをそのままの名前で割り当てる。"
                "新しいカテゴリ名を作ってはいけない\n"
            )
        instruction_text = (
            f"\n管理者が指定した分類方針(最優先で従う): {instruction}\n" if instruction else ""
        )
        rules_text = (
            "\n管理者が定めた分類ルール(どの判断よりも優先して必ず守る):\n"
            + "\n".join(f"- {r}" for r in rules)
            + "\n"
            if rules
            else ""
        )
        prompt = (
            "あなたは社内マニュアルの整理係です。以下のマニュアル一覧を内容ごとにカテゴリ分けしてください。\n\n"
            "ルール:\n"
            f"{category_rules}"
            '- JSON配列のみを出力する: [{"manual_id": "...", "category": "カテゴリ名"}, ...]\n'
            f"{rules_text}{instruction_text}\n"
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
