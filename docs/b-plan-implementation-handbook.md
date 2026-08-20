# B案 実装ハンドブック

**この文書の役割**: 無料クレジットが尽きる前後で移行作業に着手するとき、
これ一枚を読めば手が動く状態にしておくための技術メモ。
「いつ・誰が」は [移行手順書](b-plan-migration-runbook.md) 側にある。

作業に入るときは、まずこの文書の「0. 着手時の確認」から読む。

---

## 0. 着手時の確認

```bash
./scripts/check-credits.sh    # 残り日数。これで使える時間を把握する
./scripts/backup-all.sh       # 最新データを手元に取り出す(先にやる)
./scripts/verify-backup.sh ~/manual-search-backups/<最新>/database.dump
./scripts/test.sh             # backend 42件 / RAG 52件が通ることを確認
```

**AWSアカウントはクレジット枯渇と同時に閉鎖され、データを読み出せなくなる。**
バックアップが手元にあることを確認してから作業を始める。

準備が済んでいるもの:

| ある物 | 場所 |
| --- | --- |
| データの取り出し | `scripts/backup-all.sh` |
| 復元訓練 | `scripts/verify-backup.sh` |
| 残クレジットの確認 | `scripts/check-credits.sh` |
| プロバイダ差し替えの継ぎ目 | `rag/embedding.py` `rag/llm.py` `rag/vision.py` の各 `create_*()` |

---

## 1. 全体像

| 部品 | 現在 | 移行後 | 実装の重さ |
| --- | --- | --- | --- |
| 画面の配信 | S3 + CloudFront | Cloudflare Pages | 軽（ビルド成果物を上げるだけ＋CORS） |
| アプリ本体 | ECS Fargate ×2 + ALB | Cloud Run ×2（東京） | 中（サービス間認証・SSE・裏処理） |
| データベース | RDS PostgreSQL 16 | Supabase（東京） | 中（接続方式とプール） |
| PDF・画像 | S3 | Cloudflare R2（APAC） | **軽（環境変数のみ）** |
| 埋め込み | Bedrock Titan V2 (1024次元) | Workers AI bge-m3 (1024次元) | 中（＋全件再埋め込み） |
| 回答生成 | Bedrock Claude Haiku 4.5 | Workers AI Llama 3.3 70B | **重（tool use が要）** |
| 画像理解 | Bedrock Claude | Workers AI vision モデル | 中 |
| 認証 | Cognito | Entra ID（会社のM365） | **重（＋利用者IDの移行）** |
| メール | SES | Microsoft Graph sendMail | 中 |

---

## 2. AWSに依存している箇所（棚卸し）

これだけしかない。ここを潰せば移行は完了する。

### backend（TypeScript）

| ファイル | 依存 | 移行後 |
| --- | --- | --- |
| `src/storage/service.ts` | `@aws-sdk/client-s3`, `s3-request-presigner` | **そのまま使える**（R2はS3互換。環境変数だけ差し替え） |
| `src/inquiry/service.ts` | `@aws-sdk/client-sesv2` | Graph sendMail に差し替え |
| `src/user/cognito.ts` | `@aws-sdk/client-cognito-identity-provider` | 廃止（→ 5.4 参照） |
| `src/auth/strategy.ts` | Cognito の issuer/JWKS | Entra ID の issuer/JWKS |

### rag（Python）

| ファイル | 依存 | 移行後 |
| --- | --- | --- |
| `embedding.py` | `BedrockEmbedder` | `WorkersAiEmbedder` を足す |
| `llm.py` | `BedrockAnswerGenerator` | `WorkersAiAnswerGenerator` を足す |
| `vision.py` | `BedrockTranscriber` | `WorkersAiTranscriber` を足す |
| `bedrock.py` | boto3 クライアント生成 | 残す（AWS版に戻せるように） |

### frontend

