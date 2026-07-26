# AWS本番デプロイ計画書

個人AWSアカウント（無料プラン・$200クレジット）への初回デプロイ計画。
将来の会社アカウント移行を見据え、手順・コスト・設計判断を記録する。

## 1. 全体アーキテクチャ

```
[ブラウザ]
   │ HTTPS (xxx.cloudfront.net)
   ▼
[CloudFront] ─── /* ────────▶ [S3: フロントバケット] Reactビルド成果物
   │
   └── /graphql ────────────▶ [ALB] ─▶ [ECS Fargate: backend]
                                            │
                                            ├─▶ [RDS PostgreSQL 16 + pgvector]
                                            ├─▶ [S3: manualsバケット] PDF本体
                                            └─▶ [ECS Fargate: rag] ─▶ [Bedrock]
                                                 (Titan Embeddings V2 / Claude Haiku jp.)
[Cognito User Pool] ← 既存のものを継続利用(コールバックURLにCloudFrontドメインを追加)
```

### なぜこの形か

| 判断 | 理由 |
| --- | --- |
| フロントは S3 + CloudFront | SPA配信の定番。月$1未満、HTTPS付き、コンテナ不要 |
| CloudFront が必須 | Cognitoのコールバックは localhost 以外 **HTTPS必須**。独自ドメイン無しでHTTPSを得る最も手軽な手段 |
| CloudFront を API の前にも置く | フロントとAPIが同一ドメインになり CORS 問題も消える。ALBは`*.cloudfront.net`の証明書を持てないため、CF→ALB間はHTTP(閉域) |
| ragサービスは非公開 | ALBに繋がず、backendからのみサービス間通信(Service Connect / 内部DNS)で到達 |
| RDSは非公開サブネット相当 | セキュリティグループで「backendとragのSGからの5432のみ許可」 |

## 2. フェーズ分割（1フェーズずつ検証しながら進める）

### フェーズ1: ECR（コンテナ置き場）
- ECRリポジトリを2つ作成: `manual-search/backend`, `manual-search/rag`
- ローカルでビルドしたイメージをタグ付けしてpush
- 注意: Apple Silicon Macなので **`--platform linux/amd64`** でビルドし直す（Fargateの標準はamd64。arm64指定も可能だが、まずは定番で）
- コスト: ~$0.1/GB/月。ほぼ無料

### フェーズ2: S3バケット
- `manuals`用バケット（PDF本体。非公開・presigned URLでのみアクセス）
  - CORS設定: CloudFrontドメインからのPUT/GETを許可（ブラウザ直アップロードのため）
- フロント配信用バケット（CloudFront経由でのみ公開: OAC設定）
- コスト: ほぼ無料

### フェーズ3: RDS（PostgreSQL + pgvector）
- db.t4g.micro / gp3 20GB / PostgreSQL 16
- パスワードは Secrets Manager に保存（環境変数直書きしない）
- セキュリティグループ: ECSタスクのSGからのみ 5432 を許可
- 初期化: `CREATE EXTENSION vector` → `prisma migrate deploy`（ECSの一時タスク or ローカルから踏み台的に実行）
- コスト: **~$21/月（最大の固定費その1）**

### フェーズ4: ECS Fargate（backend + rag）
- クラスター作成 → タスク定義2つ → サービス2つ
- **タスクロール**（重要な学び）: S3・Bedrockへの権限はIAMロールで付与。
  アクセスキーをコンテナに入れない。ローカルの`~/.aws`マウントは本番では不要になる
- 環境変数のうち秘密のもの（DATABASE_URL等）は Secrets Manager 参照で注入
- ログは CloudWatch Logs へ（`awslogs`ドライバ）
- ALB: ターゲットグループ(backend:3000) + ヘルスチェック(`/graphql`はPOSTなので、`@Public`なhealthを叩けるGET経路 or ALBヘルスチェック用の軽いHTTPエンドポイントを用意)
- コスト: Fargate×2 ~$22/月 + **ALB ~$18/月（固定費その2）**

### フェーズ5: フロント配信 + Cognito更新
- `npm run build`（VITE_*は本番URLでビルド）→ S3へアップロード
- CloudFront: オリジン2つ（S3 + ALB）、`/graphql`だけALBへルーティング
- SPAフォールバック: 403/404 → `/index.html`（nginx.confのtry_filesと同じ役割）
- Cognitoアプリクライアントのコールバック/ログアウトURLに `https://xxx.cloudfront.net` を追加
- backendの `FRONTEND_ORIGIN` をCloudFrontドメインに設定

### フェーズ6: E2E検証 + 運用スクリプト
- 本番URLでログイン→アップロード→取り込み→AI検索→履歴の全動線を確認
- 停止/再開スクリプト（節約用）:
  - 停止: ECSサービスのdesiredCount=0 + RDS停止（※RDSの停止は7日で自動再開される仕様に注意）
  - 再開: 逆の操作
- 完全撤収(teardown)手順も記録しておく

## 3. コスト（東京リージョン・概算）

| リソース | 常時起動 | 停止中 |
| --- | --- | --- |
| RDS db.t4g.micro + 20GB | ~$21/月 | ~$2/月(ストレージのみ) |
| Fargate ×2 (0.25vCPU/0.5GB) | ~$22/月 | $0 (desiredCount=0) |
| ALB | ~$18/月 | ~$18/月(削除しない限り発生) |
| CloudFront/S3/ECR/Cognito/Bedrock | ~$2/月 | ~$1/月 |
| **合計** | **~$63/月** | **~$21/月** |

- $200クレジット → 常時起動で約3ヶ月、こまめに停止すれば6ヶ月(アカウント期限)まで持つ
- ALBが「止められない固定費」なので、長期休止するならALBだけ削除→再作成が有効

## 4. セキュリティ設計の要点

- **公開されるのはCloudFrontだけ**。ALBはCloudFrontからのみ、RDS/ragは内部からのみ
- ECSタスクロールに最小権限（S3の対象バケットのみ / bedrock:InvokeModelのみ）
- 秘密情報は Secrets Manager（DBパスワード、必要ならCognito設定）
- ⚠️ 個人アカウントの間は**ダミーPDFのみ**。実マニュアルは会社アカウント移行後

## 5. 会社アカウント移行時にやること（差分）

1. 本計画のフェーズ1〜6を会社アカウントで再実行（手順はこのリポジトリのチャット/ドキュメントに記録済み）
2. Cognitoに **Microsoft Entra ID をフェデレーション**（「Microsoftでサインイン」ボタン）
3. 独自ドメイン + ACM証明書（`manuals.会社ドメイン` など）
4. 実マニュアル投入・管理者ロールの割当ルール決定
5. （推奨）ここまでのCLI手順を IaC（Terraform / CDK）に書き起こして再現性を確保

## 6. 未決事項

- [ ] 運用モード（常時起動 or 使うときだけ）→ フェーズ3着手前に決定
- [ ] ALBヘルスチェック用エンドポイントの実装方式（フェーズ4で決定）
- [ ] rag→backend間のサービスディスカバリ方式（Service Connect想定）
