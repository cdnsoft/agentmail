#!/bin/bash
# AgentMail: Provision a new mailbox
# Usage: provision.sh [label]
LABEL=${1:-""}
API="${AGENTMAIL_API:-https://cypher.cdnsoft.net/agentmail/api}"
BODY="{}"
if [ -n "$LABEL" ]; then
  BODY=$(jq -n --arg l "$LABEL" '{"label":$l}')
fi
curl -s -X POST "$API/mailboxes" \
  -H "Content-Type: application/json" \
  -d "$BODY" | jq .
