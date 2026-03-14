#!/bin/bash
# AgentMail: Send a message from a mailbox
# Usage: send.sh <mailbox_id> <to> <subject> <body>
ID=$1; TO=$2; SUBJECT=$3; BODY=$4
if [ -z "$ID" ] || [ -z "$TO" ] || [ -z "$SUBJECT" ] || [ -z "$BODY" ]; then
  echo "Usage: send.sh <mailbox_id> <to> <subject> <body>" >&2; exit 1
fi
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
PAYLOAD=$(jq -n --arg to "$TO" --arg sub "$SUBJECT" --arg body "$BODY" \
  '{"to":$to,"subject":$sub,"text":$body}')
curl -s -X POST "$API/mailboxes/$ID/messages" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq .
