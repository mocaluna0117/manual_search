import os
import urllib.request
from io import BytesIO

import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pypdf import PdfReader

from chunking import split_text

load_dotenv()  # rag/.env を読み込む

DATABASE_URL = os.environ["DATABASE_URL"]

app = FastAPI(title="Manual Search RAG Service")


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

    # 3) チャンクをDBへ保存(再取り込みに備え、同じマニュアルの既存チャンクは入れ替え)
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'DELETE FROM "ManualChunk" WHERE manual_id = %s',
                (req.manual_id,),
            )
            for i, chunk in enumerate(chunks):
                cur.execute(
                    'INSERT INTO "ManualChunk" (id, manual_id, chunk_index, content) '
                    "VALUES (gen_random_uuid(), %s, %s, %s)",
                    (req.manual_id, i, chunk),
                )

    return IngestResponse(
        manual_id=req.manual_id,
        page_count=len(pages),
        chunk_count=len(chunks),
    )


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    # TODO: ここを「pgvectorで類似チャンク検索 → Bedrock(Claude)で回答生成」に置き換える
    return SearchResponse(
        answer=f"(スタブ回答) 「{req.question}」への回答はまだ実装されていません。"
        "RAGパイプライン実装後、ここに本物の回答と根拠マニュアルが返ります。",
        citations=[],
    )
