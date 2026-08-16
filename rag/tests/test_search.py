"""検索結果の融合(RRF)と、質問に添えた画像の受け渡しのテスト。

ここは壊れても例外が出ず、静かに精度だけが落ちる場所なので、
振る舞いを固定しておく。
- RRFの並びが崩れると、関係の薄い抜粋を根拠に回答するようになる
- 画像の受け渡しが切れると、画面を見せた質問に「分かりません」と答える
"""

import os
import sys

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
    """管理者だけに見せるフォルダを、検索の3ルートすべてから外せているか。

    ここが抜けると、一覧に出していないマニュアルの中身がAIの回答として出る。
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

    def run(self, is_admin: bool) -> list[str]:
        from main import hybrid_search

        cur = self.FakeCursor()
        hybrid_search(cur, "[0,0]", ["水栓", "漏水"], is_admin)
        return cur.queries

    def test_一般利用者には3ルートすべてに除外条件が入る(self):
        queries = self.run(is_admin=False)
        assert len(queries) == 3, "ベクトル・キーワード・タイトルの3本が動くこと"
        for sql in queries:
            assert "admin_only" in sql

    def test_管理者には除外条件が入らない(self):
        for sql in self.run(is_admin=True):
            assert "admin_only" not in sql

    def test_除外条件は未分類を巻き込まない(self):
        # NOT EXISTS(...)なので、categoryIdがnullの行は残る
        sql = self.run(is_admin=False)[0]
        assert "NOT EXISTS" in sql and '"ManualCategory"' in sql

    def test_取り込み済み・ゴミ箱以外という条件は残っている(self):
        for sql in self.run(is_admin=False):
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
