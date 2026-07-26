"""画像からテキストを書き起こすプロバイダ(スキャンPDF対応の心臓部)。

専用のOCRエンジンではなく、Claudeの画像認識(マルチモーダル)を使う。
日本語・レイアウト・図表の説明までこなせるのが従来型OCRとの違い。
"""

import io
import os

import pypdfium2 as pdfium

# 1ドキュメントあたりの書き起こし上限ページ数(コスト暴走の安全弁。
# 100ページのスキャンPDFを投げられても際限なくClaudeを呼ばないため)
MAX_TRANSCRIBE_PAGES = 30

TRANSCRIBE_PROMPT = (
    "これは社内マニュアルの1ページです。画像に含まれるすべてのテキストを、"
    "内容の順序が伝わる形で書き起こしてください。図や表がある場合は、"
    "その内容を簡潔な文章で説明してください。書き起こし結果だけを出力してください。"
)


def render_page_jpeg(pdf_bytes: bytes, page_index: int, scale: float = 2.0) -> bytes:
    """PDFの1ページをJPEG画像に変換する(scale=2.0 ≒ 144dpi)"""
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        buf = io.BytesIO()
        # JPEGはスキャン画像の圧縮率が高く、Bedrockのサイズ上限(約3.75MB)に収めやすい
        image.convert("RGB").save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    finally:
        doc.close()


class NullTranscriber:
    """開発用(AWS無し): 書き起こしをしない。スキャンページは空のまま"""

    enabled = False

    def transcribe(self, image_bytes: bytes) -> str:
        return ""


class BedrockTranscriber:
    """Claudeの画像認識でページ画像をテキスト化する"""

    enabled = True

    def __init__(self, model_id: str, region: str):
        import boto3

        self.client = boto3.client("bedrock-runtime", region_name=region)
        self.model_id = model_id

    def transcribe(self, image_bytes: bytes) -> str:
        res = self.client.converse(
            modelId=self.model_id,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": "jpeg", "source": {"bytes": image_bytes}}},
                        {"text": TRANSCRIBE_PROMPT},
                    ],
                }
            ],
            inferenceConfig={"maxTokens": 2048, "temperature": 0},
        )
        return res["output"]["message"]["content"][0]["text"]


def create_transcriber():
    # 回答生成と同じスイッチで有効化(どちらもClaude/Bedrockなので)
    if os.environ.get("ANSWER_PROVIDER", "stub") == "bedrock":
        return BedrockTranscriber(
            model_id=os.environ.get(
                "BEDROCK_CHAT_MODEL_ID",
                "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
            ),
            region=os.environ.get("AWS_REGION", "ap-northeast-1"),
        )
    return NullTranscriber()
