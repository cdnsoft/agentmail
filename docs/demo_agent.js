#!/usr/bin/env node
/**
 * AgentMail Demo - A simple autonomous agent that uses AgentMail API
 * Shows the full lifecycle: provision → pay → send → read
 * 
 * Usage: node demo_agent.js [API_BASE]
 */

const API = process.argv[2] || 'https://cypher.cdnsoft.net/agentmail/api';
const agentId = `demo-agent-${Date.now()}`;
const username = `demo${Math.floor(Math.random() * 9000) + 1000}`;

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  console.log(`\n🤖 AgentMail Demo Agent`);
  console.log(`API: ${API}\n`);

  // Step 1: Provision mailbox
  console.log('1️⃣  Provisioning mailbox...');
  const mailbox = await api('POST', '/mailboxes', { agent_id: agentId, username });
  if (mailbox.error) { console.error('Error:', mailbox.error); process.exit(1); }
  
  console.log(`   ✓ Mailbox: ${mailbox.email}`);
  console.log(`   ✓ BTC address: ${mailbox.btc_address}`);
  console.log(`   ✓ Cost: ${mailbox.daily_cost_sats} sats/day`);
  console.log(`   ✓ Activation: ${mailbox.activation_threshold_sats} sats needed\n`);

  // Step 2: Check status
  console.log('2️⃣  Checking mailbox status...');
  const status = await api('GET', `/mailboxes/${mailbox.id}`);
  console.log(`   ✓ Status: ${status.status}`);
  console.log(`   ✓ Credits: ${status.credit_sats} sats\n`);

  // Step 3: Check messages (would need active mailbox + Migadu)
  console.log('3️⃣  Listing messages (requires active mailbox + Migadu)...');
  const msgs = await api('GET', `/mailboxes/${mailbox.id}/messages`);
  if (msgs.error) {
    console.log(`   ⚠️  ${msgs.error} (expected — mailbox pending payment)`);
  } else {
    console.log(`   ✓ Found ${msgs.messages?.length || 0} messages`);
  }

  console.log('\n✅ Demo complete!');
  console.log(`\nTo activate this mailbox, send ${mailbox.activation_threshold_sats}+ sats to:`);
  console.log(`   ${mailbox.btc_address}`);
  console.log(`\nThen agents can send/receive email at: ${mailbox.email}`);
}

main().catch(console.error);
