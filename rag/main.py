import base64
import logging
import os
import re
import unicodedata
import urllib.request
from io import BytesIO

import psycopg
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from pydantic import UUID4, BaseModel
from pypdf import PdfReader

from chunking import split_text
from security import fetch_pdf, require_api_token
from embedding import create_embedder, to_vector_literal
from llm import ADMIN_TOOLS, Context, create_answer_generator
from vision import MAX_TRANSCRIBE_PAGES, create_transcriber, render_page_jpeg

load_dotenv()  # rag/.env を読み込む

DATABASE_URL = os.environ["DATABASE_URL"]

# RDSのTLS証明書を検証するためのCAの場所(本番のみ設定される)。
# psycopgの sslmode=require は「暗号化するが相手が本物か確認しない」なので、
# CAがあるときは verify-full にして中間者攻撃を検知できる状態にする。
_DB_SSL_CA = os.environ.get("DATABASE_SSL_CA")
_DB_SSL_ARGS = (
    {"sslmode": "verify-full", "sslrootcert": _DB_SSL_CA} if _DB_SSL_CA else {}
)


def db_connect():
    """DBに接続する。本番ではTLS証明書の検証付き。"""
    return psycopg.connect(DATABASE_URL, **_DB_SSL_ARGS)


logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Manual Search RAG Service")
embedder = create_embedder()
answer_generator = create_answer_generator()
transcriber = create_transcriber()

# これ未満の文字数しか取れないページは「実質画像のページ」とみなし書き起こしに回す
MIN_TEXT_CHARS_PER_PAGE = 20


ALLOWED_IMAGE_FORMATS = {"png", "jpeg", "webp", "gif"}


class HistoryMessage(BaseModel):
    role: str  # 'user' | 'assistant'
    content: str


class SearchRequest(BaseModel):
    question: str
    image_base64: str | None = None  # 質問に添付された画像(任意)
    image_format: str | None = None  # png / jpeg / webp / gif
    history: list[HistoryMessage] = []  # 同じ会話のこれまでのやりとり(絞り込み対話用)
    is_admin: bool = False  # trueなら管理ツール(フォルダ作成・再分類)をClaudeに渡す


class Citation(BaseModel):
    """回答の根拠となったマニュアルの断片"""

    manual_id: str
    title: str
    snippet: str
    page: int | None = None  # 元PDFの何ページ目か


class ActionRequest(BaseModel):
    """Claudeが要求した管理操作。実行するのはNestJS側"""

    name: str
    input: dict = {}


class SearchResponse(BaseModel):
    answer: str
    citations: list[Citation]
    options: list[str] = []  # 絞り込み質問の選択肢(ボタン表示用)
    actions: list[ActionRequest] = []  # 管理ツールの呼び出し要求(管理者のみ)


OPTION_PATTERN = re.compile(r"^\[選択肢\]\s*(.+)$", re.MULTILINE)
REFERENCE_PATTERN = re.compile(r"^\[参照\]\s*(.*)$", re.MULTILINE)


def extract_references(answer: str, total: int) -> tuple[str, list[int] | None]:
    """回答文から[参照]行を抜き出し、(本文, 使った抜粋のindexリスト)に分ける。

    戻りのリストがNone = 申告なし(保険の動作へ)、[] = 「[参照] なし」(引用ゼロ)。
    """
    m = REFERENCE_PATTERN.search(answer)
    if not m:
        return answer, None
    cleaned = REFERENCE_PATTERN.sub("", answer).strip()
    numbers = [int(n) for n in re.findall(r"\d+", m.group(1))]
    used = [n - 1 for n in numbers if 1 <= n <= total]
    return cleaned, used

TOP_K = 8  # Claudeに渡す抜粋の数


