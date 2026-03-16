#!/bin/bash
# Cloudflare DNS setup for agentmail.cdnsoft.net
# Usage: CF_TOKEN=<token> bash cf-dns-setup.sh
# Get token: Cloudflare Dashboard → My Profile → API Tokens → Create Token (Zone:DNS:Edit)

CF_TOKEN=${CF_TOKEN:-$(cat ~/.secrets/cloudflare_token 2>/dev/null)}
if [ -z "$CF_TOKEN" ]; then
  echo "ERROR: CF_TOKEN not set and ~/.secrets/cloudflare_token not found"
  echo "Get token: Cloudflare Dashboard → My Profile → API Tokens → Create Token (Zone:DNS:Edit)"
  exit 1
fi

ZONE_NAME="cdnsoft.net"
SERVER_IP="146.190.30.207"

echo "Fetching zone ID for $ZONE_NAME..."
ZONE_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'])")

if [ -z "$ZONE_ID" ]; then
  echo "ERROR: Could not get zone ID for $ZONE_NAME"
  exit 1
fi
echo "Zone ID: $ZONE_ID"

add_record() {
  TYPE=$1; NAME=$2; CONTENT=$3; PRIORITY=${4:-}
  BODY="{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"content\":\"$CONTENT\",\"ttl\":300,\"proxied\":false}"
  if [ -n "$PRIORITY" ]; then
    BODY="{\"type\":\"$TYPE\",\"name\":\"$NAME\",\"content\":\"$CONTENT\",\"priority\":$PRIORITY,\"ttl\":300,\"proxied\":false}"
  fi
  RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$BODY")
  SUCCESS=$(echo $RESULT | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['success'])")
  echo "$TYPE $NAME → $CONTENT: $SUCCESS"
}

echo "Adding DNS records..."
add_record "A"   "agentmail.cdnsoft.net"      "$SERVER_IP"
add_record "A"   "imap.agentmail.cdnsoft.net" "$SERVER_IP"
add_record "A"   "smtp.agentmail.cdnsoft.net" "$SERVER_IP"
add_record "MX"  "agentmail.cdnsoft.net"      "agentmail.cdnsoft.net" 10
add_record "TXT" "agentmail.cdnsoft.net"      "v=spf1 a mx ~all"

echo ""
echo "Done! DNS propagation takes 1-5 minutes."
echo "Test with: dig MX agentmail.cdnsoft.net"
