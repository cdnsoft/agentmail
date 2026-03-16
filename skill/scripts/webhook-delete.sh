#!/bin/bash
# AgentMail: Delete a webhook
# Usage: webhook-delete.sh <mailbox_id> <webhook_id>
ID=${1:?"Usage: webhook-delete.sh <mailbox_id> <webhook_id>"}
WID=${2:?"Usage: webhook-delete.sh <mailbox_id> <webhook_id>"}
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
curl -s -X DELETE "$API/mailboxes/$ID/webhooks/$WID" | jq .
