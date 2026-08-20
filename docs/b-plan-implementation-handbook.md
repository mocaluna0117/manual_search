# B案 実装ハンドブック

**この文書の役割**: 移行作業に着手するとき、これ一枚を読めば手が動く状態にしておくための技術メモ。
「いつ・誰が」は [移行手順書](b-plan-migration-runbook.md) 側にある。

移行先: Cloud Run（東京）／ Supabase（東京）／ Cloudflare R2（APAC）／
Cloudflare Workers AI ／ 認証は要検討（→ 5.4）／ Cloudflare Pages。

技術仕様は2026-08-20に各社の公式ドキュメントで確認済み（→ 各節の「出典」）。
無料枠と仕様は変わるので、着手時に主要な出典を再確認する。

---

## 0. 着手時の確認

```bash
./scripts/check-credits.sh    # 残り日数。使える時間を把握する
./scripts/backup-all.sh       # 最新データを手元に取り出す(先にやる)
./scripts/verify-backup.sh ~/manual-search-backups/<最新>/database.dump
./scripts/test.sh             # backend 42件 / RAG 52件が通ることを確認
```

**AWSアカウントはクレジット枯渇と同時に閉鎖され、データを読み出せなくなる。**
バックアップが手元にあることを確認してから作業を始める。

---

## 1. 全体像

| 部品 | 現在 | 移行後 | 実装の重さ |
| --- | --- | --- | --- |
| 画面の配信 | S3 + CloudFront | Cloudflare Pages | 軽（ビルド成果物を上げる＋CORS） |
| アプリ本体 | ECS Fargate ×2 + ALB | Cloud Run ×2（東京） | **重（→ 5.9。裏処理の作り直しが要る）** |
| データベース | RDS PostgreSQL 16 | Supabase（東京） | 中 |
| PDF・画像 | S3 | Cloudflare R2（APAC） | **軽（環境変数のみ。実装変更なし）** |
| 埋め込み | Bedrock Titan V2 (1024次元) | Workers AI bge-m3 (1024次元) | 中（＋全件再埋め込み） |
| 回答生成 | Bedrock Claude Haiku 4.5 | Workers AI glm-4.7-flash | 中（**tool use は使える**） |
| 画像理解 | Bedrock Claude | Workers AI qwen3.8-27b | 中 |
| 認証 | Cognito | Entra ID か Supabase Auth | **重（→ 5.4。IDの移行に落とし穴）** |
| メール | SES | Graph か 代替（→ 5.5） | 中 |

### 調査で分かった重要な3点

1. ✅ **tool use は使える。** 管理者のチャット操作は作り直さなくてよい。
   ただし **OpenAI互換エンドポイント**を使い、モデルを差し替える（→ 5.2）
2. ⚠️ **Llama 3.3 70B は日本語が公式非対応。** Meta のモデルカードが8言語のみを挙げ、
   非対応言語の利用を明確に非推奨としている。**glm-4.7-flash に変更**（→ 5.2）
3. 🔴 **Cloud Run では「レスポンスを返した後に裏で走る処理」が止まる。**
   PDFの取り込みも再分類もこの方式なので、**8箇所の作り直しが必要**（→ 5.9）

---

## 2. AWSに依存している箇所（棚卸し）

### backend（TypeScript）

| ファイル | 依存 | 移行後 |
| --- | --- | --- |
| `src/storage/service.ts` | `@aws-sdk/client-s3`, `s3-request-presigner` | **そのまま使える**（R2はS3互換。環境変数だけ差し替え） |
| `src/inquiry/service.ts` | `@aws-sdk/client-sesv2` | 送信部分を差し替え（→ 5.5） |
| `src/user/cognito.ts` | `@aws-sdk/client-cognito-identity-provider` | 廃止か差し替え（→ 5.4） |
| `src/auth/strategy.ts` | Cognito の issuer/JWKS | 認証先を差し替え（→ 5.4） |

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
| `src/lib/auth.ts` | Cognito の OIDC 設定 | 認証先を差し替え |
| `src/components/layout/UserManagementDialog.tsx` | 招待・削除 | 認証方式によって縮小（→ 5.4） |

