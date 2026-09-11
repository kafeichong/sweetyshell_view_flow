#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://ai.sweetyshell.com/api/v1}"
ADMIN_TOKEN="${VIDEO_FLOW_ADMIN_TOKEN:?请设置 VIDEO_FLOW_ADMIN_TOKEN}"
ACTION="${1:-}"
ACTOR_ID="${2:-}"

command -v curl >/dev/null || { echo "error: curl not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 not found" >&2; exit 1; }

case "$ACTION" in
  issue)
    ACTOR_NAME="${3:?用法: video_flow_credential.sh issue ACTOR_ID ACTOR_NAME TOKEN_OUTPUT}"
    TOKEN_OUTPUT="${4:?用法: video_flow_credential.sh issue ACTOR_ID ACTOR_NAME TOKEN_OUTPUT}"
    payload=$(ACTOR_ID_VALUE="$ACTOR_ID" ACTOR_NAME_VALUE="$ACTOR_NAME" python3 - <<'PY'
import json
import os
print(json.dumps({"actorId": os.environ["ACTOR_ID_VALUE"], "name": os.environ["ACTOR_NAME_VALUE"]}))
PY
)
    response=$(curl -fsS -X POST "$BASE_URL/admin/credentials" \
      -H "Content-Type: application/json" \
      -H "X-Admin-Token: $ADMIN_TOKEN" \
      -d "$payload")
    token=$(CREDENTIAL_RESPONSE="$response" python3 - <<'PY'
import json
import os
value = json.loads(os.environ["CREDENTIAL_RESPONSE"]).get("token", "")
if not value:
    raise SystemExit("credential response did not contain token")
print(value)
PY
)
    mkdir -p "$(dirname "$TOKEN_OUTPUT")"
    umask 077
    printf '%s\n' "$token" > "$TOKEN_OUTPUT.tmp.$$"
    chmod 600 "$TOKEN_OUTPUT.tmp.$$"
    mv "$TOKEN_OUTPUT.tmp.$$" "$TOKEN_OUTPUT"
    echo "credential issued: actor=$ACTOR_ID token_file=$TOKEN_OUTPUT"
    ;;
  revoke)
    test -n "$ACTOR_ID" || { echo "用法: video_flow_credential.sh revoke ACTOR_ID" >&2; exit 1; }
    response=$(curl -fsS -X PATCH "$BASE_URL/admin/credentials/$ACTOR_ID/revoke" \
      -H "X-Admin-Token: $ADMIN_TOKEN")
    CREDENTIAL_RESPONSE="$response" python3 - <<'PY'
import json
import os
obj = json.loads(os.environ["CREDENTIAL_RESPONSE"])
print(f"credential revoked: actor={obj.get('actorId', '')} status={obj.get('status', '')}")
PY
    ;;
  *)
    echo "用法:" >&2
    echo "  video_flow_credential.sh issue ACTOR_ID ACTOR_NAME TOKEN_OUTPUT" >&2
    echo "  video_flow_credential.sh revoke ACTOR_ID" >&2
    exit 2
    ;;
esac
