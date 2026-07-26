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

load_dotenv()  # rag/.env を読み込む

DATABASE_URL = os.environ["DATABASE_URL"]

app = FastAPI(title="Manual Search RAG Service")
embedder = create_embedder()


class SearchRequest(BaseModel):
    question: str


class Citation(BaseModel):
    """回答の根拠となったマニュアルの断片"""

    manual_id: str
    title: str
    snippet: str


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
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"PDFを解析できません: {e}")

    full_text = "\n".join(pages)
    chunks = split_text(full_text)

    # 3) 各チャンクをベクトル化
    embeddings = embedder.embed_texts(chunks)

    # 4) チャンクをDBへ保存(再取り込みに備え、同じマニュアルの既存チャンクは入れ替え)
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM "ManualChunk" WHERE manual_id = %s',
                (req.manual_id,),
            )
            for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
                cur.execute(
                    'INSERT INTO "ManualChunk" (id, manual_id, chunk_index, content, embedding) '
                    "VALUES (gen_random_uuid(), %s, %s, %s, %s::vector)",
                    (req.manual_id, i, chunk, to_vector_literal(emb)),
                )

    return IngestResponse(
        manual_id=req.manual_id,
        page_count=len(pages),
        chunk_count=len(chunks),
    )


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    """質問に近いチャンクをベクトル検索で探す。

    <=> はpgvectorのコサイン距離演算子。小さいほど「近い(似ている)」。
    回答文の生成(Claude)は次ステップで実装し、今は関連マニュアルの提示まで。
    """
    # 1) 質問文を、チャンクと同じ方法でベクトル化
    query_vec = to_vector_literal(embedder.embed_texts([req.question])[0])

    # 2) コサイン距離が近い順にチャンクを取得(マニュアル情報もJOINで添える)
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT mc.manual_id, m.title, mc.content,
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

    citations = [
        Citation(manual_id=manual_id, title=title, snippet=content[:150])
        for manual_id, title, content, _distance in rows
    ]
    return SearchResponse(
        answer=f"「{req.question}」に関連しそうなマニュアルが{len(citations)}件見つかりました。"
        "詳しくは以下をご覧ください。(AIによる回答文の生成は次のステップで実装します)",
        citations=citations,
    )
