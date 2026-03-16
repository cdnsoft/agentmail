/**
 * SMTP sending for AgentMail
 * Supports three modes (in priority order):
 *  1. Migadu per-mailbox auth (MIGADU_* env vars set)
 *  2. Central SMTP relay (SMTP_RELAY_* env vars set) — one relay sends FOR all mailboxes
 *  3. Direct MX delivery — nodemailer resolves recipient MX and delivers directly
 *     No credentials needed. Works once agentmail.cdnsoft.net has DNS + proper SPF/PTR.
 */

const nodemailer = require('nodemailer');

function isRelayConfigured() {
  return !!(process.env.SMTP_RELAY_HOST && process.env.SMTP_RELAY_USER && process.env.SMTP_RELAY_PASS);
}

function isDirectEnabled() {
  // Enabled by default when no relay/migadu configured, or explicitly forced
  return process.env.SMTP_DIRECT !== 'false';
}

function getTransport(mailbox) {
  const migadu = require('./migadu');

  if (migadu.isConfigured()) {
    // Per-mailbox auth via Migadu
    return nodemailer.createTransport({
      host: 'smtp.migadu.com',
      port: 587,
      secure: false,
      auth: { user: mailbox.email, pass: mailbox.password },
      tls: { rejectUnauthorized: true },
    });
  }

  if (isRelayConfigured()) {
    // Central relay — sends on behalf of any mailbox
    return nodemailer.createTransport({
      host: process.env.SMTP_RELAY_HOST,
      port: parseInt(process.env.SMTP_RELAY_PORT || '587'),
      secure: process.env.SMTP_RELAY_SECURE === 'true',
      auth: {
        user: process.env.SMTP_RELAY_USER,
        pass: process.env.SMTP_RELAY_PASS,
      },
      tls: { rejectUnauthorized: process.env.SMTP_RELAY_REJECT_UNAUTH !== 'false' },
    });
  }

  if (isDirectEnabled()) {
    // Direct MX delivery — resolve recipient MX, connect directly on port 25
    // Requires: correct PTR record for 146.190.30.207, SPF TXT on agentmail.cdnsoft.net
    console.warn('[smtp] No relay configured — using direct MX delivery (SMTP_DIRECT mode)');
    return nodemailer.createTransport({
      direct: true,
      name: process.env.SERVICE_DOMAIN || 'agentmail.cdnsoft.net',
      port: 25,
      tls: { rejectUnauthorized: false },
    });
  }

  throw new Error('No email transport configured. Set MIGADU_*, SMTP_RELAY_*, or SMTP_DIRECT=true env vars.');
}

/**
 * Send an email from a mailbox.
 * @param {object} mailbox - mailbox record from DB (needs .email, .username, .password)
 * @param {object} msg - { to, subject, text, html, cc, bcc, replyTo, attachments[] }
 * @returns {object} { messageId, accepted, rejected }
 */
async function sendMessage(mailbox, msg) {
  const { to, subject, text, html, cc, bcc, replyTo, attachments } = msg;

  if (!to) throw new Error('to is required');
  if (!subject && !text && !html) throw new Error('subject or body is required');

  const transporter = getTransport(mailbox);

  const info = await transporter.sendMail({
    from: `${mailbox.username} <${mailbox.email}>`,
    to,
    cc,
    bcc,
    replyTo,
    subject: subject || '(no subject)',
    text,
    html,
    attachments,
  });

  console.log(`[smtp] Sent from ${mailbox.email} to ${to}: ${info.messageId}`);

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
}

module.exports = { sendMessage, isRelayConfigured, isDirectEnabled };
