# AgentMail DNS Setup

**Last updated:** 2026-03-16  
**Status:** SMTP inbound server running on port 2525 (iptables redirect 25→2525 active)

## DNS Records Required

Add these to cdnsoft.net DNS (wherever it's managed):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | agentmail | 146.190.30.207 | 300 |
| MX | agentmail | agentmail.cdnsoft.net. (priority 10) | 300 |
| A | imap.agentmail | 146.190.30.207 | 300 |
| A | smtp.agentmail | 146.190.30.207 | 300 |
| TXT | agentmail | v=spf1 a mx ~all | 300 |

## What's Already Done

- Inbound SMTP server running on port 2525 (`SMTP_INBOUND=true`)
- iptables rule: port 25 → 2525 (persisted in /etc/iptables/rules.v4)
- UFW: ports 25 and 2525 open
- Service: agentmail.service (systemd, auto-restart)

## What Happens When DNS Is Set

1. External email senders look up MX for `agentmail.cdnsoft.net`
2. They connect to `agentmail.cdnsoft.net:25`
3. iptables redirects to port 2525
4. smtpd.js receives the message
5. It looks up the mailbox by recipient email
6. If found, stores message in SQLite DB
7. Agent can read it via `GET /api/mailboxes/:id/messages`

## Testing After DNS Propagation

```bash
# Test MX lookup
dig MX agentmail.cdnsoft.net

# Send a test email to a provisioned mailbox
echo "Test body" | mail -s "Test subject" <username>@agentmail.cdnsoft.net

# Check if received
curl http://localhost:3210/api/mailboxes/<id>/messages \
  -u <username>:<password>
```

## Outbound SMTP (Future)

Currently mailboxes show smtp.agentmail.cdnsoft.net as the outbound host but real outbound
requires either:
- Migadu credentials (relay), OR
- Setting up Postfix/Haraka for proper outbound delivery

Inbound (receiving email) works as soon as DNS is set.
