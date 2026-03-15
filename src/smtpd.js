/**
 * AgentMail inbound SMTP daemon
 * Receives email directly on port 25 (or SMTP_INBOUND_PORT) for configured domain.
 * Parses and stores messages in the DB-backed inbox.
 *
 * Usage: auto-started from index.js when SMTP_INBOUND=true
 * DNS: point MX record for your domain at this server.
 */

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { storeMessage } = require('./inbox');
const { getMailboxByEmail } = require('./mailbox');

const DOMAIN = process.env.SERVICE_DOMAIN || 'agentmail.cdnsoft.net';
const PORT = parseInt(process.env.SMTP_INBOUND_PORT || '25');

function buildSmtpServer() {
  const server = new SMTPServer({
    name: DOMAIN,
    // Allow plain text auth for now (no TLS required for port 25 relay receives)
    disabledCommands: ['AUTH'],
    // Accept mail for any address; we'll filter in onData
    onRcptTo(address, session, callback) {
      const email = address.address.toLowerCase();
      const mailbox = getMailboxByEmail(email);
      if (!mailbox) {
        const err = new Error(`No such mailbox: ${email}`);
        err.responseCode = 550;
        return callback(err);
      }
      callback(); // accept
    },

    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk) => { raw += chunk.toString(); });
      stream.on('end', async () => {
        try {
          const parsed = await simpleParser(raw);
          const recipients = session.envelope.rcptTo.map(r => r.address.toLowerCase());

          for (const to of recipients) {
            const mailbox = getMailboxByEmail(to);
            if (!mailbox) continue;

            const attachments = (parsed.attachments || []).map(a => ({
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
              contentId: a.contentId,
            }));

            storeMessage(mailbox.id, {
              from: parsed.from?.text || session.envelope.mailFrom.address,
              to,
              subject: parsed.subject || '(no subject)',
              text: parsed.text || '',
              html: parsed.html || null,
              date: parsed.date?.toISOString() || new Date().toISOString(),
              messageId: parsed.messageId || null,
              attachments: attachments.length ? attachments : undefined,
            });

            console.log(`[smtpd] Stored message from ${session.envelope.mailFrom.address} to ${to}`);
          }

          callback();
        } catch (err) {
          console.error('[smtpd] Parse error:', err.message);
          callback(err);
        }
      });
    },

    onError(err) {
      console.error('[smtpd] Error:', err.message);
    },
  });

  return server;
}

function startSmtpServer() {
  const server = buildSmtpServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[smtpd] Listening on port ${PORT} for domain ${DOMAIN}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EACCES') {
      console.error(`[smtpd] Port ${PORT} requires root. Run with sudo or use port > 1024 (set SMTP_INBOUND_PORT=2525).`);
      console.error('[smtpd] Tip: use iptables to redirect 25 → 2525:');
      console.error('  sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525');
    } else {
      console.error('[smtpd] Server error:', err.message);
    }
  });
  return server;
}

module.exports = { startSmtpServer };
