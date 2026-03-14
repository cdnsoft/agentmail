#!/bin/bash
# AgentMail: Read a specific message
# Usage: read.sh <mailbox_id> <uid>
ID=$1; UID=$2
if [ -z "$ID" ] || [ -z "$UID" ]; then echo "Usage: read.sh <mailbox_id> <uid>" >&2; exit 1; fi
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
curl -s "$API/mailboxes/$ID/messages/$UID" | jq .