**方針**: 既存の Bedrock / Cognito / SES 実装は消さない。環境変数で選べるようにして、
`EMBEDDING_PROVIDER=bedrock` に戻せば AWS 版として動く状態を保つ（切り戻しの保険）。

---

## 3. 作業の順番

```
1. Supabase を用意（DBが無いと何も動かない）
2. R2 を用意（環境変数だけ）
3. Workers AI の埋め込み・回答生成・画像理解を実装（ローカルで検証可）
   ← ここは AWS を動かしたまま並行して進められる。最初に着手する
4. 裏処理の作り直し（Cloud Run Jobs / Cloud Tasks 化）← 実は3と並ぶ大仕事
5. 認証（方式が決まってから）
6. メール
7. Cloud Run へデプロイ（amd64・タイムアウト・サービス間認証）
8. Cloudflare Pages へ配信（＋CORS）
9. 本番データの移行 → 全件再埋め込み → 検証 → 切り替え
```

---

## 4. 移行後の環境変数

### rag

```bash
EMBEDDING_PROVIDER=workers_ai
ANSWER_PROVIDER=workers_ai
CF_ACCOUNT_ID=<CloudflareのアカウントID>
CF_API_TOKEN=<Workers AI の実行権限を持つトークン>
# OpenAI互換の入口。openai SDK の base_url にこれを渡す
CF_AI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1
CF_EMBEDDING_MODEL=@cf/baai/bge-m3
CF_CHAT_MODEL=@cf/zai-org/glm-4.7-flash
CF_VISION_MODEL=@cf/qwen/qwen3.8-27b

DATABASE_URL=<Supabaseの接続文字列。→ 5.7>
# DATABASE_SSL_CA は不要（RDS専用。Supabaseは公的CAで検証できる）

# PDFの取得元を絞る安全弁。R2のホストを必ず足す
# 忘れると取り込みが全部失敗する(SSRF対策の許可リストなので気づきにくい)
RAG_ALLOWED_DOWNLOAD_HOSTS=<accountid>.r2.cloudflarestorage.com
```

### backend

```bash
# ストレージ(R2) — 実装変更なし、値だけ差し替え
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_REGION=auto            # R2は常に auto(SDKが要求するが R2 は使わない)
S3_BUCKET=manual-search-manuals
S3_ACCESS_KEY=<R2のアクセスキー>
S3_SECRET_KEY=<R2のシークレット>
S3_FORCE_PATH_STYLE=true

FRONTEND_ORIGIN=https://<Pagesのドメイン>   # CORSに使う
RAG_SERVICE_URL=https://<ragのCloud Run URL>
# 認証・メールの環境変数は 5.4 / 5.5 で方式が決まってから確定させる
```

**Secret Manager の無料枠は「有効なバージョン6個まで」**なので、
上記の秘密は**1つのJSONにまとめてボリュームマウント**する（→ 5.9）。

---

## 5. 各作業の詳細

### 5.1 埋め込み（Workers AI bge-m3）

`rag/embedding.py` に `WorkersAiEmbedder` を足し、`create_embedder()` に分岐を増やす。

✅ **確認済み: bge-m3 は 1024 次元**（Titan V2 と同じ。`vector(1024)` と HNSW索引は
そのまま流用でき、DBのDDL変更は不要）。
出典: Cloudflare AI Search の supported-models 表。上流モデルの `config.json` も
`hidden_size=1024`。

⚠️ **入力長の記載が食い違っている。** モデルページは「Context Window 60,000 tokens」だが
AI Search の表は「512 input tokens」。**着手時に実測して確認する。**
現在のチャンクは平均330文字（日本語なので250〜400トークン相当）で 512 に近いので、
超えるなら分割する。切り捨てられると検索精度が静かに落ちる。

