/**
 * Migadu API client
 * Docs: https://api.migadu.com/v1/
 * Auth: Basic auth — MIGADU_USER:MIGADU_KEY
 * Domain: MIGADU_DOMAIN (e.g. agentmail.cdnsoft.net)
 */

const MIGADU_API = 'https://api.migadu.com/v1';

function isConfigured() {
  return !!(process.env.MIGADU_USER && process.env.MIGADU_KEY && process.env.MIGADU_DOMAIN);
}

function authHeader() {
  const creds = Buffer.from(`${process.env.MIGADU_USER}:${process.env.MIGADU_KEY}`).toString('base64');
  return `Basic ${creds}`;
}

/**
 * Create a mailbox on Migadu.
 * Returns the created mailbox object from Migadu API.
 */
async function createMailbox({ username, password, name }) {
  if (!isConfigured()) {
    console.warn('[migadu] Not configured — skipping real mailbox creation (dev mode)');
    return { local_part: username, domain: 'dev.local', address: `${username}@dev.local` };
  }

  const domain = process.env.MIGADU_DOMAIN;
  const url = `${MIGADU_API}/domains/${domain}/mailboxes`;

  const body = JSON.stringify({
    local_part: username,
    name: name || username,
    password,
    password_method: 'password',
    is_internal: false,
    may_send: true,
    may_receive: true,
    may_access_imap: true,
    may_access_pop3: false,
    may_access_managesieve: false,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json',
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Migadu createMailbox failed: ${res.status} — ${JSON.stringify(data)}`);
  }

  console.log(`[migadu] Created mailbox: ${data.address}`);
  return data;
}

/**
 * Delete a mailbox from Migadu.
 */
async function deleteMailbox(username) {
  if (!isConfigured()) {
    console.warn('[migadu] Not configured — skipping real mailbox deletion (dev mode)');
    return;
  }

  const domain = process.env.MIGADU_DOMAIN;
  const url = `${MIGADU_API}/domains/${domain}/mailboxes/${username}`;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': authHeader() },
  });

  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Migadu deleteMailbox failed: ${res.status} — ${JSON.stringify(data)}`);
  }

  console.log(`[migadu] Deleted mailbox: ${username}@${process.env.MIGADU_DOMAIN}`);
}

/**
 * Get mailbox info from Migadu.
 */
async function getMailboxInfo(username) {
  if (!isConfigured()) return null;

  const domain = process.env.MIGADU_DOMAIN;
  const url = `${MIGADU_API}/domains/${domain}/mailboxes/${username}`;

  const res = await fetch(url, {
    headers: { 'Authorization': authHeader() },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Migadu getMailbox failed: ${res.status}`);
  }
  return res.json();
}

module.exports = { isConfigured, createMailbox, deleteMailbox, getMailboxInfo };
