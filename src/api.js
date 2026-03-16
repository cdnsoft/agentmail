const express = require('express');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const { provisionMailbox, getMailbox, recordPayment, runDailyCharge } = require('./mailbox');
const { isConfigured } = require('./bitcoin');
const { registerMempoolWebhook } = require('./webhook');

const router = express.Router();

// Rate limiters
const sendRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 emails per IP per hour
  message: { error: 'Send rate limit exceeded. Max 50 emails per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const provisionRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 new mailboxes per IP per hour
  message: { error: 'Provisioning rate limit exceeded. Max 10 mailboxes per hour per IP.' },
  standardHeaders: true,
  legacyHeaders: false,
});


// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AgentMail',
    btc_configured: isConfigured(),
    timestamp: new Date().toISOString(),
  });
});

// Provision a new mailbox
// POST /api/mailboxes
// Body: { agent_id?, username?, label? }
// All fields optional — auto-generated if omitted
router.post('/mailboxes', provisionRateLimit, async (req, res) => {
  let { agent_id, username, label } = req.body || {};
  // Auto-generate agent_id and username if not provided
  if (!agent_id) agent_id = uuidv4();
  if (!username) {
    // Derive from label (sanitized) or random short ID
    if (label) {
      username = label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20);
    } else {
      username = agent_id.split('-')[0]; // first UUID segment
    }
  }
  try {
    const result = provisionMailbox({ agentId: agent_id, username, label });

    // Auto-register mempool.space webhook for payment detection
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl && isConfigured()) {
      registerMempoolWebhook(result.btc_address, publicUrl)
        .then(r => console.log(`[webhook] Registered for ${result.btc_address}:`, r))
        .catch(e => console.error(`[webhook] Registration failed:`, e.message));
    }

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get mailbox status + credits
// GET /api/mailboxes/:id
router.get('/mailboxes/:id', (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

  // Don't expose password in status check
  const { password: _, credits_sats, ...safe } = mailbox;
  res.json({ ...safe, credit_sats: credits_sats });
});

// Record a Bitcoin payment (webhook / manual top-up)
// POST /api/payments
// Body: { mailbox_id, btc_address, txid, amount_sats }
router.post('/payments', (req, res) => {
  const { mailbox_id, btc_address, txid, amount_sats } = req.body;
  if (!mailbox_id || !amount_sats) {
    return res.status(400).json({ error: 'mailbox_id and amount_sats are required' });
  }
  const mailbox = getMailbox(mailbox_id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

  try {
    const result = recordPayment({ mailboxId: mailbox_id, btcAddress: btc_address, txid, amountSats: amount_sats });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin: run daily charge cycle
// POST /api/admin/charge  (should be protected in prod)
router.post('/admin/charge', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const result = runDailyCharge();
  res.json(result);
});

// Public stats for dashboard
// GET /api/stats
router.get('/stats', (req, res) => {
  const db = require('./db').getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM mailboxes WHERE deleted_at IS NULL").get();
  const active = db.prepare("SELECT COUNT(*) as count FROM mailboxes WHERE status = 'active'").get();
  const pending = db.prepare("SELECT COUNT(*) as count FROM mailboxes WHERE status = 'pending'").get();
  const suspended = db.prepare("SELECT COUNT(*) as count FROM mailboxes WHERE status = 'suspended'").get();
  const totalSats = db.prepare("SELECT COALESCE(SUM(amount_sats), 0) as total FROM payments").get();
  const recentPayments = db.prepare("SELECT txid, amount_sats, received_at FROM payments ORDER BY received_at DESC LIMIT 5").all();
  const recentMailboxes = db.prepare("SELECT username, email, status, created_at FROM mailboxes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5").all();

  res.json({
    mailboxes: {
      total: total.count,
      active: active.count,
      pending: pending.count,
      suspended: suspended.count,
    },
    payments: {
      total_sats_received: totalSats.total,
      recent: recentPayments,
    },
    recent_mailboxes: recentMailboxes,
    btc_configured: isConfigured(),
    timestamp: new Date().toISOString(),
  });
});


// ── Message reading endpoints ────────────────────────────────────────────────
// Agents use these to read email via HTTP instead of raw IMAP

const { listMessages, getMessage, deleteMessage } = require('./imap');

function requireActiveMailbox(res, mailbox) {
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return false; }
  if (mailbox.status !== 'active') {
    res.status(402).json({ error: `Mailbox is ${mailbox.status} — top up Bitcoin to activate`, status: mailbox.status });
    return false;
  }
  return true;
}


// Authenticate agent by mailbox password (Bearer token or X-Mailbox-Password header)
function requireMailboxAuth(req, res, mailbox) {
  const auth = req.headers['authorization'];
  const headerPw = req.headers['x-mailbox-password'];
  let provided = headerPw;
  if (!provided && auth && auth.startsWith('Bearer ')) {
    provided = auth.slice(7);
  }
  if (!provided || provided !== mailbox.password) {
    res.status(401).json({ error: 'Unauthorized — provide mailbox password via Authorization: Bearer <password> or X-Mailbox-Password header' });
    return false;
  }
  return true;
}

// GET /api/mailboxes/:id/messages
// List recent inbox messages (no body). Query: ?limit=20
router.get('/mailboxes/:id/messages', async (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!requireActiveMailbox(res, mailbox)) return;
  if (requireMailboxAuth(req, res, mailbox) === false) return;

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  try {
    const messages = await listMessages(mailbox, limit);
    res.json({ messages, count: messages.length, mailbox_id: mailbox.id, email: mailbox.email });
  } catch (err) {
    console.error('[imap] listMessages error:', err.message);
    res.status(502).json({ error: 'Failed to fetch messages', detail: err.message });
  }
});

// GET /api/mailboxes/:id/messages/:uid
// Fetch full message content by UID (marks as read)
router.get('/mailboxes/:id/messages/:uid', async (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!requireActiveMailbox(res, mailbox)) return;
  if (requireMailboxAuth(req, res, mailbox) === false) return;

  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'Invalid UID' });

  try {
    const msg = await getMessage(mailbox, uid);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json(msg);
  } catch (err) {
    console.error('[imap] getMessage error:', err.message);
    res.status(502).json({ error: 'Failed to fetch message', detail: err.message });
  }
});