**移行方法（重要）**: 既存の `embedding` 列を上書きしない。列を足して切り替える。

```
1. embedding_v2 vector(1024) 列を追加
2. bge-m3 で全チャンクを埋め込んで新列に入れる
3. 新列に HNSW(vector_cosine_ops) を作る
4. 検索の参照を新列に切り替える
5. 動作確認後に旧列と旧索引を削除する
```

途中で混ざらないよう、`embedding_model` 列を持たせて検索側で固定するのが安全。

守ること: タイムアウトとリトライを明示（`bedrock.py` と同じ考え方）。
正規化されていなければ自前で正規化する。
失敗時は例外を投げる（**静かに0ベクトルを返してはいけない**。壊れたことに気づけない）。

### 5.2 回答生成（Workers AI）

✅ **tool use は使える。管理者のチャット操作は作り直さなくてよい。**

出典: Workers AI モデルカタログ（Function calling バッジ付きが18モデル）、
traditional function calling のドキュメント。

#### 決定事項1: OpenAI互換エンドポイントを使う

`/ai/run/{model}`（ネイティブ）ではなく
**`/ai/v1/chat/completions`** を使う。理由:

- ストリーミング中の `finish_reason: "tool_calls"` が保証されるのはこちらだけ
- `tool_call_id` による多ターンの往復が正式サポート
- Python 側は `openai` SDK の `base_url` を差し替えるだけで済む

#### 決定事項2: モデルを Llama から変える

⚠️ **`@cf/meta/llama-3.3-70b-instruct-fp8-fast` は日本語が公式非対応。**
Meta のモデルカードの対応言語は英・独・仏・伊・葡・ヒンディー・西・タイの8言語で、
非対応言語での利用を「強く非推奨」としている。日本語の社内マニュアルには使えない。
加えてコンテキスト長が 24,000 しかなく、6ツール＋抜粋＋履歴を積むと窮屈。

| 用途 | モデル | 理由 |
| --- | --- | --- |
| 回答生成・管理操作 | `@cf/zai-org/glm-4.7-flash` | 100言語以上のtool callingに最適化、131,072ctx、$0.06/$0.40（Llamaの約1/5） |
| 画像を伴う質問 | `@cf/qwen/qwen3.8-27b` | 公式の119言語に日本語が明記、262,144ctx、function calling + vision |

単価が1/5になるので、**無料枠（1日10,000ニューロン）に収まる余裕も増える**
（現在の利用は最大27問/日。glm-4.7-flash なら1日数千ニューロン程度の見込み）。

#### 決定事項3: tool_calls のパーサは3形式に対応させる

モデルによってレスポンス形状が3種類ある。**正規化を1箇所に置く。**

```ts
// 3形式(フラット / ネスト / OpenAI互換)を吸収する
const raw = body.tool_calls ?? body.choices?.[0]?.message?.tool_calls ?? [];
const calls = raw.map((t) => {
  const fn = t.function ?? t;               // ネストとフラットを吸収
  const args = typeof fn.arguments === 'string'
    ? JSON.parse(fn.arguments || '{}')      // OpenAI互換は文字列
    : (fn.arguments ?? {});                 // 旧形式はオブジェクト
  return { name: fn.name, input: args };
});
```

ツール定義は **OpenAI のネスト形式**（`{type:"function", function:{name, description, parameters}}`）
で送る。全モデル・全エンドポイントで通る唯一の形。
各引数に `description` が必須なので、`ADMIN_TOOLS` の変換時に落とさないこと。

#### 決定事項4: `tool_choice: "required"` を信用しない

公式実装のコメントに「advisory であり長いコンテキストでは fails open（散文で答えてしまう）」
と明記されている。確実に呼ばせたい操作では
`{"type":"function","function":{"name":"create_folder"}}` の名前指定にする（これはサーバ側で強制される）。

