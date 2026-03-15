const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const { deriveAddress, generatePassword } = require('./bitcoin');
const migadu = require('./migadu');

function getConfig(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function nextAddressIndex() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('next_address_index');
  const idx = parseInt(row.value, 10);
  db.prepare('UPDATE config SET value = ? WHERE key = ?').run(String(idx + 1), 'next_address_index');
  return idx;
}

function provisionMailbox({ agentId, username }) {
  const db = getDb();

  // Use Migadu domain if configured, else fall back to config
  const domain = process.env.MIGADU_DOMAIN || getConfig('service_domain') || 'agent.openclaw.ai';

  if (!/^[a-z0-9][a-z0-9._-]{2,30}$/.test(username)) {
    throw new Error('Invalid username: 3-31 chars, lowercase alphanumeric, dots, hyphens, underscores');
  }

  const existing = db.prepare('SELECT id FROM mailboxes WHERE username = ?').get(username);
  if (existing) throw new Error('Username "' + username + '" is already taken');

  const id = uuidv4();
  const email = username + '@' + domain;
  const password = generatePassword();
  const addrIndex = nextAddressIndex();
  const btcAddress = deriveAddress(addrIndex);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    'INSERT INTO mailboxes (id, agent_id, username, email, password, btc_address, btc_address_index, status, credits_sats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(id, agentId, username, email, password, btcAddress, addrIndex, 'pending', now);

  // IMAP/SMTP details — Migadu standard endpoints if configured
  const imapHost = migadu.isConfigured() ? 'imap.migadu.com' : (getConfig('imap_host') || 'imap.agent.openclaw.ai');
  const smtpHost = migadu.isConfigured() ? 'smtp.migadu.com' : (getConfig('smtp_host') || 'smtp.agent.openclaw.ai');

  return {
    id,
    email,
    username,
    password,
    btc_address: btcAddress,
    daily_cost_sats: 10,
    activation_threshold_sats: 300,
    credit_sats: 0,
    status: 'pending',
    imap: { host: imapHost, port: 993, ssl: true },
    smtp: { host: smtpHost, port: 587, starttls: true },
    message: 'Send Bitcoin to ' + btcAddress + ' to activate. Cost: 10 sats/day. 300 sats = 30 days.',
  };
}

function getMailbox(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM mailboxes WHERE id = ? AND status != ?').get(id, 'deleted');
}

function recordPayment({ mailboxId, btcAddress, txid, amountSats }) {
  const db = getDb();
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  // Deduplicate by txid
  if (txid) {
    const existing = db.prepare('SELECT id FROM payments WHERE txid = ?').get(txid);
    if (existing) {
      console.log(`[payment] Duplicate txid ${txid} — skipping`);
      const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
      return { credited: 0, status: mailbox?.status, total_credits: mailbox?.credits_sats, duplicate: true };
    }
  }

  db.prepare(
    'INSERT INTO payments (id, mailbox_id, btc_address, txid, amount_sats, confirmed, received_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, mailboxId, btcAddress || null, txid || null, amountSats, now);

  db.prepare('UPDATE mailboxes SET credits_sats = credits_sats + ? WHERE id = ?').run(amountSats, mailboxId);

  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (mailbox && mailbox.status === 'pending' && mailbox.credits_sats + amountSats >= mailbox.daily_cost_sats) {
    db.prepare('UPDATE mailboxes SET status = ? WHERE id = ?').run('active', mailboxId);
    
    // Activate real mailbox on Migadu (async — don't block the response)
    migadu.createMailbox({ username: mailbox.username, password: mailbox.password, name: mailbox.username })
      .then(m => {
        console.log(`[migadu] Mailbox activated: ${m.address || mailbox.email}`);
        db.prepare('UPDATE mailboxes SET migadu_activated_at = ? WHERE id = ?').run(now, mailboxId);
      })
      .catch(err => {
        console.error(`[migadu] Failed to activate ${mailbox.username}:`, err.message);
        // Don't fail the payment — we can retry later
      });

    return { credited: amountSats, status: 'active', total_credits: mailbox.credits_sats + amountSats, activated: true };
  }

  return {
    credited: amountSats,
    status: mailbox ? mailbox.status : 'unknown',
    total_credits: mailbox ? mailbox.credits_sats + amountSats : amountSats,
  };
}

/**
 * Re-activate suspended mailboxes that received enough credits.
 * Called automatically when payment is recorded for a suspended mailbox.
 */
async function reactivateMailbox(mailboxId) {
  const db = getDb();
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!mailbox || mailbox.status !== 'suspended') return;

  if (mailbox.credits_sats >= mailbox.daily_cost_sats) {
    db.prepare('UPDATE mailboxes SET status = ?, suspended_at = NULL WHERE id = ?').run('active', mailboxId);
    
    // Check if Migadu mailbox exists, recreate if needed
    const info = await migadu.getMailboxInfo(mailbox.username).catch(() => null);
    if (!info) {
      await migadu.createMailbox({ username: mailbox.username, password: mailbox.password, name: mailbox.username });
    }
    console.log(`[mailbox] Reactivated ${mailbox.username}`);
  }
}

function runDailyCharge() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;

  const active = db.prepare(
    'SELECT * FROM mailboxes WHERE status = ? AND (last_charged_at IS NULL OR last_charged_at < ?)'
  ).all('active', oneDayAgo);

  let charged = 0, suspended = 0;
  for (const mb of active) {
    if (mb.credits_sats >= mb.daily_cost_sats) {
      db.prepare('UPDATE mailboxes SET credits_sats = credits_sats - ?, last_charged_at = ? WHERE id = ?')
        .run(mb.daily_cost_sats, now, mb.id);
      charged++;
    } else {
      db.prepare('UPDATE mailboxes SET status = ?, suspended_at = ? WHERE id = ?').run('suspended', now, mb.id);
      suspended++;

      // Delete from Migadu when suspended (optional: could keep for grace period)
      migadu.deleteMailbox(mb.username).catch(e =>
        console.error(`[migadu] Failed to suspend ${mb.username}:`, e.message)
      );
    }
  }

  // Hard delete after 7 days suspended
  const sevenDaysAgo = now - 7 * 86400;
  const toDelete = db.prepare(
    'SELECT * FROM mailboxes WHERE status = ? AND suspended_at < ?'
  ).all('suspended', sevenDaysAgo);

  for (const mb of toDelete) {
    db.prepare('UPDATE mailboxes SET status = ?, deleted_at = ? WHERE id = ?').run('deleted', now, mb.id);
    migadu.deleteMailbox(mb.username).catch(() => {});
  }

  return { charged, suspended, deleted: toDelete.length };
}

module.exports = { provisionMailbox, getMailbox, getMailboxByEmail, recordPayment, reactivateMailbox, runDailyCharge };

function getMailboxByEmail(email) {
  const db = getDb();
  return db.prepare("SELECT * FROM mailboxes WHERE email = ? AND status != 'deleted'").get(email.toLowerCase());
}
