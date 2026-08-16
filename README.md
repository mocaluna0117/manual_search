# Manualy — 社内マニュアル検索システム

社内マニュアルが増えるほど「どれを見ればいいか分からない」状態になる。
このアプリは、**知りたいことを日本語で聞けば、根拠のマニュアルごと答えが返る**ようにする。

タカマツビルド株式会社 アフターメンテナンス課での利用を前提に作っている。
機密資料を扱うため、社外からは一切見えない（認証必須・CloudFront + Cognito）。

```text
利用者:「トイレの漏水はどう対応する？」
  ↓
AI:「まず止水栓を閉めるよう案内します。止水後はお湯も止まることを伝えてください…」
    📄 社内用マニュアル（トイレ漏水対応フロー） p.4 受付時の対応
```

---

## 何ができるか

### 探す

- **AI検索（RAG）** — 日本語の質問に、マニュアルの記述だけを根拠に答える。回答は生成されるそばから流れて出る
- **根拠の提示** — 回答の下に、使ったマニュアルとページが並ぶ。押すとその場でPDFが開く
- **聞き返し** — 質問が曖昧なときは選択肢を出して絞り込む
- **画像を添えて質問** — 画面のスクリーンショットを4枚まで。貼り付け（Ctrl+V）でも添えられる
- **キーワード検索** — タイトル・ファイル名・本文の部分一致（AI検索とは別経路）

### 貯める

- **アップロード** — PDF / Word / Excel / PowerPoint / Outlookメール(.msg)。中身を読み取って検索対象にする
- **スキャンPDFの書き起こし** — 文字が取れないページはClaudeの画像認識でテキスト化する
- **AIによる自動分類** — 取り込み時とまとめての再分類。「床暖房関連はフローリングへ」のような分類ルールを覚えさせられる
- **フォルダ管理** — 作成・名前変更・並べ替え・ゴミ箱（元に戻せる）
- **管理者だけに見せるフォルダ** — 人事や取引条件など。一覧にも検索にも**AIの回答にも**出さない

### 育てる

- **利用状況（管理者のみ）** — 答えられなかった質問 / よく聞かれること / マニュアルの使われ方
- **回答への 👍 / 👎** — 人の判断をAIの自己申告より優先して集計する
- **マニュアルの下書き生成** — 答えられなかった質問から、章立てと分かっている範囲をAIが書く。分からないことは「(要確認)」で空ける

### チャットからの管理操作（管理者のみ）

会話の中でそのまま指示できる。

```text
「ANDPADというフォルダを作って、鍵付きにして」
「福祉住環境関係フォルダの名前を福祉住環境コーディネーターに変えて」
「床鳴りのマニュアルをフローリング関連に移して」
「全マニュアルを再分類して」          ← 実行前に確認が入る
「経理関係フォルダを削除して」        ← ゴミ箱へ（元に戻せる）
```

---

## 構成

```text
                    ┌──────────────┐
   ブラウザ ──HTTPS──│  CloudFront  │
                    └──────┬───────┘
                    /            \
              S3(静的)          ALB(/graphql, /chat/*)
              フロント             │
                                  ▼
                          ┌───────────────┐      ┌──────────────┐
                          │  backend      │─────▶│  rag         │
                          │  NestJS       │      │  FastAPI     │
                          │  GraphQL/SSE  │◀─────│  検索・生成   │
                          └───┬───────┬───┘      └──┬────────┬──┘
                              │       │             │        │
                         ┌────▼──┐ ┌──▼───┐    ┌────▼───┐ ┌──▼──────┐
                         │  RDS  │ │  S3  │    │  RDS   │ │ Bedrock │
                         │ +pgvec│ │ 原本  │    │ ベクトル │ │ Claude  │
                         └───────┘ └──────┘    └────────┘ └─────────┘
```

- **フロントは静的ファイル**。CloudFrontが `/graphql` と `/chat/*` だけALBへ流すので、ブラウザから見ると同一ドメインになりCORSの問題が消える
- **backendはRAGを直接叩かせない**。認証・権限・履歴の保存はすべてNestJS側で行い、RAGは内部ネットワークからのみ到達できる
- **回答はSSEで流す**。GraphQLは1往復で完成品を返す作りなので、ストリーミングだけ別経路（`/chat/stream`）にしている

### 技術スタック