加えて `finish_reason` が `tool_calls` であることを検証し、
`stop` で返ってきたのにツールが呼ばれていない場合をエラー扱いにする。
**成功表示のソースは常に「NestJSが実際に実行した結果」にする**
（既存の「実行したフリ」対策 = `backend/src/chat/service.ts` の 4.6 と同じ考え方）。

#### 決定事項5: SSE は2形式をパースする

- 旧形式: `data: {"response":"トークン"}` … `data: [DONE]` で終端
- 新形式（OpenAI互換）: `data: {"choices":[{"delta":{"content":"トークン"}}]}`

**片方だけ実装するとモデル差し替えで無音になる。**両方拾う。
ストリーミング中の `tool_calls` も形式が異なる（ネイティブは直下、OpenAI互換は `delta.tool_calls` の index 差分）。

#### そのほか

- Text Generation は既定 300 req/min（社員30名なら十分）
- 無料枠は1日10,000ニューロン。超過分は $0.011/1,000ニューロン。
  B案はカード登録済みなので、超えても数円で済む（「実質0円」の範囲）
- `[選択肢]` `[参照]` を出させるプロンプト規約と `ADMIN_SYSTEM_ADDENDUM` は
  そのまま渡すが、**モデルが変わると従い方が変わる**。実際の応答で確認して調整する
- `rag/eval_search.py` を回して、移行前後の Hit@1 / MRR を比べる（回帰の検知）

### 5.3 画像理解（vision）

`rag/vision.py` に `WorkersAiTranscriber` を足す。用途は2つ。

- `transcribe()` … スキャンPDFのページを文字にする（取り込み時）
- `describe()` … 質問に添えた画像を検索キーワードにする

モデルは `@cf/qwen/qwen3.8-27b`（日本語＋vision＋function calling）。
`MAX_TRANSCRIBE_PAGES = 30` の安全弁はそのまま維持する。

**精度は落ちる。** 既に取り込み済みの131冊には影響しない（本文はDBにある）。

### 5.4 認証

#### 🔴 どちらの方式でも共通の落とし穴: 利用者IDが変わる

`User.cognitoSub` は Cognito の `sub` を持ち、`UserService.ensure()` はこれで
upsert している（`backend/src/user/service.ts:26`）。新しい認証方式の識別子で入ると
**別人として新しい行が作られる**。そのまま切り替えると:

- **管理者が MEMBER に落ちる**（既定値が MEMBER）
- **チャット履歴が消えたように見える**（`Conversation` は古い `User.id` に紐づく）

対策: 切り替え前に **メールアドレスで突き合わせて識別子を書き換える**
移行スクリプト（`backend/src/scripts/migrate-user-ids.ts`）を用意する。

```
1. 新しい認証先から利用者一覧(メールアドレスと不変ID)を取得
2. User テーブルの email と突き合わせる
3. 一致した行の識別子を新しい不変IDに更新する(旧値は控えておく = 切り戻し用)
4. 突き合わせできなかった行は一覧で報告する(消さない)
```

検証: 切り替え後にまず管理者でログインし、`利用状況` 画面と過去のチャットが
見えることを確認する。見えなければ切り戻して移行スクリプトを見直す。

#### 案1: Entra ID（会社のM365）

会社の承認が得られる場合。追加費用ゼロ、パスワードが増えない、退職者の停止が人事手続きだけで済む。

✅ **確認済み: 不変な識別子は `oid`。`sub` はアプリごとに変わる**ので使ってはいけない。
出典: Entra ID の ID token claims reference。
`oid` は「同じユーザーに対して異なるアプリでも同じ値」「GUIDで再利用されない」と明記。

推奨スキーマ（テナントIDとの複合キーにする）:

```prisma
model User {
  id       String @id @default(uuid())
  entraTid String                      // テナントの固定GUID
  entraOid String                      // 利用者の不変ID
  email    String                      // 表示専用。突き合わせに再利用しない
  @@unique([entraTid, entraOid])
}
```

