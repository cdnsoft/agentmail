const express = require('express');
const { provisionMailbox, getMailbox, recordPayment, runDailyCharge } = require('./mailbox');
const { isConfigured } = require('./bitcoin');
const { registerMempoolWebhook } = require('./webhook');

const router = express.Router();

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
// Body: { agent_id, username }
router.post('/mailboxes', async (req, res) => {
  const { agent_id, username } = req.body;
  if (!agent_id || !username) {
    return res.status(400).json({ error: 'agent_id and username are required' });
  }
  try {
    const result = provisionMailbox({ agentId: agent_id, username });

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
  const { password: _, ...safe } = mailbox;
  res.json(safe);
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

// GET /api/mailboxes/:id/messages
// List recent inbox messages (no body). Query: ?limit=20
router.get('/mailboxes/:id/messages', async (req, res) => {
  const mailbox = getMailbox(req.params.id);
  if (!requireActiveMailbox(res, mailbox)) return;

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

module.exports = router;
