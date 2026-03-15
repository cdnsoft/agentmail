require('dotenv').config();
const express = require('express');
const api = require('./src/api');
const { router: webhookRouter } = require('./src/webhook');

const app = express();
app.use(express.json());

app.use('/api', api);
app.use('/api/webhooks', webhookRouter);

// Root info
app.get('/', (req, res) => {
  res.json({
    service: 'AgentMail',
    description: 'Bitcoin-powered email for autonomous agents',
    version: '0.1.0',
    endpoints: {
      health: 'GET /api/health',
      provision: 'POST /api/mailboxes',
      status: 'GET /api/mailboxes/:id',
      payment: 'POST /api/payments',
      stats: 'GET /api/stats',
      webhook: "POST /api/webhooks/mempool",
      messages: "GET /api/mailboxes/:id/messages",
      message: "GET /api/mailboxes/:id/messages/:uid",
      delete_message: "DELETE /api/mailboxes/:id/messages/:uid",
    },
    docs: 'https://github.com/cdnsoft/agentmail',
  });
});

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`AgentMail running on port ${PORT}`);
  console.log(`Bitcoin configured: ${require('./src/bitcoin').isConfigured()}`);
  console.log(`Public URL: ${process.env.PUBLIC_URL || '(not set — webhooks disabled)'}`);
});

// Auto daily charge — run at startup and every 24h
const { runDailyCharge } = require('./src/mailbox');
function scheduleDailyCharge() {
  console.log('[scheduler] Running daily charge cycle...');
  try {
    const result = runDailyCharge();
    console.log(`[scheduler] Charged ${result.charged} mailboxes, suspended ${result.suspended}`);
  } catch (err) {
    console.error('[scheduler] Daily charge failed:', err.message);
  }
}
// Run once at startup (small delay), then every 24h
setTimeout(scheduleDailyCharge, 5000);
setInterval(scheduleDailyCharge, 24 * 60 * 60 * 1000);

// Inbound SMTP server — start when SMTP_INBOUND=true
if (process.env.SMTP_INBOUND === 'true') {
  const { startSmtpServer } = require('./src/smtpd');
  startSmtpServer();
}