その他: アプリ登録とMail.Sendの管理者同意はIT管理者の作業。
`react-oidc-context` のまま authority を Entra に向けられるかは着手時に試す
（動けば改修が最小。動かなければ `@azure/msal-browser` へ）。
`extraQueryParams: { lang: 'ja' }` は Cognito 専用なので Entra 用の指定に変える。

#### 案2: Supabase Auth（会社の承認が不要）

**2026-08-20時点では、会社のメールアドレス利用の承認が得られない見込みのため、
こちらが本線になる可能性が高い。**

- **いまと全く同じ方式**（メールアドレスで招待 → パスワードを設定してログイン）
- 無料・50,000人まで。DBに使う Supabase に含まれるので、増えるサービスはない
- 失うのは「パスワードを覚えなくていい」利点だけ
- Cognitoからパスワードは取り出せない仕様なので、**現在の8名は再設定が必要**（招待の再送）
- ⚠️ Supabase の**組み込みメール送信には厳しい送信制限**があり、
  外部のSMTPを設定するのが前提になる可能性が高い（**着手時に要確認**）。
  ここは 5.5 のメール手段と一体で決める

#### 利用者管理画面

- **Entra IDの場合**: 招待という概念が無くなる（社員は会社の名簿にいる）。
  招待・削除・仮パスワードを廃止し、`src/user/cognito.ts` ごと不要。
  権限（ADMIN/MEMBER）の切り替えだけ残す。一覧はDBの `User` から出す
- **Supabase Authの場合**: 現在の画面の構成をほぼ維持できる。
  `cognito.ts` を Supabase Admin API 呼び出しに差し替える

### 5.5 メール

⚠️ **現在、問い合わせを見る画面がアプリ内に無く、メールが唯一の受け取り経路**
（データはDBの `Inquiry` に26件たまっている）。
メールが送れないと問い合わせに気づけないので、**アプリ内に一覧画面を作ることを推奨**
（半日程度。データは既にあるので表示するだけ。メールを見落としても後から追える）。

送信手段は方式によって変わる。

#### 案1: Microsoft Graph sendMail（会社の承認が要る）

✅ 確認済み: `POST /users/{id}/sendMail`、成功は **202 Accepted**（messageIdは返らない）。
権限は `Mail.Send` のみでよい。添付は本文にインラインで入れられるが**合計3MB未満**。
出典: Microsoft Graph の user: sendMail リファレンス。

**推奨: 添付をやめて R2 の期限付きリンクを本文に貼る。**
画像はもともとR2に入っているので、3MB制限・アップロードセッション・
Exchangeの35MB制限を全部回避でき、1回の呼び出しで済む。
Cloud Run 側で画像を読み戻して base64 する処理も不要になる（コールドスタートにも有利）。

#### 案2: 会社の承認が得られない場合

- 無料のメール送信サービス（Resend・Brevo など。月数千通まで無料）
- ただし自社ドメインから送るにはDNS設定が必要。それも通らないなら
  「外部サービスのドメインから会社アドレス宛」になり、**今と同じ迷惑メール問題が残る**
- 会社がTeamsを使っているなら、**Teamsのチャンネルへの通知**（Incoming Webhook）が
  確実。チャンネルの持ち主が自分で作れる場合が多く、IT管理者の承認が不要なことがある

#### 共通

`backend/src/inquiry/mail.ts` の純粋関数（`domainOf` / `canReplyTo` / `buildRawEmail`）は
テスト付きで切り出してあるので、**送信部分だけ**を差し替える。
`mail.spec.ts` の14件は通したまま進める。
`canReplyTo`（同じドメイン宛にはReply-Toを付けない）は、自社ドメインから送れるなら不要になる。
受付日時のタイムゾーン（`Asia/Tokyo`）はそのまま。

### 5.6 ストレージ（R2）

✅ **実装変更は不要。** `src/storage/service.ts` は既にエンドポイント差し替え式で、
ローカルでは MinIO に向けて動いている。R2 も S3 互換なので 4. の環境変数を入れ替えるだけ。

