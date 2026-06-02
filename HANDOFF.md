# 📋 引き継ぎサマリ：社内マニュアル検索システム

## 1. プロジェクト概要
社内に膨大なマニュアルがあり、利用者がどれを見ればいいか分からない問題を解決するWebアプリ。
- **キーワード検索**（よくある入力値との一致）
- **RAGによるAI検索**（最適なマニュアルを提示）
- **UI**: ChatGPT風（中央に検索欄／左サイドバーにチャット履歴＋カテゴリ別マニュアル一覧）
- **PDF管理**: アップロード・削除・カテゴリ分け
- **認証必須**（社外アクセス不可。機密情報のため）

## 2. 確定した技術スタック・方針
| 領域 | 採用 |
|---|---|
| フロント | React + TypeScript + Vite + Chakra UI |
| バックエンド | NestJS + GraphQL（**コードファースト**方式） |
| DB | PostgreSQL 16 + **pgvector**（メタデータ＋ベクトルのみ。**PDF本体はDBに入れない**） |
| PDF保存 | オブジェクトストレージ（開発はMinIO予定 → 本番はAzure Blob等） |
| RAG | Python（FastAPI）マイクロサービス。NestJSから呼ぶ |
| LLM | **Claude API（Anthropic）**（学習に使われず機密向き） |
| 認証 | **Microsoft Entra ID（OIDC SSO）**（Outlook独自ドメイン利用のため） |
| 開発環境 | Docker Compose |
| 本番デプロイ | 未確定。コンテナ化して移植可能に。第一候補は Azure Container Apps + Azure DB for PostgreSQL + Blob Storage |

**重要な決定**: PDFはDBに保存せずオブジェクトストレージへ。DBには軽量なメタデータと埋め込みベクトル(pgvector)のみ → 無料DBの容量問題を回避。

## 3. 構成（モノレポ）
```
manual_search/
├── docker-compose.yml   # DB(pgvector)を起動
├── .env                 # 秘密情報（Git管理外）
├── .env.example         # テンプレ（Git管理内）
├── .gitignore
├── README.md
├── HANDOFF.md           # このファイル
├── frontend/   # 未着手
├── backend/    # NestJS雛形済み（GraphQL導入中）
└── rag/        # 未着手
```

## 4. 完了済み
- ✅ **Step 1**: Git初期化、フォルダ構成、`.gitignore`（`.env`除外含む）、README
- ✅ **Step 2**: `docker-compose.yml` で `pgvector/pgvector:pg16` を起動。`pgvector 0.8.2` 動作確認済み。
  - ⚠️ **ホスト側ポートは 54321**（標準の5432は別用途で使用中のため）。`.env` の `POSTGRES_PORT=54321`。コンテナ内部は5432のまま。
  - DB認証: user=`manual` / db=`manual_search`
- ✅ **Step 3**: `backend/` に NestJS 雛形を生成（`@nestjs/cli new .`）。`Hello World!` 起動確認済み。

## 5. 進行中（直近でやろうとしていたこと）
- 🔄 **Step 4: GraphQL導入**（未完了。動作確認待ち）
  - `npm install @nestjs/graphql @nestjs/apollo @apollo/server graphql`
  - `app.module.ts` に `GraphQLModule.forRoot`（`autoSchemaFile: src/schema.gql`、コードファースト）を追加
  - `src/app.resolver.ts` を新規作成し、動作確認用 `health: String` クエリを実装、`providers` に登録
  - **ゴール**: http://localhost:3000/graphql で `query { health }` → `"ok"` が返ること

## 6. 未着手TODO（今後の予定順）
- [ ] **Step 4 完了確認**（GraphQL `health` クエリ）
- [ ] **Step 5**: NestJS ↔ DB 接続（Prisma導入予定。接続は host:54321 を使用）
- [ ] **Step 6**: フロント（Vite+React+Chakra）雛形 → 起動確認
- [ ] **Step 7**: Python(FastAPI) RAGサービス雛形
- [ ] **Step 8**: 3者の疎通確認（フロント→GraphQL→DB / RAG呼び出し）
- [ ] その後: 認証(Entra ID OIDC)、PDFアップロード＋MinIO、RAGパイプライン（PDF→チャンク→埋め込み→pgvector→Claude API）、本番デプロイ

## 7. 作業の進め方（重要・必読）
ユーザーは**学習しながら自分でコードを書きたい**。**対話・チュートリアル形式**で進めること:
1. AIが「1ステップ分」のコードと解説を提示
2. ユーザーが自分で手書き
3. ユーザーが「書いたよ」と言う
4. 次のステップへ

→ **ファイルを一括生成しない**こと。小さく区切り、各ステップで「何を・なぜ」を解説し、ユーザーの完了合図を待つ。

## 8. 環境メモ
- OS: macOS (Darwin), shell: zsh
- 作業ディレクトリ: `/Users/daiki.kimura/manual_search`
- DB起動: `docker compose up -d` / 接続確認: `docker compose exec db psql -U manual -d manual_search`