def hybrid_search(cur, query_vec: str, terms: list[str]):
    """ベクトル・キーワード・タイトルの3ルートをRRF(Reciprocal Rank Fusion)で融合する。

    取り込みが完了していないマニュアル(差し替え直後・失敗)は検索対象から除く。
    そうしないと「新しいPDFに差し替わったのに旧版の内容で回答する」状態になる。

    ベクトル検索は「意味の近さ」に強いが、電話番号・型番・固有名詞のような
    「文字通りの一致」に弱い。キーワード検索はその逆。タイトル検索は、
    本文に手がかりが無く文書名だけが頼りのマニュアル(記入見本など)を拾う。
    各ルートの順位を score = Σ 1/(60+順位) で足し合わせ、得意分野を活かす。
    """
    # ルート1: ベクトル検索(意味の近さ)
    #
    # 最近傍検索はManualChunk単体で完結させ、タイトルの取得(JOIN)は後段で行う。
    # JOINを含めたままORDER BY embeddingを書くと、Postgresが
    # 「JOINしてからソート」の計画を選びHNSWインデックスが使われなくなる。
    # AS MATERIALIZED でCTEのインライン展開も防ぎ、確実に索引を使わせる。
    # 内側は多めに取り、取り込み未完了ぶんを除いた後にTOPまで絞る
    cur.execute(
        """
        WITH nearest AS MATERIALIZED (
            SELECT id, manual_id, content, page_number,
                   embedding <=> %s::vector AS distance
            FROM "ManualChunk"
            WHERE embedding IS NOT NULL
            ORDER BY distance
            LIMIT 40
        )
        SELECT n.id, n.manual_id, m.title, n.content, n.page_number
        FROM nearest n
        JOIN "Manual" m ON m.id = n.manual_id
        WHERE m.ingest_status = 'COMPLETED'
        -- JOINを挟むと内側のORDER BYは保たれないので、距離で明示的に並べ直す。
        -- これを忘れるとRRFに渡る順位が崩れ、検索精度が静かに落ちる
        ORDER BY n.distance
        LIMIT 20
        """,
        (query_vec,),
    )
    vector_rows = cur.fetchall()

    # ルート2: キーワード一致(マッチしたキーワード数が多い順)
    #
    # ILIKEの条件をWHEREにも書くのが重要。SELECT句でhitsを数えるだけだと
    # 全チャンクを評価することになり、pg_trgmのインデックスが使われない
    keyword_rows = []
    title_rows = []
    if terms:
        patterns = [f"%{t}%" for t in terms]

        hit_expr = " + ".join(
            ["(CASE WHEN mc.content ILIKE %s THEN 1 ELSE 0 END)"] * len(terms)
        )
        any_match = " OR ".join(["mc.content ILIKE %s"] * len(terms))
        cur.execute(
            f"""
            SELECT mc.id, mc.manual_id, m.title, mc.content, mc.page_number,
                   ({hit_expr}) AS hits
            FROM "ManualChunk" mc
            JOIN "Manual" m ON m.id = mc.manual_id
            WHERE m.ingest_status = 'COMPLETED'
              AND ({any_match})
            ORDER BY hits DESC
            LIMIT 20
            """,
            patterns + patterns,  # hit_expr用 と WHERE用
        )
        keyword_rows = [r for r in cur.fetchall() if r[5] > 0]

        # ルート3: タイトル一致(文書名そのものを探す質問に効く)
        #
        # ルート1・2は本文しか見ないため、本文に手がかりが無いマニュアル
        # (例: 記入見本のスキャンPDF)はタイトルでしか見つけられない。
        #
        # DISTINCT ON でマニュアルごとに先頭チャンク1件だけを代表にするのが重要。
        # 全チャンクを返すと、タイトルが一致したマニュアル1本が
        # キーワード順位の上位を占拠し、他のマニュアルを押し出してしまう
        title_hit_expr = " + ".join(
            ["(CASE WHEN m.title ILIKE %s THEN 1 ELSE 0 END)"] * len(terms)
        )
        title_any_match = " OR ".join(["m.title ILIKE %s"] * len(terms))
        cur.execute(
            f"""
            SELECT * FROM (
                SELECT DISTINCT ON (m.id)
                       mc.id, mc.manual_id, m.title, mc.content, mc.page_number,
                       ({title_hit_expr}) AS hits
                FROM "ManualChunk" mc
                JOIN "Manual" m ON m.id = mc.manual_id
                WHERE m.ingest_status = 'COMPLETED'
                  AND ({title_any_match})
                ORDER BY m.id, mc.chunk_index
            ) t
            ORDER BY hits DESC
            LIMIT 20
            """,
            patterns + patterns,  # title_hit_expr用 と WHERE用
        )
        title_rows = cur.fetchall()

    # RRFで融合(同じチャンクが複数ルートに出たら得点が加算される)
    scores: dict[str, float] = {}
    meta: dict[str, tuple] = {}
    for rank, row in enumerate(vector_rows, start=1):
        scores[row[0]] = scores.get(row[0], 0.0) + 1.0 / (60 + rank)
        meta[row[0]] = row[1:5]
    for rank, row in enumerate(keyword_rows, start=1):
        scores[row[0]] = scores.get(row[0], 0.0) + 1.0 / (60 + rank)
        meta.setdefault(row[0], row[1:5])
    for rank, row in enumerate(title_rows, start=1):
        scores[row[0]] = scores.get(row[0], 0.0) + 1.0 / (60 + rank)
        meta.setdefault(row[0], row[1:5])

    ranked = sorted(scores, key=lambda cid: scores[cid], reverse=True)[:TOP_K]
    return [meta[cid] for cid in ranked]  # (manual_id, title, content, page_number)