確認済み（出典: Cloudflare R2 の S3 API 互換ドキュメント）:
- `region: "auto"` を指定する（SDKが要求するが R2 は使わない）
- endpoint は `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`（バケット名は含めない）
- presigned URL は PUT と GET の両方に対応。有効期限は最大7日

必ずやること:
- **`RAG_ALLOWED_DOWNLOAD_HOSTS` に R2 のホストを足す**（忘れると取り込みが全滅）
- **R2側のCORS設定**（ブラウザから presigned PUT で直接アップロードするため）
- ダウンロード時のファイル名指定（`Content-Disposition`）が効くか確認
- presigned URL は S3 APIドメイン専用。**カスタムドメインでは使えない**
- S3のバージョニング（90日で古い版を削除）は R2 に無い。
  既存の「削除はゴミ箱経由」の仕組みで足りるか検討する
- **アップロードは presigned PUT 方式を維持する。** backend 経由にすると
  Cloud Run の「HTTP/1リクエスト最大32MiB」に当たる（大きいPDFが上がらない）

### 5.7 データベース（Supabase）

✅ 確認済み: Free プランでも `vector` と `pg_trgm` を有効化でき、HNSW索引も作れる
（プランによる拡張の制限は無い）。出典: Supabase の Postgres Extensions ドキュメント。

⚠️ **search_path の罠。** Supabase は拡張を `extensions` スキーマに入れる運用なので、
`vector` 型・`<=>` 演算子・`gin_trgm_ops` が `public` に無い。
マイグレーションと接続時の `search_path` を明示する。

```sql
create extension if not exists vector  with schema extensions;
create extension if not exists pg_trgm with schema extensions;
```

その他:
- **`prisma migrate dev` は絶対に使わない**（手書きのHNSW/pg_trgm索引に対して
  DROP文を自動生成する既知の罠）。`migrate deploy` のみ
- 接続方式（直接接続 5432 / Supavisor のトランザクションモード 6543）は
  Cloud Run がインスタンスを増減させるためプール方式の選択が重要。
  トランザクションモードではプリペアドステートメントを無効化する必要がある
- Free は1週間アクセスが無いと一時停止する。
  GitHub Actions で1日1回クエリを打って回避する
- バックアップは GitHub Actions で毎晩 `pg_dump` を取り、成果物として保存する

### 5.8 画面の配信（Cloudflare Pages）

- `frontend/dist` を `wrangler pages deploy` で上げる
- SPAのフォールバック（全パスを `index.html` へ）を設定する
- APIが別ホスト（Cloud Run）になるので **backend 側に CORS 設定が必要**。
  `FRONTEND_ORIGIN` を使う。**SSEのエンドポイントも対象**
- `index.html` 直書きのCSS（iOSのズーム防止など）はそのまま動く
- PWAのマニフェストとアイコンもそのまま。ただし**URLが変わるので
  利用者はホーム画面への追加をやり直す**

### 5.9 🔴 Cloud Run（最大の作業）

#### (a) レスポンス後の裏処理が止まる

✅ 確認済み: 既定（request-based billing）では
「リクエスト処理が終わるとインスタンスのCPUアクセスは無効化または厳しく制限される」。
公式に「バックグラウンド処理を避けよ」と明記。
`--no-cpu-throttling`（instance-based）にしても `min-instances=0` では保証されない。
出典: Cloud Run の一般的な開発のヒント／課金ドキュメント。

**該当箇所は8つ。** これが移行で最も手のかかる部分。

