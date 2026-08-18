"""検索結果の融合(RRF)と、質問に添えた画像の受け渡しのテスト。

ここは壊れても例外が出ず、静かに精度だけが落ちる場所なので、
振る舞いを固定しておく。
- RRFの並びが崩れると、関係の薄い抜粋を根拠に回答するようになる
- 画像の受け渡しが切れると、画面を見せた質問に「分かりません」と答える
"""

import os
import sys
from pathlib import Path

# rag/ をimportパスに入れる(テストはrag/tests配下に置く)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://dummy/dummy")

from fastapi import HTTPException  # noqa: E402

from llm import BedrockAnswerGenerator, Context  # noqa: E402
from main import (  # noqa: E402
    MAX_QUESTION_IMAGES,
    QuestionImage,
    SearchRequest,
    decide_outcome,
    decode_images,
    fuse_by_rrf,
)


def row(chunk_id: str, title: str = "手順書") -> tuple:
    """(chunk_id, manual_id, title, content, page) の形を作る"""
    return (chunk_id, f"m-{chunk_id}", title, f"{chunk_id}の本文", 1)


class TestFuseByRrf:
    def test_複数のルートに出たものが上に来る(self):
        # bはベクトルで2位・キーワードで1位。aはベクトル1位のみ
        vector = [row("a"), row("b")]
        keyword = [row("b")]
        ranked = fuse_by_rrf([vector, keyword, []])
        # a = 1/61 ≒ 0.0164、b = 1/62 + 1/61 ≒ 0.0325
        assert [r[0] for r in ranked] == ["m-b", "m-a"]

    def test_1つのルートだけなら順位はそのまま(self):
        ranked = fuse_by_rrf([[row("a"), row("b"), row("c")], [], []])
        assert [r[0] for r in ranked] == ["m-a", "m-b", "m-c"]

    def test_件数はTOP_Kで打ち切られる(self):
        from main import TOP_K

        many = [row(str(i)) for i in range(TOP_K + 5)]
        assert len(fuse_by_rrf([many, [], []])) == TOP_K

    def test_同じチャンクの内容は重複して出ない(self):
        ranked = fuse_by_rrf([[row("a")], [row("a")], [row("a")]])
        assert len(ranked) == 1

    def test_全ルートが空なら空(self):
        assert fuse_by_rrf([[], [], []]) == []

    def test_3ルートすべてに出たものが最も強い(self):
        # aは3ルートすべての3位、bは1ルートの1位
        a = [row("x"), row("y"), row("a")]
        ranked = fuse_by_rrf([a, a, a + [row("b")]])
        assert ranked[0][0] == "m-x"  # 3ルートの1位が最上位
        # aは3回足されるので、1ルートにしか出ないbより上
        order = [r[0] for r in ranked]
        assert order.index("m-a") < order.index("m-b")


class TestDecodeImages:
    def png(self) -> str:
        import base64

        return base64.b64encode(b"\x89PNG").decode()

    def test_複数枚を順番どおりに取り出す(self):
        req = SearchRequest(
            question="q",
            images=[
                QuestionImage(base64=self.png(), format="PNG"),
                QuestionImage(base64=self.png(), format="jpeg"),
            ],
        )
        assert [fmt for _, fmt in decode_images(req)] == ["png", "jpeg"]

    def test_1枚だけ渡す古い呼び方も動く(self):
        req = SearchRequest(question="q", image_base64=self.png(), image_format="webp")
        assert decode_images(req) == [(b"\x89PNG", "webp")]

    def test_上限を超えたら断る(self):
        req = SearchRequest(
            question="q",
            images=[QuestionImage(base64=self.png(), format="png")]
            * (MAX_QUESTION_IMAGES + 1),
        )
        try:
            decode_images(req)
            raise AssertionError("上限を超えたのに通ってしまった")
        except HTTPException as e:
            assert e.status_code == 400

    def test_対応していない形式は断る(self):
        req = SearchRequest(
            question="q", images=[QuestionImage(base64=self.png(), format="bmp")]
        )
        try:
            decode_images(req)
            raise AssertionError("未対応の形式が通ってしまった")
        except HTTPException as e:
            assert "未対応" in e.detail

    def test_添付なしは空(self):
        assert decode_images(SearchRequest(question="q")) == []


