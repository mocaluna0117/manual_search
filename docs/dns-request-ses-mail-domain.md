# DNSレコード追加のお願い（システムからの送信メール用）

社内マニュアル検索システムが送るメール（問い合わせの通知・利用者への招待）が
**迷惑メールに振り分けられてしまう**ため、送信元を自社ドメインに変更します。
そのために `takamatsu-build.co.jp` のDNS（ConoHaで管理されています）へ
以下の **CNAMEレコード3件** の追加をお願いします。

## 追加するレコード

| # | 種別 | 名称（ホスト名） | 値 | TTL |
| --- | --- | --- | --- | --- |
| 1 | CNAME | `2ahtahkxn5s2b3kf2oelfehqyuzhaupu._domainkey.mail` | `2ahtahkxn5s2b3kf2oelfehqyuzhaupu.dkim.amazonses.com.` | 3600 |
| 2 | CNAME | `ps3hylrpqpsuq35hdivy4uv2ygdf7tku._domainkey.mail` | `ps3hylrpqpsuq35hdivy4uv2ygdf7tku.dkim.amazonses.com.` | 3600 |
| 3 | CNAME | `aou7c32nh52osrjmnrt6rsgvf7zq6scf._domainkey.mail` | `aou7c32nh52osrjmnrt6rsgvf7zq6scf.dkim.amazonses.com.` | 3600 |

- 名称はゾーン相対（`takamatsu-build.co.jp` を除いた部分）で記載しています。
  管理画面がFQDNでの入力を求める場合は、末尾に `.takamatsu-build.co.jp` を補ってください
  - 例: `2ahtahkxn5s2b3kf2oelfehqyuzhaupu._domainkey.mail.takamatsu-build.co.jp`
- 値の末尾のドット（`.`）は、管理画面が受け付けない場合は省いて問題ありません
- 3件すべてが必要です（署名鍵の入れ替えに備えて3本用意される仕組みです）

## 役割

**電子署名（DKIM）の鍵の公開**です。受信側のメールサーバーが
「このメールは本当に takamatsu-build.co.jp から送られたものか」を
この鍵で検証します。検証が通ると、迷惑メール扱いされにくくなります。

現在はAWS側の共有アドレス（`no-reply@verificationemail.com` など）から
送られており、署名が自社ドメインと結びついていないため、
Gmailや Microsoft 365 が迷惑メールと判断していました。

追加後は、システムからのメールが
**`no-reply@mail.takamatsu-build.co.jp`** から届くようになります。

## 影響範囲

- **既存のメール送受信には影響しません。**
  普段お使いのメール（Microsoft 365）の設定である **MXレコード・SPFレコードは
  一切変更しません**。追加するのは `mail` サブドメイン配下の署名鍵3件だけです
- `mail.takamatsu-build.co.jp` というサブドメインでメールを受信することはありません
  （送信専用です）
- レコードは**削除せず残してください**。削除すると署名の検証が通らなくなり、
  迷惑メールに戻ります

## 追加後の作業（システム側）

DNSに反映されると、AWS側が自動で検証を完了します（通常は数分〜数時間）。
その後、システム側で送信元の切り替えを行います。

- 確認コマンド: `aws sesv2 get-email-identity --email-identity mail.takamatsu-build.co.jp`
  → `DkimAttributes.Status` が `SUCCESS` になれば完了
- 切り替え対象
  1. 問い合わせメールの差出人（`INQUIRY_FROM_EMAIL`）
  2. Cognitoの招待メール（`--email-configuration EmailSendingAccount=DEVELOPER`）

> ⚠️ Cognitoの招待メールをSES経由に切り替えるのは、**SESの本番アクセスが
> 承認されたあと**に行うこと。サンドボックス中は「事前に登録したアドレス」
> にしか送れないため、新しく招待する人へメールが届かなくなる。

### 問い合わせメールは本番アクセスを待たずに切り替えられる

宛先が管理者2名（どちらもSESに登録済み）に固定されているため、
サンドボックスのままでも送れる。DNSの反映が終わり次第、
`INQUIRY_FROM_EMAIL=no-reply@mail.takamatsu-build.co.jp` に変えれば、
Microsoft 365側で迷惑メール扱いされる問題は解消する。

### 本番アクセス申請の記録

- 2026-08-18に申請 → **却下**（ケースID `178698244700479`）
- 却下の理由はAWSコンソールのサポートセンター、またはアカウントの連絡先
  メールアドレスに届いた通知で確認できる（Support APIは有料サポート契約が必要）
- 心当たりのある原因: 申請時に登録したサイトURLがログイン必須の
  `*.cloudfront.net` だったため、審査側がアプリの内容を確認できなかった可能性が高い
- 再申請は、サポートケースへ返信する形で行うのが確実。
  `manuals.takamatsu-build.co.jp`（別紙のDNS依頼）を先に有効にし、
  会社のサイトと結びついたURLを示せると通りやすい
