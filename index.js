require('dotenv').config();
const express = require('express');
const api = require('./src/api');

const app = express();
app.use(express.json());

app.use('/api', api);

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
    },
    docs: 'https://github.com/cdnsoft/agentmail',
  });
});

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`AgentMail running on port ${PORT}`);
  console.log(`Bitcoin configured: ${require('./src/bitcoin').isConfigured()}`);
});
