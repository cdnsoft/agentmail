/**
 * IMAP message fetching for AgentMail
 * Allows agents to read their inbox via HTTP API instead of raw IMAP
 */

const { ImapFlow } = require('imapflow');

function getImapConfig(mailbox) {
  // Use Migadu endpoints if configured, otherwise fall back to env
  const host = process.env.MIGADU_DOMAIN
    ? 'imap.migadu.com'
    : (process.env.IMAP_HOST || 'localhost');

  return {
    host,
    port: 993,
    secure: true,
    auth: {
      user: mailbox.email,
      pass: mailbox.password,
    },
    logger: false,
    tls: { rejectUnauthorized: true },
  };
}

/**
 * List recent messages from a mailbox inbox.
 * Returns array of message summaries (no body).
 * @param {object} mailbox - mailbox record from DB
 * @param {number} limit - max messages to return (default 20)
 */
async function listMessages(mailbox, limit = 20) {
  const client = new ImapFlow(getImapConfig(mailbox));
  const messages = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Fetch last N messages
      const total = client.mailbox.exists;
      if (total === 0) return [];

      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;

      for await (const msg of client.fetch(range, {
        uid: true,
        flags: true,
        envelope: true,
        size: true,
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

/**
 * Fetch full message content by UID.
 * Returns { headers, text, html, attachments[] }
 */
async function getMessage(mailbox, uid) {
  const client = new ImapFlow(getImapConfig(mailbox));

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let result = null;

    try {
      const msg = await client.fetchOne(`${uid}`, {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        source: true,
      }, { uid: true });

      if (!msg) return null;

      // Parse raw source into usable parts
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
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          })),
        };
      } else {
        // Fallback: return raw source if mailparser not available
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

      // Mark as read
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

/**
 * Delete a message by UID (move to Trash / expunge).
 */
async function deleteMessage(mailbox, uid) {
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

module.exports = { listMessages, getMessage, deleteMessage };
