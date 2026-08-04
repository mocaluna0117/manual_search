# ==== ビルドステージ: TypeScriptのコンパイルとPrismaクライアント生成 ====
FROM node:24-slim AS build
WORKDIR /app

# 依存定義だけ先にコピーしてinstall(コード変更時にここのキャッシュが効く)
COPY package*.json ./
RUN npm ci

# Prismaクライアントを生成(generated/はGit管理外なのでビルド時に作る)
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
RUN npx prisma generate

COPY src ./src
RUN npm run build

# ==== 実行ステージ: 本番実行に必要なものだけを載せた軽量イメージ ====
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# RDSのTLS証明書を検証するためのAmazon RDS CA(全リージョン分の束)。
# Nodeの標準信頼ストアには入っていないため自分で持たせる。
# ベースイメージにcurlが無いのでNode自身で取得する。
RUN mkdir -p /app/certs && node -e "\
  fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem') \
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }) \
    .then(t => require('fs').writeFileSync('/app/certs/rds-ca.pem', t))"

EXPOSE 3000
CMD ["node", "dist/src/main"]
