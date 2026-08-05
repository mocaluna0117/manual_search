#!/usr/bin/env bash
# 一時停止(aws-stop.sh)からの再開スクリプト。
# RDSが使える状態になってからECSを起こす(逆だと起動時のDB接続で
# タスクが数回落ちる。最終的には自己回復するが、無駄な再起動を避ける)。
set -euo pipefail

CLUSTER=manual-search

echo "== RDSを起動する(available まで数分待つ) =="
aws rds start-db-instance --db-instance-identifier manual-search-db \
  --query "DBInstance.DBInstanceStatus" --output text
aws rds wait db-instance-available --db-instance-identifier manual-search-db
echo "RDS: available"

echo "== ECSサービスを1タスクに戻す =="
for svc in rag backend; do # backendはrag/DBに依存するので後
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" \
    --desired-count 1 --query "service.[serviceName,desiredCount]" --output text
done

echo "== backendがALBでhealthyになるまで待つ =="
TG=$(aws elbv2 describe-target-groups --names manual-search-backend \
  --query "TargetGroups[0].TargetGroupArn" --output text)
for i in $(seq 1 30); do
  N=$(aws elbv2 describe-target-health --target-group-arn "$TG" \
    --query "TargetHealthDescriptions[?TargetHealth.State=='healthy'] | length(@)" --output text)
  if [ "$N" -ge 1 ]; then
    echo "healthy。本番URL: https://d3r3bcg6d6aepn.cloudfront.net"
    exit 0
  fi
  echo "[$i/30] healthy待ち..."
  sleep 20
done
echo "healthyになりません。aws logs tail /ecs/manual-search/backend で確認してください" >&2
exit 1