| ファイル | 依存 | 移行後 |
| --- | --- | --- |
| `src/lib/auth.ts` | Cognito の OIDC 設定 | Entra ID の OIDC 設定 |
| `src/components/layout/UserManagementDialog.tsx` | 招待・削除 | 権限切替のみに縮小（→ 5.4） |

**方針**: 既存の Bedrock / Cognito / SES 実装は消さない。環境変数で選べるようにして、
`EMBEDDING_PROVIDER=bedrock` に戻せば AWS 版として動く状態を保つ（切り戻しの保険）。

---

## 3. 作業の順番

前の段が終わらないと次が試せない、という依存関係の順。

```
1. Supabase を用意（DBが無いと何も動かない）
2. R2 を用意（環境変数だけ。ここは軽い）
3. Workers AI の埋め込み＋回答生成をローカルで実装・検証
   ← docker compose のローカルDBに対して試せる。AWSに影響しない
4. Entra ID 認証（会社の設定が済んでから）
5. Graph メール送信
6. Cloud Run へデプロイ（サービス間認証・SSE・裏処理の確認）
7. Cloudflare Pages へ画面を配信（＋CORS）
8. 本番データの移行 → 全件再埋め込み
9. 検証 → 切り替え
```

3 は AWS を動かしたまま並行して進められる。**先に着手すべきはここ。**

---

## 4. 移行後の環境変数

### rag

```bash
# AI（Workers AI）
EMBEDDING_PROVIDER=workers_ai
ANSWER_PROVIDER=workers_ai
CF_ACCOUNT_ID=<CloudflareのアカウントID>
CF_API_TOKEN=<Workers AI の実行権限を持つトークン>
CF_EMBEDDING_MODEL=@cf/baai/bge-m3
CF_CHAT_MODEL=<確認待ち: tool use に対応するモデル>
CF_VISION_MODEL=@cf/meta/llama-3.2-11b-vision-instruct

# DB（Supabase）
DATABASE_URL=<Supabaseの接続文字列。プール方式は 5.7 を参照>
# DATABASE_SSL_CA は不要になる（RDSのCA専用。未設定でよい）

# PDFの取得元を絞る安全弁。R2のホストを必ず足す（忘れると取り込みが全部失敗する）
RAG_ALLOWED_DOWNLOAD_HOSTS=<accountid>.r2.cloudflarestorage.com
```

### backend

```bash
# ストレージ（R2）— 実装変更なし、値だけ差し替え
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_REGION=auto            # R2は常に auto
S3_BUCKET=manual-search-manuals
S3_ACCESS_KEY=<R2のアクセスキー>
S3_SECRET_KEY=<R2のシークレット>
S3_FORCE_PATH_STYLE=true

# 認証（Entra ID）
ENTRA_TENANT_ID=<テナントID>
ENTRA_CLIENT_ID=<アプリの(クライアント)ID>
ENTRA_API_AUDIENCE=<APIのApplication ID URI>

# メール（Graph）
GRAPH_TENANT_ID=<テナントID>
GRAPH_CLIENT_ID=<アプリのID>
GRAPH_CLIENT_SECRET=<クライアントシークレット>
GRAPH_SENDER=<no-reply@... 共有メールボックス>
INQUIRY_TO_EMAIL=<今と同じ宛先>

FRONTEND_ORIGIN=https://<Pagesのドメイン>   # CORSに使う
RAG_SERVICE_URL=https://<ragのCloud Run URL>
```

### frontend（ビルド時）

```bash
VITE_GRAPHQL_URL=https://<backendのCloud Run URL>/graphql
VITE_ENTRA_AUTHORITY=https://login.microsoftonline.com/<テナントID>/v2.0
VITE_ENTRA_CLIENT_ID=<アプリのID>
VITE_ENTRA_SCOPE=<APIのスコープ>
```

---

## 5. 各作業の詳細

### 5.1 埋め込み（Workers AI bge-m3）

`rag/embedding.py` に `WorkersAiEmbedder` を足し、`create_embedder()` に分岐を1つ増やす。
既存の `BedrockEmbedder` は消さない。

