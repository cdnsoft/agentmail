#!/bin/bash
# AgentMail: Provision a new mailbox
# Usage: provision.sh [label]
# All params optional — label used as email username prefix
LABEL=${1:-""}
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
if [ -n "$LABEL" ]; then
  BODY=$(printf '{"label":"%s"}' "$LABEL")
else
  BODY="{}"
fi
curl -s -X POST "$API/mailboxes" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq .
