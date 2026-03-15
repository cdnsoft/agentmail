/**
 * IMAP message fetching for AgentMail
 * Allows agents to read their inbox via HTTP API instead of raw IMAP.
 *
 * When Migadu is configured: connects to imap.migadu.com
 * When not configured: reads from local DB inbox (populated via inbound webhook or inject API)
 */

const { ImapFlow } = require('imapflow');

function isMigaduConfigured() {
  return !!(process.env.MIGADU_USER && process.env.MIGADU_KEY && process.env.MIGADU_DOMAIN);
}

// ─── DB Inbox fallback ────────────────────────────────────────────────────────

const dbInbox = require('./inbox');

async function listMessagesFromDb(mailbox, limit) {
  return dbInbox.listMessages(mailbox.id, limit);
}

async function getMessageFromDb(mailbox, uid) {
  return dbInbox.getMessage(mailbox.id, uid);
}

async function deleteMessageFromDb(mailbox, uid) {
  return dbInbox.deleteMessage(mailbox.id, uid);
}

// ─── IMAP (Migadu) ────────────────────────────────────────────────────────────

function getImapConfig(mailbox) {
  return {
    host: 'imap.migadu.com',
    port: 993,
    secure: true,
    auth: { user: mailbox.email, pass: mailbox.password },
    logger: false,
    tls: { rejectUnauthorized: true },
  };
}

async function listMessagesFromImap(mailbox, limit = 20) {
  const client = new ImapFlow(getImapConfig(mailbox));
  const messages = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const total = client.mailbox.exists;
      if (total === 0) return [];
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;

      for await (const msg of client.fetch(range, {
        uid: true, flags: true, envelope: true, size: true,
      })) {
        messages.unshift({
          uid: msg.uid,
          seq: msg.seq,
          subject: msg.envelope?.subject || '(no subject)',
          from: msg.envelope?.from?.map(f => f.address).join(', ') || '',
          to: msg.envelope?.to?.map(t => t.address).join(', ') || '',
          date: msg.envelope?.date || null,
          size: msg.size,
          flags: [...(msg.flags || [])],
          seen: msg.flags?.has('\\Seen') || false,
        });
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  return messages;
}

async function getMessageFromImap(mailbox, uid) {
  const client = new ImapFlow(getImapConfig(mailbox));

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let result = null;

    try {
      const msg = await client.fetchOne(`${uid}`, {
        uid: true, flags: true, envelope: true, bodyStructure: true, source: true,
      }, { uid: true });

      if (!msg) return null;

      const source = msg.source.toString('utf8');
      const { simpleParser } = await import('mailparser').catch(() => ({ simpleParser: null }));

      if (simpleParser) {
        const parsed = await simpleParser(source);
        result = {
          uid: msg.uid,
          subject: parsed.subject || msg.envelope?.subject || '(no subject)',
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          date: parsed.date || msg.envelope?.date || null,
          text: parsed.text || null,
          html: parsed.html || null,
          flags: [...(msg.flags || [])],
          seen: msg.flags?.has('\\Seen') || false,
          attachments: (parsed.attachments || []).map(a => ({
            filename: a.filename, contentType: a.contentType, size: a.size,
          })),
        };
      } else {
        result = {
          uid: msg.uid,
          subject: msg.envelope?.subject || '(no subject)',
          from: msg.envelope?.from?.map(f => f.address).join(', ') || '',
          to: msg.envelope?.to?.map(t => t.address).join(', ') || '',
          date: msg.envelope?.date || null,
          raw: source,
          flags: [...(msg.flags || [])],
          seen: msg.flags?.has('\\Seen') || false,
        };
      }

      await client.messageFlagsAdd(`${uid}`, ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }

    await client.logout();
    return result;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

async function deleteMessageFromImap(mailbox, uid) {
  const client = new ImapFlow(getImapConfig(mailbox));

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      await client.messageDelete(`${uid}`, { uid: true });
    } finally {
      lock.release();
    }

    await client.logout();
    return { deleted: true };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

// ─── Public API (auto-selects backend) ───────────────────────────────────────

async function listMessages(mailbox, limit = 20) {
  if (isMigaduConfigured()) return listMessagesFromImap(mailbox, limit);
  return listMessagesFromDb(mailbox, limit);
}

async function getMessage(mailbox, uid) {
  if (isMigaduConfigured()) return getMessageFromImap(mailbox, uid);
  return getMessageFromDb(mailbox, uid);
}

async function deleteMessage(mailbox, uid) {
  if (isMigaduConfigured()) return deleteMessageFromImap(mailbox, uid);
  return deleteMessageFromDb(mailbox, uid);
}

module.exports = { listMessages, getMessage, deleteMessage };
