/**
 * SMTP sending for AgentMail
 * Allows agents to send email via HTTP API (no raw SMTP exposure needed).
 */

const nodemailer = require('nodemailer');

function getSmtpConfig(mailbox) {
  const host = process.env.MIGADU_DOMAIN
    ? 'smtp.migadu.com'
    : (process.env.SMTP_HOST || 'localhost');

  return {
    host,
    port: 587,
    secure: false, // STARTTLS
    auth: {
      user: mailbox.email,
      pass: mailbox.password,
    },
    tls: { rejectUnauthorized: true },
  };
}

/**
 * Send an email from a mailbox.
 * @param {object} mailbox - mailbox record from DB (needs .email, .password)
 * @param {object} msg - { to, subject, text, html, cc, bcc, replyTo, attachments[] }
 * @returns {object} { messageId, accepted, rejected }
 */
async function sendMessage(mailbox, msg) {
  const { to, subject, text, html, cc, bcc, replyTo, attachments } = msg;

  if (!to) throw new Error('to is required');
  if (!subject && !text && !html) throw new Error('subject or body is required');

  const transporter = nodemailer.createTransport(getSmtpConfig(mailbox));

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

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
}

module.exports = { sendMessage };
