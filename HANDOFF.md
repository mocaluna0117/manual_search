# 引き継ぎサマリ: 社内マニュアル検索システム

## 1. プロジェクト概要

社内に膨大なマニュアルがあり、利用者がどれを見ればいいか分からない問題を解決する Web アプリ。

- キーワード検索
- RAG による AI 検索
- ChatGPT 風 UI
  - 中央に検索欄
  - 左サイドバーにチャット履歴
  - マニュアルをカテゴリ別に表示
- PDF 管理
  - アップロード
  - 削除
  - カテゴリ分け
- 認証必須
  - 社外アクセス不可
  - 機密情報を扱う前提

## 2. 確定した技術スタック・方針

| 領域 | 採用 |
|---|---|
| フロント | React + TypeScript + Vite + Chakra UI |
| バックエンド | NestJS + GraphQL（コードファースト） |
| DB | PostgreSQL 16 + pgvector |
| PDF 保存 | オブジェクトストレージ。開発は MinIO 予定、本番は Azure Blob 等を検討 |
| RAG | Python FastAPI マイクロサービス。NestJS から呼ぶ |
| LLM | Claude API / Anthropic |
| 認証 | Microsoft Entra ID / OIDC SSO |
| 開発環境 | Docker Compose |
| 本番デプロイ | 未確定。第一候補は Azure Container Apps + Azure Database for PostgreSQL + Azure Blob Storage |

重要な決定:

- PDF 本体は DB に保存しない
- DB にはメタデータと RAG 用ベクトルのみ保存する
- ベクトル検索は PostgreSQL + pgvector で進める
- Prisma は Prisma 7 方式で進める

## 3. 作業の進め方

ユーザーは学習しながら自分でコードを書きたい。

Claude Code では以下の対話形式で進めること。

1. AI が 1 ステップ分のコードと解説を提示
2. ユーザーが自分で手書き、またはコマンド実行
3. ユーザーが「書いたよ」と言う
4. 次のステップへ進む

注意:

- ファイルを一括生成しない
- 小さく区切る
- 何を、なぜ書くのかを説明する
- ユーザーの完了合図を待つ

## 4. 現在の構成

```text
manual_search/
├── docker-compose.yml
├── .env
├── .env.example
├── .gitignore
├── README.md
├── HANDOFF.md
├── CODEX_HANDOFF.md
├── frontend/
├── backend/
│   ├── prisma.config.ts
│   ├── prisma/
│   │   └── schema.prisma
│   ├── generated/
│   │   └── prisma/
│   └── src/
│       ├── app.module.ts
│       ├── app.resolver.ts
│       ├── app.controller.ts
│       ├── app.service.ts
│       ├── schema.gql
│       └── prisma/
│           └── service.ts
└── rag/
```

## 5. 完了済み

- Step 1: ワークスペース骨格
  - Git 初期化
  - `frontend/`, `backend/`, `rag/` 作成
  - `.gitignore` 作成
  - `README.md` 作成
- Step 2: PostgreSQL + pgvector
  - `docker-compose.yml` で `pgvector/pgvector:pg16` を起動
  - pgvector `0.8.2` 動作確認済み
  - ホスト側ポートは `54321`
  - コンテナ内部は `5432`
  - DB 認証は user=`manual`, db=`manual_search`
- Step 3: NestJS 雛形
  - `backend/` に NestJS 初期 scaffold 作成
  - `Hello World!` 起動確認済み
- Step 4: GraphQL 導入
  - `@nestjs/graphql`, `@nestjs/apollo`, `@apollo/server`, `graphql` 導入済み
  - NestJS v11 / Express 5 対応として `@as-integrations/express5` 導入済み
  - `GraphQLModule.forRoot<ApolloDriverConfig>` 設定済み
  - `src/app.resolver.ts` 作成済み
  - `query { health }` が `"ok"` を返すことを確認済み
  - `src/schema.gql` 自動生成済み