| 場所 | 内容 | 所要 | 対処 |
| --- | --- | --- | --- |
| `manual/service.ts:207,270,303` | `void this.runIngest` — **PDFの取り込み**（本文抽出・チャンク分割・埋め込み・スキャンPDFの書き起こし） | 数十秒〜数分 | **Cloud Tasks** で内部エンドポイントを叩く（無料枠 月100万操作） |
| `manual/service.ts:428` | `void this.reclassifyAll` — 全件再分類 | 数分 | **Cloud Run Jobs**（常にinstance-based、タイムアウト最大168時間） |
| `manual/service.ts:884` | `void this.rag.reembedTitle` — 改名後の再埋め込み | 数秒 | そのまま `await` する（短いので同期化でよい） |
| `chat/service.ts:815` | `void this.appendAssistantMessage` — 再分類の完了通知 | 即時 | 再分類のJob側に移す |
| `manual/service.ts:61,63` | `void this.purgeExpiredTrash` — 起動時のゴミ箱掃除 | 数秒 | 起動時なので概ね問題ないが、**Cloud Scheduler**（無料枠3ジョブ）に出すのが正しい |

#### (b) 進捗の持ち方を変える

再分類の進捗が `this.reclassifyJob`（`manual/service.ts:386`）という
**インスタンス内のメモリ**にあり、GraphQLでポーリングしている。
Cloud Run は複数インスタンスに増えるので、**別のインスタンスに当たると
常に `running:false` が返り進捗表示が壊れる**（コード自身のコメントも
「単一コンテナ前提の簡易ジョブ管理」と認めている）。

対処: 進捗をDBのテーブルに移す。

```sql
create table reclassify_jobs (
  id uuid primary key default gen_random_uuid(),
  running boolean not null,
  moved_count int not null default 0,
  created_categories jsonb, emptied_categories jsonb,
  moved_to_locked jsonb, skipped_locked jsonb,
  error text, started_at timestamptz, finished_at timestamptz
);
```

`reclassifyStatus` リゾルバは最新行を読む。GraphQLの型は変えずに済む。

#### (c) その他の確定事項

| 項目 | 内容 |
| --- | --- |
| **アーキテクチャ** | ⚠️ **ARM64は使えない。** Cloud Run は linux/amd64 のみ。`docker buildx build --platform linux/amd64` で再ビルドする（Dockerfileの中身は変更不要）。ARM Macからのクロスビルドは遅いので `gcloud builds submit`（Cloud Build、amd64ネイティブ）が速い |
| **SSE** | ✅ 対応。設定不要。条件は `Transfer-Encoding: chunked`（= Content-Length を付けない）。既存の `: keepalive` ハートビートは維持する |
| **タイムアウト** | 既定300秒。`--timeout=1800` にする。**手前（backend）≧ 奥（rag）**にしないと手前で504になる |
| **サービス間認証** | 第1段階は rag を `--ingress all --no-allow-unauthenticated`（URLは公開だがIDトークン無しでは401）。第2段階で `--vpc-egress=private-ranges-only` ＋ `--ingress internal`。`all-traffic` にするとCloud NATが必要で課金される |
| **秘密情報** | Secret Manager の無料枠は**有効バージョン6個まで**。関連する値を1つのJSONにまとめて `--update-secrets=/etc/secrets/app.json=...` でマウントし、起動時にパースする |
| **コールドスタート** | 両サービスに `--cpu-boost` を付ける。rag側はモジュールトップレベルの重い初期化を lifespan か遅延importに移す。`min-instances>=1` は無料枠を食うので避ける |
| **HTTP/2** | `--use-http2` は**付けない**。`stream-controller.ts:48` の `Connection: keep-alive` がHTTP/2では禁止ヘッダになる |
| **liveness probe** | 第1段階では設定しない（SSE中に応答できずSIGKILLされ、進行中のストリームが全部切れる恐れ） |
| **Dockerfile** | RDSのCA証明書をビルド時に外部から取得している行（backend/rag 両方）を削除する。Supabaseは公的CAで検証できる。ビルド時の外部依存はCloud Buildで詰まる要因にもなる |
| **PORT** | `PORT` 環境変数でlistenすること。backendは対応済み。rag（uvicorn）は確認する |
| **Artifact Registry** | 無料枠0.5GB。古いタグを自動削除するクリーンアップポリシーを設定する。移行でboto3が不要になるのでrag側のイメージも小さくできる |

---

