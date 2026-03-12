const express = require('express');
const https = require('https');
const { getDb } = require('./db');
const { recordPayment } = require('./mailbox');

const router = express.Router();

// mempool.space calls this when a tx involving a watched address is seen/confirmed
// POST /api/webhooks/mempool
// Body format varies — we handle both address-watch and tx formats
router.post('/mempool', (req, res) => {
  const db = getDb();
  // mempool.space sends: { txid, type: "address-transactions", address, ... }
  // or raw tx data depending on webhook type
  const body = req.body;
  const txid = body.txid;
  const address = body.address;

  if (!txid || !address) {
    // Try alternate format: array of vout
    return res.status(400).json({ error: 'Missing txid or address' });
  }

  // Find mailbox by btc_address
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE btc_address = ?').get(address);
  if (!mailbox) {
    console.log(`[webhook] Unknown address: ${address}`);
    return res.json({ status: 'ignored', reason: 'unknown address' });
  }

  // Check if we already processed this txid
  const existing = db.prepare('SELECT id FROM payments WHERE txid = ?').get(txid);
  if (existing) {
    return res.json({ status: 'ignored', reason: 'already processed' });
  }

  // Get tx details from mempool.space to find amount sent to our address
  getTransactionOutput(txid, address, (err, amountSats) => {
    if (err || !amountSats) {
      console.error(`[webhook] Failed to get tx amount: ${err}`);
      return res.status(500).json({ error: 'Could not determine amount' });
    }

    try {
      const result = recordPayment({
        mailboxId: mailbox.id,
        btcAddress: address,
        txid,
        amountSats,
      });
      console.log(`[webhook] Payment recorded: ${amountSats} sats for ${mailbox.email} (${txid})`);
      res.json({ status: 'credited', ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Fetch tx from mempool.space API and find our output
function getTransactionOutput(txid, address, callback) {
  const url = `https://mempool.space/api/tx/${txid}`;
  https.get(url, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        const tx = JSON.parse(data);
        let amountSats = 0;
        for (const vout of tx.vout || []) {
          if (vout.scriptpubkey_address === address) {
            amountSats += vout.value; // already in sats
          }
        }
        callback(null, amountSats);
      } catch (e) {
        callback(e, 0);
      }
    });
  }).on('error', callback);
}

// Register a webhook for an address with mempool.space
// Called internally after mailbox provisioning
async function registerMempoolWebhook(address, baseUrl) {
  const webhookUrl = `${baseUrl}/api/webhooks/mempool`;
  const payload = JSON.stringify({
    type: 'address-transactions',
    address,
    url: webhookUrl,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'mempool.space',
      path: '/api/v1/ws/address/' + address,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    // mempool.space uses websocket for address subscriptions,
    // but for webhooks we use their webhook API:
    // POST https://mempool.space/api/v1/webhooks
    const hookOptions = {
      hostname: 'mempool.space',
      path: '/api/v1/webhooks',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(hookOptions, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { router, registerMempoolWebhook };
