#!/usr/bin/env bash
# 送信メールを自社ドメインに切り替えるための、2つの前提の進み具合を見る。
#
#   ./scripts/check-mail-domain.sh
#
# 1) DNSのDKIMレコード(3件)が反映され、AWS側の検証が終わったか
# 2) SESの本番アクセス申請が承認されたか
#
# 両方が済んだら、docs/dns-request-ses-mail-domain.md の「追加後の作業」を行う。
set -euo pipefail
DOMAIN=mail.takamatsu-build.co.jp

echo "=== 1) ドメインの署名(DKIM)の状態 ==="
aws sesv2 get-email-identity --email-identity "$DOMAIN" \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}' --output table

echo "=== DNSに実際に見えているか(3件そろっている必要がある) ==="
found=0
for token in $(aws sesv2 get-email-identity --email-identity "$DOMAIN" \
  --query 'DkimAttributes.Tokens[]' --output text); do
  name="${token}._domainkey.${DOMAIN}"
  if dig +short CNAME "$name" | grep -q amazonses; then
    echo "  ✅ ${token:0:12}… 反映済み"
    found=$((found + 1))
  else
    echo "  ⏳ ${token:0:12}… まだ見えない"
  fi
done
echo "  → ${found}/3 件"

echo
echo "=== 2) SESの本番アクセス ==="
aws sesv2 get-account \
  --query '{productionAccess:ProductionAccessEnabled,review:Details.ReviewDetails.Status,dailyLimit:SendQuota.Max24HourSend}' \
  --output table
