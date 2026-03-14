#!/bin/bash
# AgentMail: Trigger payment check for a mailbox
# Usage: payment.sh <mailbox_id>
ID=$1
if [ -z "$ID" ]; then echo "Usage: payment.sh <mailbox_id>" >&2; exit 1; fi
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
curl -s -X POST "$API/payments" \
  -H "Content-Type: application/json" \
  -d "{\"mailbox_id\":\"$ID\"}" | jq .