// DELETE /api/mailboxes/:id/messages/:uid
// Delete a message
router.delete('/mailboxes/:id/messages/:uid', async (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!requireActiveMailbox(res, mailbox)) return;

  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'Invalid UID' });

  try {
    const result = await deleteMessage(mailbox, uid);
    res.json(result);
  } catch (err) {
    console.error('[imap] deleteMessage error:', err.message);
    res.status(502).json({ error: 'Failed to delete message', detail: err.message });
  }
});

// POST /api/mailboxes/:id/messages
// Send an email from this mailbox
// Body: { to, subject, text, html, cc, bcc, replyTo }
// Requires active mailbox (paid / credits > 0)
const { sendMessage } = require('./smtp');

router.post('/mailboxes/:id/messages', async (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (requireActiveMailbox(res, mailbox) === false) return;
  if (requireMailboxAuth(req, res, mailbox) === false) return;

  const { to, subject, text, html, cc, bcc, replyTo } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });

  try {
    const result = await sendMessage(mailbox, { to, subject, text, html, cc, bcc, replyTo });
    res.status(201).json(result);
  } catch (err) {
    console.error('[smtp] sendMessage error:', err.message);
    res.status(502).json({ error: 'Failed to send message', detail: err.message });
  }
});

// ─── Inbound email webhook ────────────────────────────────────────────────────
// POST /api/inbound
// Generic inbound email webhook. Any SMTP relay (Brevo, Mailgun, etc.) can POST here.
// Body: { to, from, subject, text, html, headers? }
// Optionally secured by INBOUND_WEBHOOK_SECRET env var.

