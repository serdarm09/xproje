#!/usr/bin/env node
// ================================================================
//  🚨 CRYPTO ALARM MONİTÖRÜ v3 — HIBRID OPTIMAL
//  ─────────────────────────────────────────────────────────────
//  ⚡ Twitter: Nitter scraping (hızlı, token gerektirmez)
//             + Twitter API v2 (token çalışırsa ANLIK stream)
//  🔍 Anvil:  Playwright poll — YARD projesi
//  🚀 Stonk:  Playwright poll — Yeni launcher projeleri
//  🔊 macOS:  Ses alarm + Popup + Tarayıcı açma
// ================================================================
'use strict';

const { chromium }  = require('playwright');
const Database      = require('better-sqlite3');
const { execSync, exec } = require('child_process');
const https         = require('https');
const path          = require('path');
const fs            = require('fs');

// ────────────────────────────────────────
//  Renkli log
// ────────────────────────────────────────
const c = {
  reset:   t => `\x1b[0m${t}\x1b[0m`,
  bold:    t => `\x1b[1m${t}\x1b[0m`,
  dim:     t => `\x1b[2m${t}\x1b[0m`,
  red:     t => `\x1b[31m${t}\x1b[0m`,
  green:   t => `\x1b[32m${t}\x1b[0m`,
  yellow:  t => `\x1b[33m${t}\x1b[0m`,
  blue:    t => `\x1b[34m${t}\x1b[0m`,
  magenta: t => `\x1b[35m${t}\x1b[0m`,
  cyan:    t => `\x1b[36m${t}\x1b[0m`,
};

function now() { return new Date().toLocaleTimeString('tr-TR', { hour12: false }); }
function log(lbl, col, msg) { console.log(`${c.dim(`[${now()}]`)} ${col(`[${lbl}]`)} ${msg}`); }

// ────────────────────────────────────────
//  Config
// ────────────────────────────────────────
const CFG       = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BEARER    = decodeURIComponent(CFG.bearer_token || '');
const CLOCKIN   = CFG.clockincoin_username || 'clockincoin';
const POLL_MS   = (CFG.web_poll_interval_seconds || 15) * 1000;
const YARD_KWS  = CFG.yard_keywords || ['YARD'];
const KNOWN_SET = new Set(CFG.stonk_known_projects || []);

// Nitter instances (fallback chain)
const NITTER_HOSTS = [
  'nitter.privacydev.net',
  'nitter.net',
  'nitter.it',
  'nitter.poast.org',
];

// ────────────────────────────────────────
//  SQLite
// ────────────────────────────────────────
const db = new Database(path.join(__dirname, 'seen.db'));
db.exec(`CREATE TABLE IF NOT EXISTS seen (
  key TEXT PRIMARY KEY,
  seen_at TEXT DEFAULT (datetime('now','localtime'))
)`);
const hasSeen  = k => !!db.prepare('SELECT 1 FROM seen WHERE key=?').get(k);
const markSeen = k => db.prepare('INSERT OR IGNORE INTO seen (key) VALUES (?)').run(k);

// ────────────────────────────────────────
//  ALARM
// ────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'alerts.log');

