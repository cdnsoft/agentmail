# AgentMail Skill

Provision and manage Bitcoin-powered email mailboxes for autonomous agents via the AgentMail REST API.

## What It Does

AgentMail gives AI agents their own email addresses with a pay-as-you-go Bitcoin model. Agents can:
- Provision a mailbox (get an email address + BTC payment address)
- Check payment status and credit balance
- Read, send, and delete email messages
- Top up credits by sending Bitcoin

**Live API:** https://cypher.cdnsoft.net/agentmail/api  
**Source:** https://github.com/cdnsoft/agentmail

## Requirements

- `curl` and `jq` available on the system
- Internet access to https://cypher.cdnsoft.net

> **Note:** Email delivery (inbound SMTP + IMAP) requires DNS records pointing `agentmail.cdnsoft.net` MX to this server. Run `deploy/cf-dns-setup.sh` with a Cloudflare token to activate. The provisioning and BTC payment flow are live now.

## Available Commands

All scripts live in `skill/scripts/`. Use them directly or call the API endpoints.

### `provision.sh [label]`
Create a new mailbox. Returns email address, BTC payment address, and mailbox ID.

```bash
./scripts/provision.sh "my-agent"
# → { id, email, btc_address, credits, status }
```

### `status.sh <mailbox_id>`
Check mailbox status, credit balance, and whether email is active.

```bash
./scripts/status.sh abc123
# → { id, email, credits, status, btc_address }
```

### `list.sh <mailbox_id>`
List messages in the inbox (requires active mailbox with credits and DNS configured).

```bash
./scripts/list.sh abc123
# → [{ uid, subject, from, date, size }]
```

### `read.sh <mailbox_id> <uid>`
Read a specific message by UID.

```bash
./scripts/read.sh abc123 42
# → { uid, subject, from, to, date, text, html }
```

### `send.sh <mailbox_id> <to> <subject> <body>`
Send an email from a mailbox (requires active mailbox with credits).

```bash
./scripts/send.sh abc123 "target@example.com" "Hello" "Message body here"
# → { success: true }
```

### `payment.sh <mailbox_id>`
Manually trigger payment check for a mailbox (polls mempool.space for BTC transactions).

```bash
./scripts/payment.sh abc123
# → { credits_added, new_balance }
```

## Pricing Model

- **1 credit = 1 satoshi** (approx — rate may vary)
- Daily storage fee: small amount deducted per active mailbox
- Send fee: credits consumed per outbound email
- Receive: free
- Mailbox suspended when credits reach 0

## Lifecycle Example

```bash
# 1. Provision a mailbox
RESULT=$(./scripts/provision.sh "my-bot")
ID=$(echo $RESULT | jq -r '.id')
BTC=$(echo $RESULT | jq -r '.btc_address')
EMAIL=$(echo $RESULT | jq -r '.email')

# 2. Send BTC to activate (at least ~1000 sats)
echo "Send BTC to: $BTC"
echo "Your email: $EMAIL"

# 3. Check payment confirmed
./scripts/status.sh $ID

# 4. Send and receive email
./scripts/send.sh $ID "friend@example.com" "Hi" "Hello from AgentMail!"
./scripts/list.sh $ID
```

## API Reference (Direct)

Base URL: `https://cypher.cdnsoft.net/agentmail/api`

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health check |
| POST | /mailboxes | Provision new mailbox |
| GET | /mailboxes/:id | Get mailbox status |
| POST | /payments | Trigger payment check |
| GET | /mailboxes/:id/messages | List messages |
| GET | /mailboxes/:id/messages/:uid | Read message |
| DELETE | /mailboxes/:id/messages/:uid | Delete message |
| POST | /mailboxes/:id/messages | Send message |

### POST /mailboxes
```json
{ "label": "optional-label" }
```
Returns: `{ id, email, btc_address, credits, status, imap, smtp }`

### GET /mailboxes/:id
Returns: `{ id, email, credits, status, btc_address, label, created_at }`

### POST /mailboxes/:id/messages (send)
```json
{ "to": "email@example.com", "subject": "Subject", "text": "Body" }
```

## Notes for Agents

- Store the mailbox `id` securely — it's the only way to access your mailbox
- BTC address is deterministic (HD wallet) — sending again tops up credits
- Mailboxes are pseudo-anonymous (label is optional, not verified)
- The service runs on a Linux server with ~99% uptime target

### `webhook-register.sh <mailbox_id> <url> [secret]`
Register a push notification URL. AgentMail will POST to it when new mail arrives.

```bash
./scripts/webhook-register.sh abc123 https://my-agent.example.com/inbox mysecret
# → { id, url, events, active }
```

### `webhook-list.sh <mailbox_id>`
List all registered webhooks for a mailbox.

### `webhook-delete.sh <mailbox_id> <webhook_id>`
Remove a webhook subscription.

## Webhook Payload

When mail arrives, AgentMail sends a POST to each registered URL:

```json
{
  "event": "message.received",
  "delivery_id": "<uuid>",
  "mailbox_id": "<id>",
  "message": {
    "uid": 42,
    "from": "sender@example.com",
    "to": "myagent@agentmail.cdnsoft.net",
    "subject": "Hello agent",
    "date": "2026-03-16T00:34:11.000Z",
    "size": 1024
  },
  "timestamp": "2026-03-16T00:34:11.000Z"
}
```

If `secret` was provided at registration, the request includes:
`X-AgentMail-Signature: sha256=<hmac>` — verify with HMAC-SHA256.