const { storeMessage } = require('./inbox');

router.post('/inbound', async (req, res) => {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (secret) {
    const auth = req.headers['x-webhook-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    if (auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, from, subject, text, html, headers } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });

  // Find mailbox by email address
  const db = require('./db').getDb();
  const toAddr = Array.isArray(to) ? to[0] : to;
  const email = typeof toAddr === 'string' ? toAddr.toLowerCase().trim() : toAddr?.address?.toLowerCase();

  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE LOWER(email) = ?').get(email);
  if (!mailbox) {
    console.warn(`[inbound] No mailbox found for: ${email}`);
    return res.status(404).json({ error: `No mailbox found for ${email}` });
  }

  const stored = storeMessage(mailbox.id, {
    subject: subject || '(no subject)',
    from: typeof from === 'string' ? from : (from?.address || from?.email || ''),
    to: email,
    text: text || null,
    html: html || null,
    headers: headers || null,
    received_at: Math.floor(Date.now() / 1000),
  });

  console.log(`[inbound] Stored message uid=${stored.uid} for ${email}`);
  res.status(201).json({ uid: stored.uid, mailbox_id: mailbox.id });
});

// ─── Admin: inject test message ───────────────────────────────────────────────
// POST /api/admin/mailboxes/:id/inject
// Injects a test message directly into a mailbox DB inbox. Dev/testing only.
// Secured by ADMIN_SECRET env var.

router.post('/admin/mailboxes/:id/inject', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret) {
    const auth = req.headers['x-admin-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    if (auth !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const mailbox = getMailbox(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });

  const { subject, from, text, html } = req.body;
  const stored = storeMessage(mailbox.id, {
    subject: subject || 'Test message',
    from: from || 'test@example.com',
    to: mailbox.email,
    text: text || 'This is a test message injected via admin API.',
    html: html || null,
    received_at: Math.floor(Date.now() / 1000),
  });

  console.log(`[admin] Injected test message uid=${stored.uid} into mailbox ${mailbox.id}`);
  res.status(201).json({ uid: stored.uid, mailbox_id: mailbox.id, email: mailbox.email });
});

module.exports = router;


// ── Agent Webhook Subscriptions ───────────────────────────────────────────────
// Agents register callback URLs to get push-notified on new mail

const { registerWebhook, listWebhooks, deleteWebhook } = require('./webhooks');
const { v4: uuidv4Wh } = require('uuid');

// POST /api/mailboxes/:id/webhooks
// Body: { url, secret?, events? }
router.post('/mailboxes/:id/webhooks', async (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });
  if (!requireMailboxAuth(req, res, mailbox)) return;

  const { url, secret, events } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const wh = registerWebhook({
      id: uuidv4Wh(),
      mailboxId: mailbox.id,
      url,
      secret,
      events: events || ['message.received'],
    });
    res.status(201).json(wh);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/mailboxes/:id/webhooks
router.get('/mailboxes/:id/webhooks', (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });
  if (!requireMailboxAuth(req, res, mailbox)) return;

  const hooks = listWebhooks(mailbox.id).map(h => ({
    id: h.id,
    url: h.url,
    events: h.events.split(','),
    active: h.active === 1,
    created_at: new Date(h.created_at * 1000).toISOString(),
    last_fired_at: h.last_fired_at ? new Date(h.last_fired_at * 1000).toISOString() : null,
    failure_count: h.failure_count,
  }));
  res.json({ webhooks: hooks, count: hooks.length });
});

// DELETE /api/mailboxes/:id/webhooks/:wid
router.delete('/mailboxes/:id/webhooks/:wid', (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });
  if (!requireMailboxAuth(req, res, mailbox)) return;

  const ok = deleteWebhook(req.params.wid, mailbox.id);
  if (!ok) return res.status(404).json({ error: 'Webhook not found' });
  res.json({ deleted: true });
});
