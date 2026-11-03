#!/bin/sh
# Claude Code PermissionRequest hook: relays a permission ask to the Server OS panel (Bots tab) and prints the owner's
# decision. No answer in time, or the server unreachable: prints nothing and exits 0, so Claude Code asks in the terminal.
#   SERVER_OS_URL (default http://127.0.0.1:3094)   SD_APPROVAL_WAIT seconds to wait (default 600; set the hook's timeout above it)
W=${SD_APPROVAL_WAIT:-600}
f=$(mktemp) || exit 0
cat > "$f.in"
curl -s -m $((W + 10)) -X POST -H 'Content-Type: application/json' -H "X-Wait: $W" -H "X-State-Dir: ${TELEGRAM_STATE_DIR:-}" \
  --data-binary @"$f.in" -w '\n%{http_code}' "${SERVER_OS_URL:-http://127.0.0.1:3094}/api/v1/approvals/hook" > "$f" 2>/dev/null &
p=$!
# Claude Code ends the hook when the ask is answered in the terminal: stop the request too, so the panel drops the card.
trap 'kill $p 2>/dev/null; rm -f "$f" "$f.in"; exit 0' TERM INT HUP
wait $p || { rm -f "$f" "$f.in"; exit 0; }
[ "$(tail -n 1 "$f")" = 200 ] && sed '$d' "$f"
rm -f "$f" "$f.in"
exit 0