| 領域 | 採用 | 補足 |
| --- | --- | --- |
| フロント | React + TypeScript + Vite + Chakra UI v3 | Apollo Client 4 |
| バックエンド | NestJS + GraphQL（コードファースト） | Prisma 7 |
| RAG | Python + FastAPI | 検索と生成だけを担当。DBは共有 |
| DB | PostgreSQL 16 + pgvector | HNSW索引 + pg_trgm |
| LLM | Amazon Bedrock（Claude Haiku 4.5） | 回答・分類・画像認識・下書き |
| 埋め込み | Amazon Titan Embeddings V2（1024次元） | |
| 認証 | Amazon Cognito（managed login・日本語） | ロールはDBで管理 |
| 実行環境 | ECS Fargate（ARM64） / RDS / S3 / CloudFront | |

### 検索の仕組み

質問はまず**同義語込みのキーワード列に展開**してから、3つのルートで探す。

| ルート | 得意 |
| --- | --- |
| ベクトル | 意味の近さ。言い回しが違っても拾える |
| キーワード（ILIKE） | 型番・電話番号・固有名詞のような文字通りの一致 |
| タイトル | 本文に手がかりが無い資料（記入見本のスキャンなど） |

3つの結果を **RRF（Reciprocal Rank Fusion）** で融合する。`score = Σ 1/(60 + 各ルートでの順位)` で、複数のルートに出てくるものほど上に来る。上位8件（`TOP_K`）をClaudeに渡し、**抜粋に書かれていることだけを根拠に**答えさせる。

回答の末尾でAIに「実際に使った抜粋の番号」を申告させ、引用の表示と「答えられたか」の集計に使っている。

---

## リポジトリの構成

```text
manual_search/
├── frontend/          React。画面はすべてここ
│   └── src/
│       ├── components/{chat,manual,layout,ui,auth}
│       ├── graphql/   クエリ定義（型付き）
│       └── lib/       共通処理（トースト・画像・端末判定など）
├── backend/           NestJS。認証・権限・保存・チャットの管理操作
│   ├── src/{chat,manual,category,analytics,inquiry,rag,storage,auth,...}
│   └── prisma/        スキーマとマイグレーション
├── rag/               FastAPI。検索・回答生成・取り込み・分類
│   ├── main.py        エンドポイントと検索本体
│   ├── llm.py         プロンプトと管理操作ツールの定義
│   └── tests/         pytest
├── infra/             IAMポリシー・バックアップ設定（実際に適用したもの）
├── docs/              構築の経緯と運用手順
└── scripts/           test.sh / aws-start.sh / aws-stop.sh
```

---

## ローカルで動かす

### 1. 依存サービス（PostgreSQL + MinIO）

```bash
cp .env.example .env      # パスワード類を埋める
docker compose up -d      # db / minio / minio-init
```

### 2. バックエンド

```bash
cd backend
cp .env.example .env      # DATABASE_URL などを埋める
npm ci
npx prisma migrate deploy
npx prisma generate
npm run start:dev         # http://localhost:3000/graphql
```

### 3. RAG

```bash
cd rag
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # 既定はAWSを使わない設定
uvicorn main:app --reload --port 8000
```

`EMBEDDING_PROVIDER=hashing` / `ANSWER_PROVIDER=stub` が既定なので、**AWSの資格情報が無くても起動して一通り触れる**（回答は定型文になる）。実際のAIを使うなら両方を `bedrock` にする。

### 4. フロント

```bash
cd frontend
cp .env.example .env      # Cognitoの設定を埋める
npm ci
npm run dev               # http://localhost:5173
```

### 本番同等の構成で動かす

```bash
docker compose --profile app up -d --build   # backend + rag + frontend をコンテナで
                                             # 画面は http://localhost:8080
```

---

## テスト

```bash
./scripts/test.sh
```

壊れると痛いところだけを残してある。

| 対象 | 内容 |
| --- | --- |
| backend（jest） | 問い合わせメールの組み立て（MIME・件名の符号化・添付・Reply-Toの判定） |
| rag（pytest） | 検索結果の融合(RRF)、隠しフォルダの除外、画像の受け渡し、下書きのプロンプト、LLM出力の解析 |

RAGのテストはPythonの依存を手元に入れずに済むよう、**本番と同じDockerイメージの中で**動かしている。

型とlintは各ディレクトリで。

```bash
cd frontend && npx tsc -b --noEmit && npm run lint   # lintは0件を保つ
cd backend  && npm run build                          # nest build（型チェック込み）
```

