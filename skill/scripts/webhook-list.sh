#!/bin/bash
# AgentMail: List webhooks for a mailbox
# Usage: webhook-list.sh <mailbox_id>
ID=${1:?"Usage: webhook-list.sh <mailbox_id>"}
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
curl -s "$API/mailboxes/$ID/webhooks" | jq .