```python
class WorkersAiEmbedder:
    """Cloudflare Workers AI の bge-m3(1024次元)"""
    def __init__(self, account_id: str, api_token: str, model: str): ...
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...
```

守ること:
- **返る次元数が 1024 であることを最初に確認する。** 違えば
  `ManualChunk.embedding` の `vector(1024)` とHNSW索引を作り直すマイグレーションが要る
- 正規化されていない場合は自前で正規化する（コサイン距離の前提を保つ）
- `HashingEmbedder` と同じ「同じ入力なら同じ出力」を保つ（DBに保存する値なので）
- タイムアウトとリトライを明示（`bedrock.py` と同じ考え方。無いと呼び出し元が詰まる）
- 失敗時は例外を投げる。**静かに0ベクトルを返してはいけない**（検索が壊れたことに
  気づけなくなる）

テスト: `rag/tests/` に、偽のHTTP応答を渡して次元数と正規化を固定するテストを足す。

### 5.2 回答生成（Workers AI）← 最大の難所

`rag/llm.py` に `WorkersAiAnswerGenerator` を足す。`BedrockAnswerGenerator` と
同じ4メソッド（`answer` / `answer_stream` / `rewrite_query` / `draft_manual`）を実装する。

**難所は tool use（管理者のチャット操作）。** 現在 `ADMIN_TOOLS` の6ツール
（`create_folder` / `update_folder` / `delete_folder` / `move_manual` /
`add_classification_rule` / `reclassify_all_manuals`）を Bedrock Converse API に渡し、
モデルが返したツール名と引数JSONを `backend/src/chat/service.ts` が実行している。

作業の順序:
1. **まず tool use が動くかだけを試す**（他の実装より先に）。
   小さなスクリプトで「フォルダを作って」と投げ、`create_folder` の呼び出しが返るか見る
2. 動くなら `ADMIN_TOOLS` の形式を Workers AI の形式に変換する層を書く
3. 動かない・不安定なら下記の代替へ

代替（機能は失わない）:
- 決め打ちの命令文で直接実行する経路を増やす。`backend/src/chat/service.ts` に
  既にある方式（`/^分類ルールを?追加\s*[:：]\s*.+$/` のような正規表現で
  LLMを介さず実行）を、フォルダ作成・移動・削除にも広げる
- 「〇〇フォルダを作って」程度の定型文なら正規表現で十分拾える
- 画面側（サイドバーの＋・右クリックメニュー・ドラッグ）に全機能があるので、
  チャットから操作できないだけで機能は残る

守ること:
- SSEストリーミング（`answer_stream`）は現在の自前SSEに繋ぐ。
  形式が違えば `rag/main.py` の `/chat/stream` 側で変換する
- `[選択肢]` `[参照]` を出力させるプロンプト規約は現状のまま使う。
  モデルが変わると従わなくなることがあるので、`decide_outcome` の
  判定と併せて実際の応答で確認する
- `ADMIN_SYSTEM_ADDENDUM` / `MEMBER_SYSTEM_ADDENDUM` はそのまま渡す。
  「実行したフリ」を防ぐ安全網（`backend/src/chat/service.ts` の 4.6）は
  モデルが変わると効き方が変わるので、実際に試して調整する

### 5.3 画像理解（vision）

`rag/vision.py` に `WorkersAiTranscriber` を足す。用途は2つ。

- `transcribe()` … スキャンPDFのページを文字にする（取り込み時）
- `describe()` … 質問に添えた画像を検索キーワードにする

`MAX_TRANSCRIBE_PAGES = 30` の安全弁はそのまま維持する。
画像の渡し方（base64かバイト配列か）はモデルの仕様に合わせる。

**精度は落ちる。** 既に取り込み済みの131冊には影響しない（本文はDBにある）が、
今後スキャンPDFを追加したときの読み取りは弱くなる。運用で受け入れる前提。

### 5.4 認証（Entra ID）← 移行の落とし穴あり

#### バックエンド

