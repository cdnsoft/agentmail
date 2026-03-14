#!/bin/bash
# AgentMail: Get mailbox status
# Usage: status.sh <mailbox_id>
ID=$1
if [ -z "$ID" ]; then echo "Usage: status.sh <mailbox_id>" >&2; exit 1; fi
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
curl -s "$API/mailboxes/$ID" | jq .
