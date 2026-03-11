const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const crypto = require('crypto');

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

// Load or generate master key from env/config
function getMasterNode() {
  const xpub = process.env.BTC_XPUB;
  if (!xpub) {
    throw new Error('BTC_XPUB not set — cannot derive payment addresses');
  }
  return bip32.fromBase58(xpub, bitcoin.networks.bitcoin);
}

// Derive a unique receiving address for index n
// Uses path m/0/n (external chain, nth address)
function deriveAddress(index) {
  const node = getMasterNode();
  const child = node.derive(0).derive(index);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: bitcoin.networks.bitcoin,
  });
  return address;
}

// Generate a secure random password for IMAP/SMTP
function generatePassword(length = 24) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

// Check if BTC_XPUB is configured
function isConfigured() {
  return !!process.env.BTC_XPUB;
}

// Mock address for dev/testing when no xpub configured
function deriveAddressMock(index) {
  // Return a deterministic but fake-looking address for testing
  const hash = crypto.createHash('sha256').update(`mock-${index}`).digest('hex').slice(0, 20);
  return `bc1qmock${hash}`;
}

module.exports = {
  deriveAddress: (index) => {
    if (!isConfigured()) return deriveAddressMock(index);
    return deriveAddress(index);
  },
  generatePassword,
  isConfigured,
};