function fireAlarm(source, title, body, url = '') {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${source} | ${title} | ${body.slice(0,300)} | ${url}`;
  fs.appendFileSync(LOG_FILE, line + '\n');

  console.log('\n' + c.bold(c.red('█'.repeat(64))));
  console.log(c.bold(c.red(`  🚨 ALARM — ${source}`)));
  console.log(c.bold(c.yellow(`  ${title}`)));
  const bodyLines = body.slice(0, 400).split('\n');
  bodyLines.forEach(l => console.log(c.cyan(`  ${l}`)));
  if (url) console.log(c.blue(`  🔗 ${url}`));
  console.log(c.bold(c.red('█'.repeat(64))) + '\n');

  // Ses — 3 kez Ping
  if (CFG.alert_sound !== false) {
    [0, 500, 1000].forEach(delay => {
      setTimeout(() => {
        try { execSync('afplay /System/Library/Sounds/Glass.aiff'); } catch(_) {}
      }, delay);
    });
  }

  // macOS popup
  if (CFG.alert_popup !== false) {
    const safeT = title.replace(/['"\\]/g, ' ').slice(0, 80);
    const safeB = body.replace(/['"\\]/g, ' ').slice(0, 200);
    const btns  = url ? `{"Kapat", "Siteye Git"}` : `{"Tamam"}`;
    const defB  = url ? `"Siteye Git"` : `"Tamam"`;
    exec(
      `osascript -e 'display alert "${safeT}" message "${safeB}" buttons ${btns} default button ${defB}'`,
      (err, stdout) => {
        if (!err && url && stdout && stdout.includes('Siteye Git')) {
          exec(`open "${url}"`);
        }
      }
    );
  }
}

// ────────────────────────────────────────
//  CA Tespit Patternleri
// ────────────────────────────────────────
const EVM_CA    = /\b(0x[a-fA-F0-9]{40})\b/;
const LAUNCH_KW = /\b(ca[:\s]|contract[:\s]|launched|live now|deployed|mint|token address)\b/i;

function detectCA(text) {
  const evmMatch = text.match(EVM_CA);
  const hasKw    = LAUNCH_KW.test(text);
  return { ca: evmMatch ? evmMatch[1] : null, hasKeyword: hasKw };
}

// ════════════════════════════════════════
//  MODÜL 1: @clockincoin via Playwright
//  (Nitter HTML → hızlı, güvenilir)
// ════════════════════════════════════════
let twitterPage = null;
let nitterWorkingHost = null;

async function checkClockInCoin(page) {
  // Nitter hosts'u sırayla dene
  const hosts = nitterWorkingHost
    ? [nitterWorkingHost, ...NITTER_HOSTS.filter(h => h !== nitterWorkingHost)]
    : NITTER_HOSTS;

  for (const host of hosts) {
    try {
      const url = `https://${host}/${CLOCKIN}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });

      // Hata sayfası mı?
      const title = await page.title();
      if (title.toLowerCase().includes('error') || title.toLowerCase().includes('blocked')) {
        continue;
      }

      const tweets = await page.evaluate(() => {
        const results = [];
        // Nitter timeline
        document.querySelectorAll('.timeline-item').forEach(item => {
          const tweetLink = item.querySelector('a.tweet-link') || item.querySelector('a[href*="/status/"]');
          const tweetId   = tweetLink?.getAttribute('href')?.split('/status/')[1]?.split('#')[0];
          const textEl    = item.querySelector('.tweet-content');
          const text      = textEl ? textEl.innerText || textEl.textContent : '';
          const time      = item.querySelector('.tweet-date a')?.getAttribute('title') || '';
          if (tweetId && text.trim()) {
            results.push({ id: tweetId.trim(), text: text.trim(), time });
          }
        });
        return results;
      });

      if (tweets.length === 0) continue;

      nitterWorkingHost = host;
      log('Twitter', c.green, `@${CLOCKIN} → ${host} ✓ (${tweets.length} tweet)`);

      for (const tw of tweets) {
        const key = `tw_${tw.id}`;
        if (hasSeen(key)) continue;
        markSeen(key);

        const { ca, hasKeyword } = detectCA(tw.text);
        const isImportant = ca || hasKeyword;

        if (ca) {
          fireAlarm(
            '⚡ @clockincoin',
            `CA ATTI! Contract Address BULUNDU!`,
            `${tw.text}\n\n📝 CA: ${ca}\n⏰ ${tw.time}`,
            `https://x.com/${CLOCKIN}/status/${tw.id}`
          );
        } else if (hasKeyword) {
          fireAlarm(
            '⚡ @clockincoin',
            `LAUNCH / LIVE TESPİT EDİLDİ!`,
            `${tw.text}\n⏰ ${tw.time}`,
            `https://x.com/${CLOCKIN}/status/${tw.id}`
          );
        } else {
          log('Twitter', c.magenta, `Yeni tweet (rutin): ${tw.text.slice(0, 80)}`);
        }
      }

      return; // Başarılı, döngüyü kes

    } catch(e) {
      log('Twitter', c.yellow, `${host} hata: ${e.message.slice(0, 60)}`);
    }
  }
  log('Twitter', c.red, 'Tüm Nitter sunucuları başarısız');
}