class TestBuildMessages:
    """画像がClaudeへ渡るところ。ここが切れると画像を見ずに回答してしまう"""

    def build(self, images):
        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        contexts = [Context(title="手順書", content="本文")]
        return gen._build_messages("質問です", contexts, images, None)[-1]["content"]

    def test_画像なしのときは本文だけ(self):
        content = self.build(None)
        assert len(content) == 1 and "添付されています" not in content[0]["text"]

    def test_1枚のときは枚数を言わない(self):
        content = self.build([(b"a", "png")])
        assert content[0]["image"]["format"] == "png"
        assert "上の画像が添付されています" in content[-1]["text"]

    def test_複数枚は全部渡り枚数も伝わる(self):
        content = self.build([(b"a", "png"), (b"b", "jpeg"), (b"c", "webp")])
        assert [c["image"]["format"] for c in content[:3]] == ["png", "jpeg", "webp"]
        assert "上の画像3枚が添付されています" in content[-1]["text"]

    def test_履歴があっても画像は最後の質問に付く(self):
        class Hist:
            def __init__(self, role, content):
                self.role, self.content = role, content

        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        messages = gen._build_messages(
            "質問", [Context(title="t", content="c")], [(b"a", "gif")], [Hist("user", "前の質問")]
        )
        assert len(messages) == 2
        assert "image" in messages[1]["content"][0]


class TestDecideOutcome:
    """「答えられたか」の判定。ここが崩れると利用状況の集計が信用できなくなる"""

    def test_抜粋を根拠に答えた(self):
        assert decide_outcome([], [0, 2], []) == ("answered", True)

    def test_根拠が無いと申告(self):
        assert decide_outcome([], [], []) == ("no_basis", False)

    def test_聞き返しは可否に数えない(self):
        assert decide_outcome([], None, ["A", "B"]) == ("clarify", None)
        assert decide_outcome([], [], ["A"]) == ("clarify", None)

    def test_管理操作は可否に数えない(self):
        assert decide_outcome(["create_folder"], None, []) == ("admin", None)

    def test_申告が無ければ判定漏れとして残す(self):
        assert decide_outcome([], None, []) == ("unreported", None)


class TestHideAdminOnly:
    """鍵付き(管理者だけに見せる)フォルダを、検索の3ルートすべてから外せているか。

    ここが抜けると、一覧に出していないマニュアルの中身がAIの回答として出る。
    管理者の質問でも外す(鍵付きは業務の回答に使わない資料を入れる場所で、
    根拠の枠を奪うと本来出るべきマニュアルが押し出されるため)。
    実際にSQLを組み立てて、条件が入っているかを見る。
    """

    class FakeCursor:
        """SQLを受け取って覚えておくだけの偽物(DBには繋がない)"""

        def __init__(self):
            self.queries: list[str] = []

        def execute(self, sql, params=None):
            self.queries.append(sql)

        def fetchall(self):
            return []

    def run(self) -> list[str]:
        from main import hybrid_search

        cur = self.FakeCursor()
        hybrid_search(cur, "[0,0]", ["水栓", "漏水"])
        return cur.queries

    def test_3ルートすべてに除外条件が入る(self):
        queries = self.run()
        assert len(queries) == 3, "ベクトル・キーワード・タイトルの3本が動くこと"
        for sql in queries:
            assert "admin_only" in sql

    def test_権限で除外条件を切り替える引数は残っていない(self):
        # 引数で切り替えられると「管理者だから含める」呼び出しが将来復活し、
        # 鍵付きの資料が回答の根拠に混ざる。引数を持たないことで塞ぐ
        import inspect

        from main import hybrid_search

        params = list(inspect.signature(hybrid_search).parameters)
        assert params == ["cur", "query_vec", "terms"]

    def test_検索を呼ぶ側も権限を渡していない(self):
        # retrieve()と下書き生成の両方が、引数なしで呼んでいること
        import re

        source = (Path(__file__).resolve().parents[1] / "main.py").read_text(
            encoding="utf-8"
        )
        # 定義そのもの(def hybrid_search(...))は除いて、呼び出しだけを見る
        calls = re.findall(r"(?<!def )hybrid_search\(cur[^)]*\)", source)
        assert calls, "呼び出しが見つからない(名前を変えたらこのテストも直す)"
        for call in calls:
            assert call == "hybrid_search(cur, query_vec, terms)", call

    def test_除外条件は未分類を巻き込まない(self):
        # NOT EXISTS(...)なので、categoryIdがnullの行は残る
        sql = self.run()[0]
        assert "NOT EXISTS" in sql and '"ManualCategory"' in sql

    def test_取り込み済み・ゴミ箱以外という条件は残っている(self):
        for sql in self.run():
            assert "ingest_status = 'COMPLETED'" in sql
            assert "deleted_at IS NULL" in sql


