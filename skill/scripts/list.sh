#!/bin/bash
# AgentMail: List messages in a mailbox
# Usage: list.sh <mailbox_id>
ID=$1
if [ -z "$ID" ]; then echo "Usage: list.sh <mailbox_id>" >&2; exit 1; fi
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
curl -s "$API/mailboxes/$ID/messages" | jq .
