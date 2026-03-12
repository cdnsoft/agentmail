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

module.exports = router;