def extract_options(answer: str) -> tuple[str, list[str]]:
    """回答文から[選択肢]行を抜き出し、(本文, 選択肢リスト)に分ける"""
    options = [m.strip() for m in OPTION_PATTERN.findall(answer)]
    cleaned = OPTION_PATTERN.sub("", answer).strip()
    if not options:
        # 保険: モデルが形式を守らず「選択肢: 1. A / 2. B」のように書いた場合も救済する
        cleaned, options = _fallback_extract_options(cleaned)
    return cleaned, options


def _fallback_extract_options(answer: str) -> tuple[str, list[str]]:
    """文末付近の「選択肢: 1. A / 2. B / 3. C」パターンを解析してボタン化する保険"""
    idx = answer.rfind("選択肢")
    # 文末付近(400字以内)に無ければ、本文中の言及とみなして触らない
    if idx == -1 or len(answer) - idx > 400:
        return answer, []
    m = re.match(r"選択肢[：:]\s*(.+)\s*$", answer[idx:], re.DOTALL)
    if not m:
        return answer, []
    options = []
    for item in re.split(r"[/／\n]", m.group(1)):
        item = re.sub(r"^\s*\d+[.)]\s*", "", item).strip(" 　・*-")
        if 2 <= len(item) <= 50:
            options.append(item)
    if not (2 <= len(options) <= 5):
        return answer, []
    cleaned = answer[:idx].rstrip()
    # 直前に残った「次に知りたくなりそうなこと：」等の見出しを掃除
    # (コロンが**の内側/外側どちらにあっても消せるように)
    cleaned = re.sub(
        r"(?:\*\*)?次に知りたくなりそうなこと[：:]?(?:\*\*)?[：:]?\s*$", "", cleaned
    ).rstrip()
    return cleaned.strip(), options


class IngestRequest(BaseModel):
    manual_id: UUID4
    download_url: str  # NestJSが発行した署名付きURL


class IngestResponse(BaseModel):
    manual_id: str
    page_count: int
    chunk_count: int
    transcribed_page_count: int = 0  # Claudeの画像認識で書き起こしたページ数
    # PDF自体が持つ作成日(ISO8601)。一覧の「作成日」列に使う。
    # 入っていないPDFもあるのでnullを許容する
    pdf_created_at: str | None = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ingest", response_model=IngestResponse, dependencies=[Depends(require_api_token)])
