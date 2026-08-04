FROM python:3.13-slim
WORKDIR /app

# 依存定義だけ先にコピーしてinstall(キャッシュを効かせる)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# RDSのTLS証明書を検証するためのAmazon RDS CA(全リージョン分の束)。
# ベースイメージにcurlが無いのでPython自身で取得する。
RUN mkdir -p /app/certs && python -c "\
import urllib.request; \
urllib.request.urlretrieve( \
    'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', \
    '/app/certs/rds-ca.pem')"

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
