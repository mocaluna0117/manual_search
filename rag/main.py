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
        transcribed_page_count=transcribed_count,
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

    # 3) 取得した抜粋を根拠として、Claudeに回答文を書かせる。
    #    生成に失敗しても検索結果(引用)だけは返す(全滅させない)
    contexts = [
        Context(title=title, content=content)
        for _manual_id, title, content, _distance in rows
    ]
    try:
        answer = answer_generator.generate(req.question, contexts)
    except Exception as e:
        answer = (
            f"関連しそうなマニュアルが{len(citations)}件見つかりましたが、"
            f"回答文の生成に失敗しました({e})。以下の抜粋をご確認ください。"
        )

    return SearchResponse(answer=answer, citations=citations)