`backend/src/auth/strategy.ts` の issuer / audience / JWKS URI を Entra のものに替える。
`AUTH_PROVIDER` で Cognito と切り替えられるようにしておく（切り戻し用）。

#### 🔴 落とし穴: 利用者IDが変わる

`User.cognitoSub` は Cognito の `sub` を持っている。`UserService.ensure()` は
これで upsert しているため、**Entra の識別子で入ると別人として新しい行が作られる**。
そのまま切り替えると:

- **管理者が MEMBER に落ちる**（既定値が MEMBER）
- **チャット履歴が消えたように見える**（`Conversation` は古い `User.id` に紐づく）

対策: 切り替え前に **メールアドレスで突き合わせて `cognitoSub` を書き換える**
移行スクリプトを用意する（`backend/src/scripts/migrate-user-ids.ts`）。

```
1. Entra から利用者一覧（メールアドレスと不変ID）を取得
2. User テーブルの email と突き合わせる
3. 一致した行の cognitoSub を Entra の不変IDに更新する
4. 突き合わせできなかった行は一覧で報告する（消さない）
```

**どのクレームが「不変ID」かは確認待ち**（→ 8. 参照）。
`sub` はアプリごとに変わる可能性があるため、`oid` を使うのが定石。
ここを間違えると上記の事故が起きるので、実装前に必ず確定させる。

検証: 切り替え後にまず管理者でログインし、`利用状況` 画面と過去のチャットが
見えることを確認する。見えなければ切り戻して移行スクリプトを見直す。

#### 利用者管理画面の縮小

Entra では社員アカウントが会社の名簿に既にあるため、**招待という概念が無くなる**。

- 廃止: 招待（一括招待も）・削除・仮パスワード。`src/user/cognito.ts` ごと不要
- 残す: 権限（ADMIN / MEMBER）の切り替え。これはDBの `User.role` なので現状のまま
- 一覧は「一度ログインしたことがある人」= DBの `User` から出す
  （`listManaged()` が Cognito を呼んでいる箇所を DB のみに変える）

結果として、招待メールにまつわる仕組み（Cognitoの日本語テンプレート、
SESの本番アクセス申請、DKIM設定）は**すべて不要になる**。

#### フロントエンド

`frontend/src/lib/auth.ts` の3つの環境変数を Entra 向けに差し替える。
`react-oidc-context` のまま authority を Entra に向けて動くなら改修は最小で済む
（動くかは確認待ち → 8.）。動かない場合は `@azure/msal-browser` + `@azure/msal-react` へ。

`extraQueryParams: { lang: 'ja' }` は Cognito 専用。Entra では別の指定になる。

### 5.5 メール（Microsoft Graph）

`backend/src/inquiry/service.ts` の SES 呼び出しを Graph の sendMail に替える。
`backend/src/inquiry/mail.ts` の純粋関数（`domainOf` / `canReplyTo` / `buildRawEmail`）は
テスト付きで切り出してあるので、**送信部分だけ**を差し替える。

守ること:
- 画像添付（最大5枚・1枚4MB）が通ること。合計3MBを超える場合の扱いは確認待ち（→ 8.）
- `canReplyTo` の判断（宛先と同じドメインでは Reply-To を付けない）は
  **不要になる可能性がある**。自社ドメインから送るので「なりすまし」と
  見なされる問題が消えるため。切り替え後に実際に届くか試して判断する
- 受付日時のタイムゾーン（`Asia/Tokyo`）はそのまま
- `mail.spec.ts` の14件のテストは通したまま進める

### 5.6 ストレージ（R2）

**実装変更は不要の見込み。** `src/storage/service.ts` は既に
「エンドポイント差し替え式」で書かれており、ローカルでは MinIO に向けて動いている。
R2 は S3 互換なので、4. の環境変数を入れ替えるだけ。

必ず確認すること:
- **`RAG_ALLOWED_DOWNLOAD_HOSTS` に R2 のホストを足す。** 忘れると
  取り込み（PDFのダウンロード）が全部失敗する。SSRF対策の許可リストなので気づきにくい
