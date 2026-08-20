#!/usr/bin/env bash
# 無料クレジットの残りと、このままの使い方だと何日で尽きるかを表示する。
#
#   ./scripts/check-credits.sh
#
# クレジットが尽きた時点でアカウントは自動的に閉鎖され、リソースは止まり、
# データは90日後に完全に消える。移行の締切はこの日付で決まるので、
# 週に一度はこれを見て残り日数を把握する。
#
# 注: Cost Explorerの問い合わせは1回$0.01かかる(このスクリプトで2回=$0.02)。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 無料プランの状態を扱うAPIはus-east-1にしかない
PLAN="$(aws freetier get-account-plan-state --region us-east-1 --output json)"

python3 - "$PLAN" "$(aws ce get-cost-and-usage \
  --time-period "Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d)" \
  --granularity DAILY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}' \
  --region us-east-1 --output json)" \
  "$(aws ce get-cost-and-usage \
  --time-period "Start=$(date -v-30d +%Y-%m-%d),End=$(date +%Y-%m-%d)" \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Dimensions":{"Key":"RECORD_TYPE","Values":["Usage"]}}' \
  --region us-east-1 --output json)" <<'PY'
import json, sys
from datetime import date, datetime, timedelta

plan, daily, by_service = (json.loads(a) for a in sys.argv[1:4])

remaining = float(plan["accountPlanRemainingCredits"]["amount"])
expires = plan["accountPlanExpirationDate"][:10]
status = plan["accountPlanStatus"]

days = [
    (d["TimePeriod"]["Start"], float(d["Total"]["UnblendedCost"]["Amount"]))
    for d in daily["ResultsByTime"]
]
# 直近7日のうち、実際に課金が出ている日だけで平均を出す
# (停止していた日を混ぜると枯渇日を楽観的に見誤る)
recent = [c for _, c in days[-7:] if c > 0.01]
per_day = sum(recent) / len(recent) if recent else 0.0
spent_30 = sum(c for _, c in days)

print(f"無料プランの状態 : {status}")
print(f"残りクレジット   : ${remaining:,.2f}")
print(f"直近30日の消費   : ${spent_30:,.2f}")
if per_day:
    print(f"1日あたり        : ${per_day:,.2f}  (稼働していた{len(recent)}日の平均)")
    print(f"1か月あたり      : ${per_day * 30:,.2f}")
    left = int(remaining / per_day)
    gone = date.today() + timedelta(days=left)
    print()
    print(f"このままだと残り : 約{left}日 → {gone:%Y年%m月%d日} ごろ枯渇")
    limit = datetime.strptime(expires, "%Y-%m-%d").date()
    if limit < gone:
        print(f"                   ただしアカウント期限 {limit:%Y年%m月%d日} が先に来る")
    else:
        print(f"(アカウント期限は {limit:%Y年%m月%d日} なので、枯渇のほうが先)")
    print()
    if left <= 14:
        print("!! 残り2週間以内。移行を完了させるか、有料プランへの切替を決めること")
    elif left <= 45:
        print("!  移行作業に着手していること。scripts/backup-all.sh も定期的に")
else:
    print("直近7日に課金がありません(停止中か、まだ集計されていません)")

print("\n内訳(直近30日)")
for g in by_service["ResultsByTime"][-1]["Groups"]:
    amt = float(g["Metrics"]["UnblendedCost"]["Amount"])
    if amt >= 0.01:
        print(f"  {amt:8.2f}  {g['Keys'][0]}")
PY
