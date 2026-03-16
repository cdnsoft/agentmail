/**
 * DB-backed inbox for AgentMail
 *
 * Stores inbound messages in SQLite. Used when:
 *  - Migadu is not configured (dev/relay mode)
 *  - An inbound webhook delivers a message
 *
 * When Migadu IS configured, IMAP is used instead.
 */

const { getDb } = require('./db');
const { notifyNewMessage } = require('./webhooks');

function ensureInboxTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox_id TEXT NOT NULL,
      uid INTEGER NOT NULL,
      subject TEXT,
      from_addr TEXT,
      to_addr TEXT,
      received_at INTEGER NOT NULL,
      text_body TEXT,
      html_body TEXT,
      raw_headers TEXT,
      seen INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      UNIQUE(mailbox_id, uid)
    )
  `);
  // Auto-increment uid per mailbox (stored as max+1)
}

/**
 * Store an inbound message.
 * Returns the stored message with its uid.
 */
function storeMessage(mailboxId, msg) {
  ensureInboxTable();
  const db = getDb();

  // Get next UID for this mailbox
  const row = db.prepare('SELECT MAX(uid) as maxUid FROM inbox_messages WHERE mailbox_id = ?').get(mailboxId);
  const uid = (row?.maxUid || 0) + 1;
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT OR IGNORE INTO inbox_messages
      (mailbox_id, uid, subject, from_addr, to_addr, received_at, text_body, html_body, raw_headers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mailboxId,
    uid,
    msg.subject || '(no subject)',
    msg.from || '',
    msg.to || '',
    msg.received_at || now,
    msg.text || null,
    msg.html || null,
    msg.headers ? JSON.stringify(msg.headers) : null,
  );

  // Fire agent webhooks (non-blocking)
  try { notifyNewMessage(mailboxId, { uid, ...msg }); } catch (_) {}

  return { uid, ...msg };
}

/**
 * List messages for a mailbox (newest first, excluding deleted).
 */
function listMessages(mailboxId, limit = 20) {
  ensureInboxTable();
  const db = getDb();

  return db.prepare(`
    SELECT uid, subject, from_addr as "from", to_addr as "to",
           received_at, seen, text_body as text
    FROM inbox_messages
    WHERE mailbox_id = ? AND deleted = 0
    ORDER BY uid DESC
    LIMIT ?
  `).all(mailboxId, limit).map(r => ({
    uid: r.uid,
    subject: r.subject,
    from: r.from,
    to: r.to,
    date: new Date(r.received_at * 1000).toISOString(),
    seen: r.seen === 1,
    size: (r.text || '').length,
  }));
}

/**
 * Get a single message by UID (marks as seen).
 */
function getMessage(mailboxId, uid) {
  ensureInboxTable();
  const db = getDb();

  const msg = db.prepare(`
    SELECT uid, subject, from_addr as "from", to_addr as "to",
           received_at, seen, text_body as text, html_body as html, raw_headers
    FROM inbox_messages
    WHERE mailbox_id = ? AND uid = ? AND deleted = 0
  `).get(mailboxId, uid);

  if (!msg) return null;

  // Mark as seen
  db.prepare('UPDATE inbox_messages SET seen = 1 WHERE mailbox_id = ? AND uid = ?').run(mailboxId, uid);

  return {
    uid: msg.uid,
    subject: msg.subject,
    from: msg.from,
    to: msg.to,
    date: new Date(msg.received_at * 1000).toISOString(),
    text: msg.text,
    html: msg.html,
    seen: true,
    flags: msg.seen ? ['\\Seen'] : [],
  };
}

/**
 * Delete a message (soft delete).
 */
function deleteMessage(mailboxId, uid) {
  ensureInboxTable();
  const db = getDb();
  const result = db.prepare('UPDATE inbox_messages SET deleted = 1 WHERE mailbox_id = ? AND uid = ?').run(mailboxId, uid);
  return { deleted: result.changes > 0 };
}

/**
 * Count unread messages for a mailbox.
 */
function countUnread(mailboxId) {
  ensureInboxTable();
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as n FROM inbox_messages WHERE mailbox_id = ? AND seen = 0 AND deleted = 0').get(mailboxId);
  return row?.n || 0;
}

module.exports = { storeMessage, listMessages, getMessage, deleteMessage, countUnread, ensureInboxTable };
