#!/usr/bin/env node
/**
 * AgentMail End-to-End Integration Test
 * Tests: provision → fund (admin) → inbound SMTP → read inbox → cleanup
 * Usage: ADMIN_KEY=<key> node test/e2e.js
 */
const http = require('http');
const net = require('net');

function api(method, path, body, h={}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const hdrs = {'Content-Type':'application/json',...h};
    if (data) hdrs['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ hostname:'localhost', port:3210, path, method, headers:hdrs },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){resolve(d)} }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function smtpSend(from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(2525, '127.0.0.1');
    let step=0, log=[];
    const cmds = [null,'EHLO test',`MAIL FROM:<${from}>`,`RCPT TO:<${to}>`,'DATA',
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.`,'QUIT'];
    c.setTimeout(8000); c.on('timeout',()=>{c.destroy();reject(new Error('timeout'))});
    c.on('error', reject);
    c.on('data', d => {
      const line=d.toString().trim(); log.push('< '+line.split('\n')[0]);
      if (parseInt(line)>=400){c.destroy();return reject(new Error(line));}
      step++;
      if (step>=cmds.length){c.destroy();return resolve(log);}
      if(cmds[step]){log.push('> '+cmds[step].split('\r\n')[0]);c.write(cmds[step]+'\r\n');}
    });
  });
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const AK = process.env.ADMIN_KEY;

async function run() {
  if (!AK) { console.error('ERROR: ADMIN_KEY env var required'); process.exit(1); }
  console.log('=== AgentMail Full E2E Integration Test ===\n');
  const ts = Date.now(); let pass=0, fail=0;
  const ok = m => { console.log('   ✓ '+m); pass++; };
  const ko = m => { console.log('   ✗ '+m); fail++; };

  process.stdout.write('1. Provision... ');
  const mb = await api('POST','/api/mailboxes',{label:`e2e_${ts}`});
  if (mb.error) throw new Error(mb.error);
  console.log(''); ok(mb.email); ok(`BTC: ${mb.btc_address}`);
  const auth = {'Authorization': `Bearer ${mb.password}`};

  process.stdout.write('\n2. Fund (admin topup)... ');
  const topup = await api('POST','/api/admin/topup',{mailbox_id:mb.id,amount_sats:500},{'x-admin-key':AK});
  console.log('');
  if (topup.error) ko(topup.error); else ok(`${topup.credited} sats → ${topup.status}`);

  process.stdout.write('\n3. Inbound SMTP (port 2525)... ');
  try {
    const log = await smtpSend('test@example.com', mb.email, `E2E ${ts}`, 'Hello AgentMail!');
    console.log(''); log.forEach(l=>console.log('   '+l)); ok('Accepted');
  } catch(e) { console.log(''); ko('SMTP: '+e.message); }

  await sleep(400);
  process.stdout.write('\n4. Read inbox... ');
  const inbox = await api('GET',`/api/mailboxes/${mb.id}/messages`,null,auth);
  console.log('');
  if (inbox.error) ko(inbox.error);
  else {
    const msgs = inbox.messages || (Array.isArray(inbox) ? inbox : []);
    if (msgs.length>0) {
      ok(`${msgs.length} message(s)`); ok(`Subject: ${msgs[0].subject}`);
      const mid = msgs[0].id || msgs[0].uid;
      if (mid) {
        const full = await api('GET',`/api/mailboxes/${mb.id}/messages/${mid}`,null,auth);
        if (full.text||full.body) ok(`Body: "${(full.text||full.body).trim().slice(0,50)}"`);
      }
    } else ko('No messages: '+JSON.stringify(inbox).slice(0,100));
  }

  process.stdout.write('\n5. Cleanup... ');
  const del = await api('DELETE',`/api/mailboxes/${mb.id}`,null,{'x-admin-key':AK});
  console.log('');
  if (del.deleted) ok(`Deleted ${del.email}`); else ko(JSON.stringify(del));

  console.log(`\n${'='.repeat(45)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail>0) process.exit(1);
  console.log('ALL TESTS PASSED ✓');
}
run().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
