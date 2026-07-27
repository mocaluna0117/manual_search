"""テキストをベクトル(埋め込み)に変換するプロバイダ。

- HashingEmbedder: ローカル開発用。AWS不要で全配管を検証できる(字面ベースの簡易版)
- BedrockEmbedder: 本番用。Amazon Bedrock Titan Embeddings V2(意味ベース)

環境変数 EMBEDDING_PROVIDER=hashing|bedrock で切り替える。
どちらも同じ次元数・同じインターフェースなので、呼ぶ側は違いを知らなくてよい。
"""

import json
import math
import os
import zlib
from typing import Protocol

DIMENSIONS = 1024  # ManualChunk.embedding の vector(1024) と一致させること


class Embedder(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...


class HashingEmbedder:
    """文字n-gramをハッシュして固定長ベクトルにする(開発用)。

    意味は理解しないが、同じ単語を含む文同士は近いベクトルになるので、
    ベクトル検索の配管テストには十分。zlib.crc32は実行のたびに
    結果が変わらない「安定した」ハッシュなのでDB保存に使える。
    """

    def __init__(self, ngram: int = 3):
        self.ngram = ngram

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * DIMENSIONS
        t = text.lower()
        for i in range(max(len(t) - self.ngram + 1, 1)):
            gram = t[i : i + self.ngram].encode("utf-8")
            h = zlib.crc32(gram)
            bucket = h % DIMENSIONS
            sign = 1.0 if (h >> 16) % 2 == 0 else -1.0
            vec[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


class BedrockEmbedder:
    """Amazon Bedrock Titan Embeddings V2(本番用)"""

    def __init__(self, model_id: str, region: str):
        # bedrockを使うときだけimport(ローカル開発で必須にしない)
        from bedrock import create_bedrock_client

        self.client = create_bedrock_client(region)
        self.model_id = model_id

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def _embed(self, text: str) -> list[float]:
        body = json.dumps(
            {
                "inputText": text[:8000],
                "dimensions": DIMENSIONS,
                "normalize": True,
            }
        )
        res = self.client.invoke_model(modelId=self.model_id, body=body)
        return json.loads(res["body"].read())["embedding"]


def create_embedder() -> Embedder:
    provider = os.environ.get("EMBEDDING_PROVIDER", "hashing")
    if provider == "bedrock":
        return BedrockEmbedder(
            model_id=os.environ.get(
                "BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0"
            ),
            region=os.environ.get("AWS_REGION", "ap-northeast-1"),
        )
    return HashingEmbedder()


def to_vector_literal(embedding: list[float]) -> str:
    """pgvectorが受け取れる '[0.1,0.2,...]' 形式の文字列にする"""
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"