class TestAdminTools:
    """チャットからの管理操作。フォルダを鍵付きで作れること"""

    def tool(self, name: str) -> dict:
        from llm import ADMIN_TOOLS

        for t in ADMIN_TOOLS:
            if t["toolSpec"]["name"] == name:
                return t["toolSpec"]
        raise AssertionError(f"{name} が見つかりません")

    def test_フォルダ作成に鍵付きの指定がある(self):
        props = self.tool("create_folder")["inputSchema"]["json"]["properties"]
        assert "admin_only" in props
        assert props["admin_only"]["type"] == "boolean"

    def test_鍵付きは必須ではない(self):
        # 指定が無ければ全員に見えるフォルダになる(既定は開いている側ではなく
        # 「これまで通り」。隠す意図があるときだけ明示させる)
        required = self.tool("create_folder")["inputSchema"]["json"]["required"]
        assert required == ["name"]

    def test_言い回しの手がかりが説明に入っている(self):
        desc = self.tool("create_folder")["inputSchema"]["json"]["properties"][
            "admin_only"
        ]["description"]
        for word in ["鍵付き", "管理者だけ"]:
            assert word in desc

    def test_システムプロンプトが他の保管場所と取り違えないよう釘を刺している(self):
        from llm import ADMIN_SYSTEM_ADDENDUM

        assert "admin_only" in ADMIN_SYSTEM_ADDENDUM
        assert "鍵付き" in ADMIN_SYSTEM_ADDENDUM


class TestFolderTools:
    """フォルダの変更・削除。作り直しや「機能が無い」で断られないこと"""

    def tool(self, name: str) -> dict:
        from llm import ADMIN_TOOLS

        for t in ADMIN_TOOLS:
            if t["toolSpec"]["name"] == name:
                return t["toolSpec"]
        raise AssertionError(f"{name} が見つかりません")

    def test_変更のツールは対象だけが必須(self):
        # 名前だけ・鍵だけ・両方、のどれでも呼べるようにする。
        # new_nameを必須にすると「鍵付きにして」だけの依頼で呼べなくなる
        schema = self.tool("update_folder")["inputSchema"]["json"]
        assert schema["required"] == ["folder"]
        props = schema["properties"]
        assert "new_name" in props and props["admin_only"]["type"] == "boolean"

    def test_削除のツールがある(self):
        schema = self.tool("delete_folder")["inputSchema"]["json"]
        assert schema["required"] == ["folder"]

    def test_できないと答えないよう指示文で釘を刺している(self):
        from llm import ADMIN_SYSTEM_ADDENDUM

        assert "「その機能はありません」と答えてはいけない" in ADMIN_SYSTEM_ADDENDUM
        assert "create_folderで作り直してはいけない" in ADMIN_SYSTEM_ADDENDUM
        # 鍵付きへの変更と削除の呼び方も書いてある
        assert "update_folder" in ADMIN_SYSTEM_ADDENDUM
        assert "delete_folder" in ADMIN_SYSTEM_ADDENDUM


class TestDraftManual:
    """答えられなかった質問からの下書き。

    ここで一番怖いのは、分からないことをもっともらしく埋めてしまうこと。
    推測で書かれた手順がマニュアルになると「書いてあるから」と実行される。
    プロンプトがそれを禁じていることを固定しておく。
    """

    def prompt_of(self, question: str, contexts) -> str:
        """実際に組み立てられるプロンプトを、AWSを呼ばずに取り出す"""
        from llm import BedrockAnswerGenerator

        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        captured = {}

        class FakeClient:
            def converse(self, **kwargs):
                captured["prompt"] = kwargs["messages"][0]["content"][0]["text"]
                captured["config"] = kwargs["inferenceConfig"]
                return {"output": {"message": {"content": [{"text": "# 下書き"}]}}}

        gen.client = FakeClient()
        gen.model_id = "dummy"
        gen.draft_manual(question, contexts)
        return captured["prompt"]

    def test_質問と抜粋の両方が渡る(self):
        from llm import Context

        prompt = self.prompt_of(
            "トイレの漏水はどうする？", [Context(title="漏水対応", content="止水栓を閉める")]
        )
        assert "トイレの漏水はどうする？" in prompt
        assert "止水栓を閉める" in prompt and "漏水対応" in prompt

    def test_でっち上げを禁じている(self):
        prompt = self.prompt_of("q", [])
        assert "抜粋に無い手順・数値・連絡先・期限は絶対に書かない" in prompt
        assert "(要確認:" in prompt

    def test_関連資料が無くても組み立てられる(self):
        prompt = self.prompt_of("q", [])
        assert "関連する既存マニュアルは見つかりませんでした" in prompt

    def test_事実を作らせないよう温度は0(self):
        from llm import BedrockAnswerGenerator

        gen = BedrockAnswerGenerator.__new__(BedrockAnswerGenerator)
        captured = {}

        class FakeClient:
            def converse(self, **kwargs):
                captured.update(kwargs["inferenceConfig"])
                return {"output": {"message": {"content": [{"text": "x"}]}}}

        gen.client = FakeClient()
        gen.model_id = "dummy"
        gen.draft_manual("q", [])
        assert captured["temperature"] == 0

    def test_構成の指示が入っている(self):
        prompt = self.prompt_of("q", [])
        for section in ["目的", "対象となる場面", "手順", "注意点", "関連資料"]:
            assert section in prompt