- presigned PUT でブラウザから直接アップロードするため、**R2側のCORS設定**が必要
- ダウンロード時にファイル名を指定している（`createDownloadUrl`）。
  R2 で `Content-Disposition` 付きのURLを発行できるか確認する
- S3のバージョニング（90日で古い版を削除）は R2 に無い。
  代替は「削除をゴミ箱経由にする」既存の仕組みで足りるか検討する

### 5.7 データベース（Supabase）

- 接続方式（直接接続 / Supavisor のトランザクションモード）の選択は確認待ち（→ 8.）。
  Cloud Run はインスタンスが増減するのでプール方式を誤ると接続が枯れる
- `prisma migrate deploy` でスキーマを作る。
  **手書きマイグレーション（HNSW・pg_trgm）が含まれるので、
  `migrate dev` は絶対に使わない**（索引のDROPが自動生成される既知の罠）
- 拡張の有効化: `create extension vector;` `create extension pg_trgm;`
- Free プランは1週間アクセスが無いと一時停止する。
  GitHub Actions で1日1回クエリを打つワークフローを用意して回避する
- バックアップ: `pg_dump` を GitHub Actions で毎晩取り、成果物として保存する
  （AWS Backup の代替）

### 5.8 画面の配信（Cloudflare Pages）

- `frontend/dist` を `wrangler pages deploy` で上げる
- SPAのフォールバック（全パスを `index.html` へ）を設定する
- 現在 CloudFront が `/graphql` を ALB に振り分けているが、Pages では
  APIが別ホスト（Cloud Run）になる。**backend 側に CORS 設定が必要**
  （`FRONTEND_ORIGIN` を使って許可する。SSEのエンドポイントも対象）
- `index.html` に直書きしている CSS（iOSのズーム防止など）はそのまま動く
- PWA のマニフェストとアイコンもそのまま。ただし**URLが変わるので
  利用者はホーム画面への追加をやり直す必要がある**

### 5.9 デプロイ（Cloud Run）

- コンテナは `PORT` 環境変数で listen する必要がある。
  backend は `process.env.PORT` を見ているので対応済み。rag（uvicorn）は確認する
- **イメージのアーキテクチャ**: 現在 ARM64 でビルドしている（`--platform linux/arm64`）。
  Cloud Run で使えるかは確認待ち（→ 8.）。使えなければ amd64 で再ビルドする
- backend → rag の呼び出しは現在 Service Connect（`http://rag:8000`）。
  Cloud Run ではサービス間認証（IDトークン付与）が必要になる。
  あわせて rag は外部から叩けない設定（内部限定）にする
- 秘密情報は Secret Manager 経由で渡す
- **SSE と「レスポンス後の裏処理」が動くかは確認待ち（→ 8.）。**
  全マニュアルの再分類は数分かかる裏処理なので、ここが成立しないと
  設計変更（ジョブを別サービスに切り出す等）が必要になる

---

## 6. データ移行の手順

```bash
# 1. 最新のバックアップを取る
./scripts/backup-all.sh
./scripts/verify-backup.sh ~/manual-search-backups/<最新>/database.dump

# 2. Supabase にスキーマを作る（migrate deploy。dev は使わない）
DATABASE_URL=<Supabase> npx prisma migrate deploy

# 3. データだけを流し込む
pg_restore --no-owner --no-acl --data-only -d <Supabaseの接続文字列> \
  ~/manual-search-backups/<最新>/database.dump

# 4. 検索索引が生きているか確認（HNSW と pg_trgm が4本）
#    無ければマイグレーションのSQLを手で流す

# 5. PDFを R2 へ
#    rclone か aws s3 sync（R2はS3互換なのでエンドポイント指定で使える）
aws s3 sync ~/manual-search-backups/<最新>/manuals/ s3://manual-search-manuals/ \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com

# 6. 利用者IDの移行（5.4 の落とし穴。Entra を使う場合は必須）
node dist/src/scripts/migrate-user-ids.js

# 7. 全チャンクの再埋め込み（AIが変わるため必須。一晩かかる）
node dist/src/scripts/reembed-all.js
```