- Step 5: Prisma 7 導入途中
  - `prisma` 導入済み
  - Prisma 7 方式へ寄せる方針で確定
  - `@prisma/adapter-pg`, `pg`, `@types/pg` 導入済み
  - `@prisma/client` は依存として必要なため入れ直し済み
  - `npx prisma db pull` 実行済み
  - `npx prisma generate` 実行済みの状態で `backend/generated/prisma/` が存在
  - `src/prisma/service.ts` 作成済み
  - `PrismaService` を `AppModule` の providers に登録済み
  - `npm run build` は成功済み

## 6. Prisma 7 まわりの重要メモ

`backend/prisma/schema.prisma` は Prisma 7 方式。

```prisma
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

接続 URL は `schema.prisma` に書かない。`backend/prisma.config.ts` 側で読む。

```ts
datasource: {
  url: process.env['DATABASE_URL'],
},
```

`backend/.env` の接続先:

```env
DATABASE_URL="postgresql://manual:manual_dev_password@localhost:54321/manual_search?schema=public"
```

Prisma 7 方式の理解:

- アプリコードでは `@prisma/client` から直接 import しない
- `PrismaClient` は `backend/generated/prisma/client` から import する
- ただし生成コードが `@prisma/client/runtime/client` を内部参照するため、依存パッケージとして `@prisma/client` は必要
- PostgreSQL 接続には `@prisma/adapter-pg` と `pg` を使う

現在の `PrismaService`:

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    const adapter = new PrismaPg({ connectionString });

    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

## 7. 直近で次にやること

Claude Code ではここから再開する。

次の自然なステップ:

1. NestJS 起動時に `PrismaService` が DB 接続できるか確認する
2. DB 疎通確認用の GraphQL Query を追加する
3. `query { dbHealth }` のようなクエリで `SELECT 1` 相当を実行する
4. 成功したら Prisma schema に最初のモデルを追加する

おすすめの次ステップ例:

`AppResolver` に `PrismaService` を注入し、DB 疎通確認用 Query を追加する。

```ts
import { Query, Resolver } from '@nestjs/graphql';
import { PrismaService } from './prisma/service';

@Resolver()
export class AppResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query(() => String)
  health(): string {
    return 'ok';
  }

  @Query(() => String)
  async dbHealth(): Promise<string> {
    await this.prisma.$queryRaw`SELECT 1`;
    return 'db ok';
  }
}
```

その後:

```bash
cd /Users/daiki.kimura/manual_search/backend
npm run start:dev
```

GraphQL Playground:

```graphql
query {
  dbHealth
}
```

期待値:

```json
{
  "data": {
    "dbHealth": "db ok"
  }
}
```

## 8. 今後の予定

- Step 5 完了: NestJS と PostgreSQL の疎通確認
- Step 6: Prisma schema に最初のモデルを作る
  - 例: `Manual`, `ManualCategory`, `ManualChunk`
  - pgvector の扱いは Prisma の型サポート状況を見ながら検討
- Step 7: フロント Vite + React + Chakra UI 雛形
- Step 8: Python FastAPI RAG サービス雛形
- Step 9: フロント -> GraphQL -> DB / RAG の疎通確認
- その後:
  - Microsoft Entra ID OIDC 認証
  - PDF アップロード
  - MinIO 導入
  - PDF -> テキスト抽出 -> チャンク化 -> embedding -> pgvector
  - Claude API を使った RAG 回答生成
  - 本番デプロイ

## 9. 環境メモ

- OS: macOS
- shell: zsh
- 作業ディレクトリ: `/Users/daiki.kimura/manual_search`
- DB 起動:

```bash
docker compose up -d
```

- DB 接続確認:

```bash
docker compose exec db psql -U manual -d manual_search
```

- Backend build:

```bash
cd /Users/daiki.kimura/manual_search/backend
npm run build
```

2026-06-06 時点で `npm run build` は成功済み。

## 10. Git 状態メモ

2026-06-06 時点で未コミット変更あり。

主な変更:

- `backend/package.json`
- `backend/package-lock.json`
- `backend/src/app.module.ts`
- `backend/prisma.config.ts`
- `backend/prisma/schema.prisma`
- `backend/generated/prisma/`
- `backend/src/prisma/service.ts`
- `backend/.gitignore`
- `.vscode/`

Claude Code 側で続けるときは、まず `git status --short --branch` で最新状態を確認すること。