def ingest(req: IngestRequest) -> IngestResponse:
    """PDFを取り込み、テキスト抽出→チャンク分割→DB保存する。

    embeddingはこの段階ではNULLのまま(次ステップでBedrockを使って埋める)。
    """
    # 1) 署名付きURLからPDFをダウンロード。
    #    スキーム/ホスト/解決先IPを検証し、サイズ上限とタイムアウトも掛ける
    #    (file://やメタデータエンドポイントを読ませられるのを防ぐ)
    pdf_bytes = fetch_pdf(req.download_url)

    # 2) ページごとにテキスト抽出
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except Exception as e:
        logger.warning("PDFの解析に失敗 manual=%s: %s", req.manual_id, e)
        raise HTTPException(status_code=422, detail="PDFを解析できませんでした")

    # 2.2) PDF自体が持つ作成日を読む(一覧の「作成日」列に使う)。
    #      日付が壊れているPDFもあるので、取れなければ諦めて取り込みは続ける
    pdf_created_at: str | None = None
    try:
        created = reader.metadata.creation_date if reader.metadata else None
        if created:
            pdf_created_at = created.isoformat()
    except Exception:
        pass

    # 2.5) テキストがほぼ取れないページ(スキャン・画像ページ)は
    #      Claudeの画像認識で書き起こす(上限ページ数まで)
    transcribed_count = 0
    if transcriber.enabled:
        for i, text in enumerate(pages):
            if len(text) >= MIN_TEXT_CHARS_PER_PAGE:
                continue
            if transcribed_count >= MAX_TRANSCRIBE_PAGES:
                break  # コストの安全弁。超過分は素通し(空ページ扱い)
            try:
                image = render_page_jpeg(pdf_bytes, i)
                pages[i] = transcriber.transcribe(image)
                transcribed_count += 1
            except Exception:
                # 1ページの失敗で取り込み全体を止めない(そのページだけ諦める)
                continue

    # 2.7) 表記をNFCに正規化する。PDFの内部表現によってはNFDで抽出されることが
    #      あり、そのまま保存すると検索キーワード(NFC)のILIKEに当たらなくなる
    pages = [unicodedata.normalize("NFC", text) for text in pages]

    # 3) ページごとにチャンク化する(どのページ由来かを記録し、引用をページ単位にするため)
    chunks: list[tuple[str, int]] = []  # (本文, ページ番号)
    for page_no, text in enumerate(pages, start=1):
        for piece in split_text(text):
            chunks.append((piece, page_no))

    # 4) 各チャンクを「タイトル\n本文」の形でベクトル化する。
    #    本文に手がかりが無いチャンク(記入見本・表紙など)にも
    #    「どの文書の断片か」という文脈が意味検索に効くようにするため。
    #    DBに保存するcontentは本文のまま。タイトルを含めて保存すると、
    #    引用スニペットにタイトルが重複表示され、さらに全チャンクが
    #    タイトル語のILIKEにヒットしてキーワード検索が洪水を起こす
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT title FROM "Manual" WHERE id = %s',
                (str(req.manual_id),),
            )
            row = cur.fetchone()
    # タイトルもNFCに揃えてから埋め込みに使う(移行前のNFDデータへの保険)
    title = unicodedata.normalize("NFC", row[0]) if row else ""
    embeddings = embedder.embed_texts(
        [f"{title}\n{content}" if title else content for content, _page in chunks]
    )

    # 5) チャンクをDBへ保存(再取り込みに備え、同じマニュアルの既存チャンクは入れ替え)
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM "ManualChunk" WHERE manual_id = %s',
                (str(req.manual_id),),
            )
            for i, ((content, page_no), emb) in enumerate(zip(chunks, embeddings)):
                cur.execute(
                    'INSERT INTO "ManualChunk" (id, manual_id, chunk_index, page_number, content, embedding) '
                    "VALUES (gen_random_uuid(), %s, %s, %s, %s, %s::vector)",
                    (str(req.manual_id), i, page_no, content, to_vector_literal(emb)),
                )

    return IngestResponse(
        manual_id=str(req.manual_id),
        page_count=len(pages),
        chunk_count=len(chunks),
        transcribed_page_count=transcribed_count,
        pdf_created_at=pdf_created_at,
    )


class OrganizeItem(BaseModel):
    manual_id: str
    title: str
    snippet: str


class OrganizeRequest(BaseModel):
    manuals: list[OrganizeItem]
    categories: list[str]  # 既存カテゴリ名
    # falseなら既存カテゴリだけに割り当てる(勝手に増やしたくない場合)
    allow_new: bool = True
    # 管理者が指定した分類方針(例:「工種ごとに」)。チャット経由の再分類で使う
    instruction: str | None = None
    # 管理者が蓄積した分類ルール(最優先で適用)
    rules: list[str] = []


class OrganizeAssignment(BaseModel):
    manual_id: str
    category: str


class OrganizeResponse(BaseModel):
    assignments: list[OrganizeAssignment]


@app.post("/organize", response_model=OrganizeResponse, dependencies=[Depends(require_api_token)])
def organize(req: OrganizeRequest) -> OrganizeResponse:
    """マニュアル一覧をAIでカテゴリ分けする(DBへの書き込みは行わない=判断だけ返す)"""
    if not req.manuals:
        return OrganizeResponse(assignments=[])
    try:
        raw = answer_generator.classify_manuals(
            [m.model_dump() for m in req.manuals],
            req.categories,
            allow_new=req.allow_new,
            instruction=req.instruction,
            rules=req.rules,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"分類に失敗しました: {e}")

    valid_ids = {m.manual_id for m in req.manuals}
    assignments = [
        OrganizeAssignment(manual_id=a["manual_id"], category=str(a["category"]).strip())
        for a in raw
        if a.get("manual_id") in valid_ids and str(a.get("category", "")).strip()
    ]
    return OrganizeResponse(assignments=assignments)


