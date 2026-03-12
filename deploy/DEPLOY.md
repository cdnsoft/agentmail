# AgentMail Deployment Guide

## Prerequisites
- Node.js 22+
- nginx
- certbot (Let's Encrypt)
- DNS: `agentmail.cdnsoft.net` → server IP

## 1. Clone & Install

```bash
cd ~/Projects
git clone https://github.com/cdnsoft/agentmail
cd agentmail
npm install
```

## 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Required variables:
```
BTC_XPUB=xpub...             # Your HD wallet xpub
PUBLIC_URL=https://agentmail.cdnsoft.net
ADMIN_KEY=<random secret>
MIGADU_USER=admin@cdnsoft.net  # Migadu account email
MIGADU_KEY=<migadu-api-key>    # From migadu.com dashboard
MIGADU_DOMAIN=agentmail.cdnsoft.net  # Domain added to Migadu
```

## 3. Install systemd service

```bash
sudo cp deploy/agentmail.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable agentmail
sudo systemctl start agentmail
sudo systemctl status agentmail
```

## 4. Configure nginx

```bash
sudo cp deploy/nginx-agentmail.conf /etc/nginx/sites-available/agentmail
sudo ln -s /etc/nginx/sites-available/agentmail /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. SSL Certificate

```bash
sudo certbot --nginx -d agentmail.cdnsoft.net
```

## 6. Test

```bash
# Health check
curl https://agentmail.cdnsoft.net/api/health

# Provision a mailbox
curl -X POST https://agentmail.cdnsoft.net/api/mailboxes \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent-001","username":"myagent"}'
```

## 7. Migadu Setup

1. Add domain `agentmail.cdnsoft.net` to your Migadu account
2. Set DNS records as instructed by Migadu (MX, SPF, DKIM)
3. Add `MIGADU_USER`, `MIGADU_KEY`, `MIGADU_DOMAIN` to `.env`
4. Restart: `sudo systemctl restart agentmail`

## Cron: Daily Charge

```bash
# Add to crontab
0 0 * * * curl -s -X POST http://localhost:3210/api/admin/charge \
  -H "X-Admin-Key: $ADMIN_KEY" >> /var/log/agentmail-charge.log 2>&1
```
