#!/usr/bin/env bash
# Generate chunked SQL and push every chunk to remote D1 via wrangler.
# Env:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID      — wrangler auth
#   XDG_CONFIG_HOME, HOME                            — sandbox-friendly config dirs
#   WRANGLER                                         — path to wrangler bin
#   TABLES                                           — override default table list (csv)
set -euo pipefail

WRANGLER="${WRANGLER:-npx wrangler}"
OUT="${OUT:-/tmp/d1-chunks}"
DB="${DB:-bulk-local.db}"

# Note: horse_form_records omitted — local data has broken horse_id values
# (raw HKJC codes like "A001" instead of "horse_A001"), which violate the
# FK to horses(id) enforced by D1. Defer to A3 once the form-record schema
# drift is cleaned up in bulk-local.db.
TABLES="${TABLES:-race_meetings,races,horses,jockeys,trainers,running_comments,dividends,race_results}"

echo "=== step 1: generate chunks ==="
npx tsx scripts/push-to-d1.ts --db="$DB" --out="$OUT" --tables="$TABLES" > /tmp/push-to-d1.manifest

total=$(wc -l < /tmp/push-to-d1.manifest | tr -d ' ')
echo "=== step 2: push ${total} chunk(s) to remote D1 ==="

idx=0
while IFS= read -r chunk; do
  idx=$((idx + 1))
  printf '[%d/%d] %s ... ' "$idx" "$total" "$(basename "$chunk")"
  if $WRANGLER d1 execute tianxi-db --remote --file="$chunk" > /tmp/d1-push.log 2>&1; then
    echo "ok"
  else
    echo "FAIL"
    tail -20 /tmp/d1-push.log
    echo "resume with: sed -n '${idx},\$p' /tmp/push-to-d1.manifest | while read c; do $WRANGLER d1 execute tianxi-db --remote --file=\$c; done"
    exit 1
  fi
done < /tmp/push-to-d1.manifest

echo "=== done: ${total} chunk(s) applied ==="