### 7. 再埋め込みについて

- 対象は 3,349 チャンク。**PDFの読み直しは不要**（本文は `ManualChunk.content` にある）
- 無料枠（10,000ニューロン/日）の3割程度で終わる見込み
- 埋め込み空間が変わるので、**全件やり切るまで検索結果が混ざる**。
  切り替え前に完了させる。途中で止まった場合は続きから再開できるようにする
  （`embedding` が古いものを判別する印を持つか、一時列を使う）
- 終わったら HNSW 索引を作り直す（`REINDEX`）。大量更新後は性能が落ちるため
- 既存の `backend/src/scripts/reingest-all.ts` は「PDFから取り込み直す」もので別物。
  埋め込みだけを差し替えるスクリプトを新規に作る

---

## 8. 確認待ちの技術項目

移行の成否を左右するため、**実装より先に**確定させる。
（2026-08-20 時点で調査を実施中。結果はこの節に追記する）

| # | 確認すること | 外れた場合の影響 |
| --- | --- | --- |
| 1 | Workers AI で **tool use** が使えるか（対応モデルと形式） | 管理者のチャット操作を作り直す（→ 5.2 の代替） |
| 2 | bge-m3 の**次元数が1024**か | DBの列定義とHNSW索引の作り直しが必要 |
| 3 | Cloud Run が **SSE** に対応し、タイムアウトを数分に伸ばせるか | 回答の逐次表示を諦める（一括表示に戻す） |
| 4 | Cloud Run で**レスポンス後の裏処理**が続くか | 再分類を別の仕組みに切り出す |
| 5 | Entra の**不変な識別子はどのクレームか**（`oid` か `sub` か） | 管理者権限とチャット履歴を失う（→ 5.4） |
| 6 | Graph sendMail の**添付の上限**（3MB前後の境界） | 大きい画像でアップロードセッションが必要 |
| 7 | R2 が presigned PUT/GET に対応し、`region: auto` で動くか | ストレージ実装の書き直し |
| 8 | Supabase Free で **pgvector と pg_trgm** が両方使えるか | DBの移行先を変更（Neon 等） |
| 9 | `react-oidc-context` のまま Entra に向けて動くか | MSAL へ書き換え（フロントの改修が増える） |
| 10 | Cloud Run が **ARM64** イメージを扱えるか | amd64 で再ビルド |

---

## 9. 切り戻し（うまくいかなかったとき）

**クレジットを$25ほど残しておくこと**が前提。これがあれば AWS を戻せる。

```bash
./scripts/aws-start.sh    # RDSを起動してからECSを戻す
```

- 環境変数を AWS 版に戻す（`EMBEDDING_PROVIDER=bedrock` など）だけで動く状態を保つ
- ただし**埋め込みを入れ替えた後は、AWS 側のDBに戻す必要がある**
  （Supabase 側は bge-m3 のベクトルになっているため）。
  AWS のRDSは切り替え時点のまま残しておく（消さない）
- 利用者IDの移行を実行済みの場合、AWS に戻すと Cognito の sub と合わなくなる。
  移行スクリプトは**逆向きにも流せるように**作る（元の値を控えておく）

## 10. 移行後に不要になるもの

片付けの対象。移行が落ち着いてから消す。

- `backend/src/user/cognito.ts` と招待関連（`inviteMany` 等）
- `@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/client-sesv2` の依存
- `infra/cognito/invite-message.json`
- `docs/dns-request-ses-mail-domain.md`, `docs/ses-production-access-appeal.md`
  （SESの迷惑メール問題は Graph 送信で消えるため）
- `scripts/check-mail-domain.sh`
- `scripts/aws-start.sh` / `aws-stop.sh` / `backup-all.sh` / `verify-backup.sh`
  （AWS撤収後。移行先向けのバックアップに置き換える）