// ════════════════════════════════════════
//  MODÜL 2: Anvil — YARD
// ════════════════════════════════════════
async function checkAnvil(page) {
  try {
    await page.goto('https://anvil.clutch.market/', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    const hits = await page.evaluate((kws) => {
      const found = [];
      const addHit = (text, href) => {
        if (!found.find(f => f.href === href)) {
          found.push({ text: text.trim().slice(0, 200), href });
        }
      };

      // Market kartları
      document.querySelectorAll('a[href*="/market/"]').forEach(el => {
        const text = el.innerText || el.textContent || '';
        for (const kw of kws) {
          if (text.toUpperCase().includes(kw)) addHit(text, el.getAttribute('href'));
        }
      });

      // Tüm sayfa içeriği
      const pageText = document.body.innerText || '';
      for (const kw of kws) {
        if (pageText.toUpperCase().includes(kw)) {
          const link = document.querySelector(`a[href*="/market/"]`);
          if (link) addHit(`Sayfa içinde ${kw} tespit edildi`, link.getAttribute('href'));
        }
      }
      return found;
    }, YARD_KWS.map(k => k.toUpperCase()));

    for (const h of hits) {
      const key = `anvil_${h.href}`;
      if (!hasSeen(key)) {
        markSeen(key);
        fireAlarm('🟢 ANVIL', `YARD Market BULUNDU! Erken başvur!`, h.text, `https://anvil.clutch.market${h.href}`);
      }
    }

    log('Anvil', c.green, `Tarama tamamlandı — ${hits.length} eşleşme`);

  } catch(e) {
    log('Anvil', c.red, `Hata: ${e.message.slice(0, 80)}`);
  }
}

// ════════════════════════════════════════
//  MODÜL 3: StonkBrokers Launcher
// ════════════════════════════════════════
async function checkStonkBrokers(page) {
  try {
    await page.goto('https://stonkbrokers.io/launcher', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    const projects = await page.evaluate(() => {
      const found = [];
      document.querySelectorAll('section[aria-label]').forEach(s => {
        const lbl = (s.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.includes('countdown') || lbl.includes('deploy your own')) return;
        const h2 = s.querySelector('h2')?.textContent?.trim() || '';
        const desc = s.querySelector('p')?.textContent?.trim() || '';
        if (h2.length > 1) found.push({ name: h2, desc: desc.slice(0, 150) });
      });
      // Alternatif: yeni proje banner'ları
      document.querySelectorAll('[class*="badge"], [class*="lm-badge"]').forEach(b => {
        const text = b.textContent?.trim() || '';
        if (text.includes('SPECIAL') || text.includes('NEW') || text.includes('LAUNCH')) {
          const section = b.closest('section');
          if (section) {
            const h2 = section.querySelector('h2')?.textContent?.trim();
            const desc = section.querySelector('p')?.textContent?.trim() || '';
            if (h2 && !found.find(f => f.name === h2)) {
              found.push({ name: h2, desc: desc.slice(0, 150) });
            }
          }
        }
      });
      return found;
    });

    let newCount = 0;
    for (const p of projects) {
      const key = `stonk_${p.name}`;
      if (!hasSeen(key)) {
        markSeen(key);
        if (!KNOWN_SET.has(p.name)) {
          newCount++;
          KNOWN_SET.add(p.name);
          fireAlarm('🚀 STONK', `YENİ PROJE: ${p.name}`, p.desc || '-', 'https://stonkbrokers.io/launcher');
        }
      }
    }

    log('Stonk', c.cyan, `${projects.length} proje | ${newCount} yeni | [${projects.map(p=>p.name).join(', ')}]`);

  } catch(e) {
    log('Stonk', c.red, `Hata: ${e.message.slice(0, 80)}`);
  }
}

// ════════════════════════════════════════
//  Ana Döngü
// ════════════════════════════════════════
async function main() {
  console.clear();
  console.log(c.bold(c.cyan(`
╔══════════════════════════════════════════════════════════════╗
║   🚨  CRYPTO ALARM MONİTÖRÜ  v3.0  — HİBRİD OPTIMAL       ║
╠══════════════════════════════════════════════════════════════╣
║  ⚡  @clockincoin  →  Nitter scraping (${String(POLL_MS/1000).padEnd(2)}s poll)            ║
║  🟢  Anvil         →  YARD projesi (${String(POLL_MS/1000).padEnd(2)}s poll)              ║
║  🚀  StonkBrokers  →  Yeni launcher (${String(POLL_MS/1000).padEnd(2)}s poll)             ║
║  🔊  macOS         →  Ses + Popup + Tarayıcı aç             ║
╠══════════════════════════════════════════════════════════════╣
║  📄  Log dosyası: alerts.log                                 ║
║  ⏹   Durdurmak için: Ctrl+C                                  ║
╚══════════════════════════════════════════════════════════════╝
`)));

  log('System', c.bold, 'Playwright başlatılıyor...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  log('System', c.green, '✅ Playwright hazır');

  let round = 0;

  async function runAll() {
    round++;
    log('Poll', c.bold, `━━━ Tur #${round} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const ctx  = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);

    // Gereksiz kaynakları engelle
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,eot,ico}', r => r.abort());
    await page.route('**/analytics**', r => r.abort());
    await page.route('**/gtag**', r => r.abort());

    try {
      log('Poll', c.magenta, '→ @clockincoin kontrol...');
      await checkClockInCoin(page);

      log('Poll', c.green, '→ Anvil YARD kontrol...');
      await checkAnvil(page);

      log('Poll', c.cyan, '→ StonkBrokers kontrol...');
      await checkStonkBrokers(page);

    } catch(e) {
      log('Poll', c.red, `Genel hata: ${e.message}`);
    } finally {
      await ctx.close().catch(() => {});
    }

    const nextSec = POLL_MS / 1000;
    log('Poll', c.dim, `✓ Tamamlandı. Sonraki: ${nextSec}s`);
  }

  // İlk çalıştırma (hemen)
  await runAll();

  // Periyodik
  setInterval(runAll, POLL_MS);

  // SIGINT handler
  process.on('SIGINT', async () => {
    log('System', c.yellow, 'Durduruluyor...');
    await browser.close();
    process.exit(0);
  });
}

main().catch(e => {
  console.error(c.bold(c.red('KRİTİK:')), e.message);
  process.exit(1);
});
