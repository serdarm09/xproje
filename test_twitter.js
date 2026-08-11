#!/usr/bin/env node
// Token + API bağlantı testi
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CFG   = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TOKEN = decodeURIComponent(CFG.bearer_token);

console.log('🔑 Token (ilk 30 karakter):', TOKEN.slice(0, 30) + '...');

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twitter.com',
      path: endpoint,
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function test() {
  console.log('\n📡 Test 1: @clockincoin user ID...');
  const r1 = await apiGet('/2/users/by/username/clockincoin');
  console.log(`  Status: ${r1.status}`);
  console.log(`  Body: ${JSON.stringify(r1.body, null, 2).slice(0, 300)}`);

  if (r1.status === 200) {
    const uid = r1.body.data.id;
    console.log(`\n✅ User ID: ${uid}`);

    console.log('\n📡 Test 2: Son tweetler...');
    const r2 = await apiGet(`/2/users/${uid}/tweets?max_results=5&tweet.fields=text,created_at`);
    console.log(`  Status: ${r2.status}`);
    if (r2.body?.data) {
      r2.body.data.forEach((t, i) => {
        console.log(`  [${i+1}] ${t.text.slice(0, 100)}`);
      });
    }
  } else {
    console.log('\n❌ Token hatalı veya API erişimi yok');
  }

  console.log('\n📡 Test 3: Stream kuralları...');
  const r3 = await apiGet('/2/tweets/search/stream/rules');
  console.log(`  Status: ${r3.status}`);
  console.log(`  Kurallar: ${JSON.stringify(r3.body).slice(0, 200)}`);
}

test().catch(console.error);