@app.post("/search", response_model=SearchResponse, dependencies=[Depends(require_api_token)])
def search(req: SearchRequest) -> SearchResponse:
    """質問(+添付画像)に近いチャンクをベクトル検索し、Claudeが回答を生成する。

    <=> はpgvectorのコサイン距離演算子。小さいほど「近い(似ている)」。
    """
    # 0) 質問を「同義語込みの検索キーワード列」に展開する(クエリ拡張)。
    #    質問者とマニュアルの語彙のずれを吸収し、会話の続き(「2です」等)は文脈も織り込む
    retrieval_query = req.question
    try:
        retrieval_query = answer_generator.rewrite_query(req.question, req.history)
    except Exception:
        pass  # 展開に失敗しても元の質問文で検索は続行する

    # 0.5) 添付画像があればデコードし、検索に使える説明文をClaudeに作らせる。
    #    「この画面どうすれば？」のような質問文だけでは検索できないため
    image: tuple[bytes, str] | None = None
    if req.image_base64:
        image_format = (req.image_format or "jpeg").lower()
        if image_format not in ALLOWED_IMAGE_FORMATS:
            raise HTTPException(status_code=400, detail=f"未対応の画像形式です: {image_format}")
        try:
            image_bytes = base64.b64decode(req.image_base64)
        except Exception:
            raise HTTPException(status_code=400, detail="画像データを読み取れません")
        image = (image_bytes, image_format)
        description = transcriber.describe(image_bytes, image_format)
        if description:
            retrieval_query = f"{retrieval_query}\n{description}"

    # 0.7) 表記ゆれをNFCに揃える。macOS由来のNFD(濁点・半濁点が結合文字)が
    #      混ざると、DB側(NFCで保存)との部分一致・ベクトル化が微妙にずれる
    retrieval_query = unicodedata.normalize("NFC", retrieval_query)

    # 1) 質問文(+画像の説明)を、チャンクと同じ方法でベクトル化
    query_vec = to_vector_literal(embedder.embed_texts([retrieval_query])[0])

    # 2) ハイブリッド検索: ベクトル(意味) + キーワード一致(数字や固有名詞に強い)
    terms = [t for t in re.split(r"\s+", retrieval_query) if len(t) >= 2][:10]
    with db_connect() as conn:
        with conn.cursor() as cur:
            rows = hybrid_search(cur, query_vec, terms)

    # 検索ヒットゼロでも、管理者のときは生成まで進める。
    # 管理操作(フォルダ作成など)はマニュアルが1件も無い状態でも成立する必要がある
    if not rows and not req.is_admin:
        return SearchResponse(
            answer="まだ検索できるマニュアルがありません。マニュアルをアップロードして取り込んでください。",
            citations=[],
        )

    # 3) 取得した抜粋を根拠として、Claudeに回答文を書かせる。
    #    抜粋の見出しにページ番号を含めるので、回答文でも「(p.3)」のように言及できる。
    #    生成に失敗しても検索結果(引用)だけは返す(全滅させない)
    contexts = [
        Context(
            title=f"{title}(p.{page})" if page else title,
            content=content,
        )
        for _manual_id, title, content, page in rows
    ]
    options: list[str] = []
    actions: list[ActionRequest] = []
    used_rows = rows[:3]  # 保険の既定値: 参照の申告が無ければ上位3件だけ引用に出す
    try:
        raw_answer, raw_actions = answer_generator.generate(
            req.question,
            contexts,
            image=image,
            history=req.history,
            # 管理者にだけフォルダ作成・再分類のツールを渡す(実行はNestJS側)
            tools=ADMIN_TOOLS if req.is_admin else None,
        )
        actions = [ActionRequest(**a) for a in raw_actions]
        # 本文もツール呼び出しも無い応答は失敗として扱う(空の吹き出しを出さない)
        if not raw_answer.strip() and not actions:
            raise ValueError("モデルが本文を返しませんでした")
        # 絞り込み質問の場合、[選択肢]行を本文から分離してボタン用データにする
        answer, options = extract_options(raw_answer)
        # [参照]行から「実際に根拠に使った抜粋」を特定し、引用をそこに絞る
        answer, used = extract_references(answer, len(rows))
        if used is not None:
            used_rows = [rows[i] for i in used]
        # 管理操作の要求時は、検索抜粋はほぼ無関係なので引用を出さない
        if actions:
            used_rows = []
    except Exception as e:
        answer = (
            "関連しそうなマニュアルが見つかりましたが、"
            f"回答文の生成に失敗しました({e})。以下の抜粋をご確認ください。"
        )
        # 「失敗した」と伝えた応答から管理操作が実行されるのを防ぐ
        actions = []
        options = []

    # 引用は「実際に使われた抜粋」だけを、同じマニュアルの同じページでまとめて返す
    citations: list[Citation] = []
    seen: set[tuple[str, int | None]] = set()
    for manual_id, title, content, page in used_rows:
        if (manual_id, page) in seen:
            continue
        seen.add((manual_id, page))
        citations.append(
            Citation(manual_id=manual_id, title=title, snippet=content[:150], page=page)
        )

    return SearchResponse(
        answer=answer, citations=citations, options=options, actions=actions
    )
