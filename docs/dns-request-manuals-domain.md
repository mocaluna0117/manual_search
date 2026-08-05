# DNSレコード追加のお願い（社内マニュアル検索システム用）

社内マニュアル検索システムを `https://manuals.takamatsu-build.co.jp` で
公開するため、`takamatsu-build.co.jp` のDNS（ConoHaで管理されています）に
以下の **CNAMEレコード2件** の追加をお願いします。

## 追加するレコード

| # | 種別 | 名称（ホスト名） | 値 | TTL |
| --- | --- | --- | --- | --- |
| 1 | CNAME | `_071cdaf589428378d908cfdaa7a6532d.manuals` | `_95d6c8084f784d0fae34d5162e827e39.jkddzztszm.acm-validations.aws.` | 3600 |
| 2 | CNAME | `manuals` | `d3r3bcg6d6aepn.cloudfront.net.` | 3600 |

- 名称はゾーン相対（`takamatsu-build.co.jp` を除いた部分）で記載しています。
  管理画面がFQDNでの入力を求める場合は、末尾に `.takamatsu-build.co.jp` を補ってください
- 値の末尾のドット（`.`）は、管理画面が受け付けない場合は省いて問題ありません

## それぞれの役割

1. **証明書の所有権確認用**（AWS Certificate Manager）。
   HTTPS証明書「このドメインの持ち主が申請している」ことの確認に使われます。
   **証明書は自動更新のたびにこのレコードを参照するため、追加後も削除せず残してください**
2. **本体**。`manuals.takamatsu-build.co.jp` へのアクセスを
   配信サーバー（AWS CloudFront）へ向けるレコードです

## 影響範囲

- 既存のレコード（Webサイト・メール等）には一切変更を加えません。
  新しいサブドメイン `manuals` とその確認用レコードを追加するだけです
