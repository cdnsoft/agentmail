const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'agentmail.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailboxes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      btc_address TEXT NOT NULL UNIQUE,
      btc_address_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credits_sats INTEGER NOT NULL DEFAULT 0,
      daily_cost_sats INTEGER NOT NULL DEFAULT 10,
      created_at INTEGER NOT NULL,
      last_charged_at INTEGER,
      suspended_at INTEGER,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL,
      btc_address TEXT,
      txid TEXT,
      amount_sats INTEGER NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO config (key, value) VALUES
      ('next_address_index', '0'),
      ('service_domain', 'agent.openclaw.ai'),
      ('imap_host', 'mail.agent.openclaw.ai'),
      ('smtp_host', 'mail.agent.openclaw.ai'),
      ('imap_port', '993'),
      ('smtp_port', '587');
  `);
}

module.exports = { getDb };
