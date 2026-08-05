#!/usr/bin/env bash
# 節約用の一時停止スクリプト。
#
# 止まるもの: Fargateタスク(約$22/月) + RDSインスタンス(約$19/月)
# 止まらないもの: ALB(約$18/月)・ストレージ類(約$3/月)
#   → 長期間使わないならALBの削除まで検討する(docs/deployment-plan.mdの撤収手順)
#
# 注意: RDSの停止は7日で自動的に再開される(AWSの仕様)。
set -euo pipefail

CLUSTER=manual-search

echo "== ECSサービスを0タスクにする =="
for svc in backend rag; do
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" \
    --desired-count 0 --query "service.[serviceName,desiredCount]" --output text
done

echo "== RDSを停止する =="
aws rds stop-db-instance --db-instance-identifier manual-search-db \
  --query "DBInstance.DBInstanceStatus" --output text

echo "完了。再開は scripts/aws-start.sh"
