import base64
import os
import urllib.request
from io import BytesIO

import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pypdf import PdfReader

from chunking import split_text
from embedding import create_embedder, to_vector_literal
from llm import Context, create_answer_generator
from vision import MAX_TRANSCRIBE_PAGES, create_transcriber, render_page_jpeg

load_dotenv()  # rag/.env を読み込む

DATABASE_URL = os.environ["DATABASE_URL"]

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


class Citation(BaseModel):
    """回答の根拠となったマニュアルの断片"""

    manual_id: str
    title: str
    snippet: str
    page: int | None = None  # 元PDFの何ページ目か


class SearchResponse(BaseModel):
    answer: str
    citations: list[Citation]


class IngestRequest(BaseModel):
    manual_id: str
    download_url: str  # NestJSが発行した署名付きURL


class IngestResponse(BaseModel):
    manual_id: str
    page_count: int
    chunk_count: int
    transcribed_page_count: int = 0  # Claudeの画像認識で書き起こしたページ数


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ingest", response_model=IngestResponse)
def ingest(req: IngestRequest) -> IngestResponse:
    """PDFを取り込み、テキスト抽出→チャンク分割→DB保存する。

    embeddingはこの段階ではNULLのまま(次ステップでBedrockを使って埋める)。
    """
    # 1) 署名付きURLからPDFをダウンロード
    try:
        with urllib.request.urlopen(req.download_url) as res:
            pdf_bytes = res.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDFを取得できません: {e}")

    # 2) ページごとにテキスト抽出
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"PDFを解析できません: {e}")

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

    # 3) ページごとにチャンク化する(どのページ由来かを記録し、引用をページ単位にするため)
    chunks: list[tuple[str, int]] = []  # (本文, ページ番号)
    for page_no, text in enumerate(pages, start=1):
        for piece in split_text(text):
            chunks.append((piece, page_no))

    # 4) 各チャンクをベクトル化
    embeddings = embedder.embed_texts([c[0] for c in chunks])

    # 5) チャンクをDBへ保存(再取り込みに備え、同じマニュアルの既存チャンクは入れ替え)
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM "ManualChunk" WHERE manual_id = %s',
                (req.manual_id,),
            )
            for i, ((content, page_no), emb) in enumerate(zip(chunks, embeddings)):
                cur.execute(
                    'INSERT INTO "ManualChunk" (id, manual_id, chunk_index, page_number, content, embedding) '
                    "VALUES (gen_random_uuid(), %s, %s, %s, %s, %s::vector)",
                    (req.manual_id, i, page_no, content, to_vector_literal(emb)),
                )

    return IngestResponse(
        manual_id=req.manual_id,
        page_count=len(pages),
        chunk_count=len(chunks),
        transcribed_page_count=transcribed_count,
    )


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    """質問(+添付画像)に近いチャンクをベクトル検索し、Claudeが回答を生成する。

    <=> はpgvectorのコサイン距離演算子。小さいほど「近い(似ている)」。
    """
    # 0) 会話の続きなら、文脈を織り込んだ独立クエリに書き換える
    #    (「2です」だけではベクトル検索できないため)
    retrieval_query = req.question
    if req.history:
        try:
            retrieval_query = answer_generator.rewrite_query(req.question, req.history)
        except Exception:
            pass  # 書き換えに失敗しても元の質問文で検索は続行する

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

    # 1) 質問文(+画像の説明)を、チャンクと同じ方法でベクトル化
    query_vec = to_vector_literal(embedder.embed_texts([retrieval_query])[0])

    # 2) コサイン距離が近い順にチャンクを取得(マニュアル情報もJOINで添える)
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT mc.manual_id, m.title, mc.content, mc.page_number,
                       (mc.embedding <=> %s::vector) AS distance
                FROM "ManualChunk" mc
                JOIN "Manual" m ON m.id = mc.manual_id
                WHERE mc.embedding IS NOT NULL
                ORDER BY distance
                LIMIT 5
                """,
                (query_vec,),
            )
            rows = cur.fetchall()

    if not rows:
        return SearchResponse(
            answer="まだ検索できるマニュアルがありません。マニュアルをアップロードして取り込んでください。",
            citations=[],
        )

    # 引用は「同じマニュアルの同じページ」をまとめる(近い順は維持)
    citations: list[Citation] = []
    seen: set[tuple[str, int | None]] = set()
    for manual_id, title, content, page, _distance in rows:
        if (manual_id, page) in seen:
            continue
        seen.add((manual_id, page))
        citations.append(
            Citation(manual_id=manual_id, title=title, snippet=content[:150], page=page)
        )

    # 3) 取得した抜粋を根拠として、Claudeに回答文を書かせる。
    #    抜粋の見出しにページ番号を含めるので、回答文でも「(p.3)」のように言及できる。
    #    生成に失敗しても検索結果(引用)だけは返す(全滅させない)
    contexts = [
        Context(
            title=f"{title}(p.{page})" if page else title,
            content=content,
        )
        for _manual_id, title, content, page, _distance in rows
    ]
    try:
        answer = answer_generator.generate(
            req.question, contexts, image=image, history=req.history
        )
    except Exception as e:
        answer = (
            f"関連しそうなマニュアルが{len(citations)}件見つかりましたが、"
            f"回答文の生成に失敗しました({e})。以下の抜粋をご確認ください。"
        )

    return SearchResponse(answer=answer, citations=citations)
