#!/bin/bash
# Usage: webhook-register.sh <mailbox_id> <webhook_url> [secret]
AGENTMAIL_API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
MAILBOX_ID="$1"; URL="$2"; SECRET="$3"
[ -z "$MAILBOX_ID" ] || [ -z "$URL" ] && echo "Usage: $0 <mailbox_id> <url> [secret]" && exit 1
[ -z "$MAILBOX_PASSWORD" ] && echo "Set MAILBOX_PASSWORD env var" && exit 1
BODY="{\"url\":\"$URL\",\"events\":[\"message.received\"]"
[ -n "$SECRET" ] && BODY="$BODY,\"secret\":\"$SECRET\""
BODY="$BODY}"
curl -s -X POST "$AGENTMAIL_API/mailboxes/$MAILBOX_ID/webhooks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MAILBOX_PASSWORD" \
  -d "$BODY" | jq .
