/**
 * AgentMail — agent webhook subscriptions
 *
 * Agents register a callback URL and get POST'd when new mail arrives.
 * Stored in SQLite. Fired from storeMessage().
 *
 * Table: agent_webhooks
 *   id, mailbox_id, url, secret, events, created_at, last_fired_at, failure_count
 */

const { getDb } = require('./db');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_webhooks (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      events TEXT NOT NULL DEFAULT 'message.received',
      created_at INTEGER NOT NULL,
      last_fired_at INTEGER,
      failure_count INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    )
  `);
}

function registerWebhook({ id, mailboxId, url, secret, events }) {
  ensureTable();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // validate URL
  try { new URL(url); } catch { throw new Error('Invalid URL'); }

  const eventsStr = Array.isArray(events) ? events.join(',') : (events || 'message.received');

  db.prepare(`
    INSERT OR REPLACE INTO agent_webhooks (id, mailbox_id, url, secret, events, created_at, failure_count, active)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1)
  `).run(id, mailboxId, url, secret || null, eventsStr, now);

  return { id, mailbox_id: mailboxId, url, events: eventsStr, active: true };
}

function listWebhooks(mailboxId) {
  ensureTable();
  const db = getDb();
  return db.prepare('SELECT id, url, events, created_at, last_fired_at, failure_count, active FROM agent_webhooks WHERE mailbox_id = ? ORDER BY created_at DESC').all(mailboxId);
}

function deleteWebhook(id, mailboxId) {
  ensureTable();
  const db = getDb();
  const r = db.prepare('DELETE FROM agent_webhooks WHERE id = ? AND mailbox_id = ?').run(id, mailboxId);
  return r.changes > 0;
}

function getActiveWebhooks(mailboxId, event = 'message.received') {
  ensureTable();
  const db = getDb();
  return db.prepare(`
    SELECT * FROM agent_webhooks
    WHERE mailbox_id = ? AND active = 1 AND failure_count < 5 AND events LIKE ?
  `).all(mailboxId, `%${event}%`);
}

/**
 * Fire a webhook. Returns true on success.
 * On 5 consecutive failures, webhook is auto-disabled.
 */
async function fireWebhook(webhook, payload) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': 'AgentMail-Webhook/1.0',
    'X-AgentMail-Event': payload.event,
    'X-AgentMail-Delivery': payload.delivery_id,
  };
  if (webhook.secret) {
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
    headers['X-AgentMail-Signature'] = `sha256=${sig}`;
  }

  const parsed = new URL(webhook.url);
  const mod = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout: 10000,
    }, (res) => {
      // consume body
      res.resume();
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      if (ok) {
        db.prepare('UPDATE agent_webhooks SET last_fired_at = ?, failure_count = 0 WHERE id = ?').run(now, webhook.id);
      } else {
        db.prepare('UPDATE agent_webhooks SET failure_count = failure_count + 1, active = CASE WHEN failure_count + 1 >= 5 THEN 0 ELSE 1 END WHERE id = ?').run(webhook.id);
        console.warn(`[webhook] ${webhook.url} returned ${res.statusCode}, failures: ${webhook.failure_count + 1}`);
      }
      resolve(ok);
    });
    req.on('error', (e) => {
      db.prepare('UPDATE agent_webhooks SET failure_count = failure_count + 1, active = CASE WHEN failure_count + 1 >= 5 THEN 0 ELSE 1 END WHERE id = ?').run(webhook.id);
      console.warn(`[webhook] ${webhook.url} error: ${e.message}`);
      resolve(false);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * Notify all registered webhooks for a mailbox about a new message.
 * Non-blocking — fires in background.
 */
function notifyNewMessage(mailboxId, message) {
  const hooks = getActiveWebhooks(mailboxId, 'message.received');
  if (!hooks.length) return;

  const { v4: uuidv4 } = require('uuid');
  const payload = {
    event: 'message.received',
    delivery_id: uuidv4(),
    mailbox_id: mailboxId,
    message: {
      uid: message.uid,
      from: message.from,
      to: message.to,
      subject: message.subject,
      date: message.date || new Date().toISOString(),
      size: (message.text || '').length,
    },
    timestamp: new Date().toISOString(),
  };

  for (const hook of hooks) {
    fireWebhook(hook, payload).catch(e => console.error('[webhook] fire error:', e.message));
  }
}

module.exports = { registerWebhook, listWebhooks, deleteWebhook, notifyNewMessage, ensureTable };