---

## デプロイ

`main` へのpushでは自動デプロイされない（CIは未整備）。手順は3つ。

```bash
# 1. RAG
docker build --platform linux/arm64 -t <ECR>/manual-search/rag:latest -f rag/Dockerfile rag
docker push <ECR>/manual-search/rag:latest
aws ecs update-service --cluster manual-search --service rag --force-new-deployment

# 2. バックエンド
docker build --platform linux/arm64 -t <ECR>/manual-search/backend:latest -f backend/Dockerfile backend
docker push <ECR>/manual-search/backend:latest
aws ecs update-service --cluster manual-search --service backend --force-new-deployment

# 3. フロント
cd frontend && VITE_GRAPHQL_URL=/graphql npm run build
aws s3 sync dist/ s3://manual-search-frontend-<ACCOUNT>/ --delete
aws cloudfront create-invalidation --distribution-id <ID> --paths '/*'
```

**RAGとバックエンドの両方を変えるときはRAGを先に出す。** 新しいバックエンドが古いRAGを呼ぶ形なら機能が落ちるだけで済むが、逆だと呼び出しが失敗する。

### DBマイグレーション

本番のRDSはVPC内にあり手元から直接繋がらないため、**ECSの単発タスク**で流す。

1. `aws rds create-db-snapshot` でスナップショットを取る（**必ず先に**）
2. `prisma migrate dev --create-only` でSQLを生成し、**手で中身を確認する**
3. 単発タスクでSQLを実行し、`_prisma_migrations` に記録を入れる

> ⚠️ `prisma migrate dev` が生成するSQLには、生SQLで作った検索用インデックス（pg_trgm / HNSW）の `DROP` が必ず混ざる。そのまま流すと**検索が黙って壊れる**。必要な文だけを残して手で書くこと。適用後はインデックスが残っているか確認する。

---

## 運用

| 項目 | 内容 |
| --- | --- |
| バックアップ | AWS Backupで毎日03:00 JST・14日保持（RDSの自動バックアップは無料枠の制限で1日のみ） |
| 監視 | ALBの5xx / 異常ターゲット / ECSタスク数 / DB空き容量 → SNS（メール2件） |
| ログ | CloudWatch Logs `/ecs/manual-search/{backend,rag}` |
| 一時停止 | `./scripts/aws-stop.sh` でRDSとECSを止める（ALBは止められないので固定費が残る） |
| 再開 | `./scripts/aws-start.sh`（RDSが起きてからECSを上げる） |

マニュアルの原本はS3のバージョニングで守られている。DBだけが単一の置き場所なので、日次バックアップが最後の砦になる。

---

## 設計上の判断

作りながら決めたことのうち、後から読んで迷いそうなもの。

- **PDF本体はDBに入れない。** S3に置き、DBはメタデータとベクトルだけを持つ
- **署名付きURLはブラウザに直接渡す。** ファイルの中身がbackendを通らないので、大きなPDFでもメモリを食わない
- **AIの申告より人の評価を優先する。** 👍/👎があればそれを使い、無ければAIの `[参照]` 行を見る。どちらも無い場合は「判定できなかった理由」まで記録する（聞き返し・管理操作・生成失敗を「未判定」に混ぜない）
- **隠しフォルダは検索の段階で除く。** 一覧から消すだけでは、AIの回答の根拠として中身が漏れる
- **AIの自動分類は隠しフォルダに触れない。** 中身を出さない／行き先にもしない
- **管理操作は「実行したフリ」を検知する。** AIが本文で「作成しました」と書いてもツールを呼んでいなければ、システムが訂正を追記する
- **チャットの履歴からシステムの成功行（📁📏🔒など）を除いて渡す。** 残すとAIがそれを真似て、実行せずに成功宣言だけ書くようになる
- **モバイルはPDFを別タブで開く。** スマホのブラウザは埋め込みPDFを描き切れず1ページ目で固まるため

---

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/deployment-plan.md](docs/deployment-plan.md) | AWS構築の経緯、費用、実際に踏んだ落とし穴 |
| [docs/er-diagram.md](docs/er-diagram.md) | テーブル構成 |
| [docs/usage-guide/](docs/usage-guide/) | 利用者向けの使い方ガイド（アプリ内から開ける） |
| [HANDOFF.md](HANDOFF.md) | 初期の設計方針と進め方 |
