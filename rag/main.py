from fastapi import FastAPI
from pydantic import BaseModel

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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    # TODO: ここを「pgvectorで類似チャンク検索 → Bedrock(Claude)で回答生成」に置き換える
    return SearchResponse(
        answer=f"(スタブ回答) 「{req.question}」への回答はまだ実装されていません。"
        "RAGパイプライン実装後、ここに本物の回答と根拠マニュアルが返ります。",
        citations=[],
    )