## 6. データ移行の手順

```bash
# 1. 最新のバックアップを取る
./scripts/backup-all.sh
./scripts/verify-backup.sh ~/manual-search-backups/<最新>/database.dump

# 2. Supabase に拡張とスキーマを作る(migrate deploy。dev は使わない)
DATABASE_URL=<Supabase> npx prisma migrate deploy

# 3. データだけを流し込む
pg_restore --no-owner --no-acl --data-only -d <Supabaseの接続文字列> \
  ~/manual-search-backups/<最新>/database.dump

# 4. 検索索引(HNSW と pg_trgm が4本)が生きているか確認

# 5. PDFを R2 へ(R2はS3互換なのでエンドポイント指定で使える)
aws s3 sync ~/manual-search-backups/<最新>/manuals/ s3://manual-search-manuals/ \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com

# 6. 利用者IDの移行(5.4 の落とし穴。必須)
node dist/src/scripts/migrate-user-ids.js

# 7. 全チャンクの再埋め込み(AIが変わるため必須。一晩)
node dist/src/scripts/reembed-all.js
```

### 再埋め込みについて

- 対象は 3,349 チャンク。**PDFの読み直しは不要**（本文は `ManualChunk.content` にある）
- 無料枠の3割程度で終わる見込み（bge-m3 は $0.012/100万トークン）
- **新しい列に入れて切り替える**（5.1 の手順）。途中で止まっても続きから再開できる
- 終わったら HNSW索引を作る。大量更新後は `REINDEX` する
- 既存の `reingest-all.ts` は「PDFから取り込み直す」もので別物。新規に作る

---

## 7. 切り替え後の検証

- [ ] ログインできる（管理者・一般の両方）
- [ ] **管理者の権限とチャット履歴が残っている**（5.4 の落とし穴の確認）
- [ ] キーワード検索でマニュアルが出る
- [ ] AIに質問して、正しいマニュアルを根拠に回答が返る（`rag/eval_search.py` で移行前後を比較）
- [ ] 回答がトークン単位で流れてくる（SSE）
- [ ] PDFが開ける（PC・スマホ）
- [ ] マニュアルをアップロードでき、**取り込みが完了する**（Cloud Tasks 化の確認）
- [ ] 全件再分類が完走し、進捗が正しく表示される（Jobs＋DB化の確認）
- [ ] 鍵付きフォルダが一般利用者に見えない（MEMBERアカウントで確認）
- [ ] 管理者のチャット操作（フォルダ作成・移動・削除・鍵の切替）が動く
- [ ] 問い合わせが管理者に届く（メールか、アプリ内一覧か、Teams通知）
- [ ] 👍/👎と利用状況の画面が動く

## 8. 切り戻し

**クレジットを$25ほど残しておくこと**が前提。これがあれば AWS を戻せる。

```bash
./scripts/aws-start.sh    # RDSを起動してからECSを戻す
```

- 環境変数を AWS 版に戻す（`EMBEDDING_PROVIDER=bedrock` など）だけで動く状態を保つ
- **AWSのRDSは切り替え時点のまま残す（消さない）**。
  Supabase側は bge-m3 のベクトルになっているため、DBごと戻す必要がある
- 利用者IDの移行スクリプトは**逆向きにも流せるように**作る（旧値を控えておく）

## 9. 移行後に不要になるもの

- `backend/src/user/cognito.ts`（Entra IDの場合は招待関連ごと）
- `@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/client-sesv2` の依存
- rag の `boto3`（イメージが小さくなる）
- 両Dockerfileの RDS CA 取得処理と `/app/certs`
- `infra/cognito/invite-message.json`
- `docs/dns-request-ses-mail-domain.md`, `docs/ses-production-access-appeal.md`,
  `scripts/check-mail-domain.sh`（SESの迷惑メール問題ごと消えるため）
- `scripts/aws-*.sh`, `backup-all.sh`, `verify-backup.sh`（撤収後。移行先向けに作り直す）
