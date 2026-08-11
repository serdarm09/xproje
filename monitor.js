#!/usr/bin/env node
// ================================================================
//  🚨 CRYPTO ALARM MONİTÖRÜ v4 — TAM ÇALIŞAN SİSTEM
//  ─────────────────────────────────────────────────────────────
//  Kaynak 1: anvil.clutch.market     → YARD projesi
//  Kaynak 2: stonkbrokers.io/launcher → Yeni proje ilanları
//  Kaynak 3: @clockincoin (Nitter)    → CA / launch tweet'i
//
//  ★ Bağımlılık: axios + cheerio (npm install)
//  ★ SQLite/C++ GEREKMEZ — JSON cache kullanır
//  ★ Playwright kurulunca otomatik devreye girer
// ================================================================
'use strict';

const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const { execSync, exec } = require('child_process');

// ─────────────────────────────────────────
//  Modülleri güvenli yükle
// ─────────────────────────────────────────
let axios, cheerio, notifier, chromium;
try { axios    = require('axios').default; }    catch(_) {}
try { cheerio  = require('cheerio'); }          catch(_) {}
try { notifier = require('node-notifier'); }    catch(_) {}
try { ({ chromium } = require('playwright')); } catch(_) {}

// ─────────────────────────────────────────
//  Terminal renkleri
// ─────────────────────────────────────────
const c = {
  bold:    t => `\x1b[1m${t}\x1b[0m`,
  dim:     t => `\x1b[2m${t}\x1b[0m`,
  red:     t => `\x1b[31m${t}\x1b[0m`,
  green:   t => `\x1b[32m${t}\x1b[0m`,
  yellow:  t => `\x1b[33m${t}\x1b[0m`,
  blue:    t => `\x1b[34m${t}\x1b[0m`,
  magenta: t => `\x1b[35m${t}\x1b[0m`,
  cyan:    t => `\x1b[36m${t}\x1b[0m`,
};
const ts  = () => new Date().toLocaleTimeString('tr-TR', { hour12: false });
const log = (lbl, col, msg) => console.log(`${c.dim(`[${ts()}]`)} ${col(`[${lbl}]`)} ${msg}`);

// ─────────────────────────────────────────
//  Config
// ─────────────────────────────────────────
const CFG_PATH = path.join(__dirname, 'config.json');
const CFG      = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const CLOCKIN  = CFG.clockincoin_username || 'clockincoin';
const POLL_MS  = (CFG.web_poll_interval_seconds || 20) * 1000;
const YARD_KWS = (CFG.yard_keywords || ['YARD']).map(k => k.toUpperCase());
const KNOWN_SET = new Set(CFG.stonk_known_projects || []);

// Nitter host listesi
const NITTER_HOSTS = [
  'nitter.privacydev.net',
  'nitter.poast.org',
  'nitter.net',
  'nitter.it',
  'nitter.1d4.us',
];
let bestNitter = NITTER_HOSTS[0];

// ─────────────────────────────────────────
//  JSON Cache — (SQLite yerine, C++ yok)
// ─────────────────────────────────────────
const CACHE_PATH = path.join(__dirname, 'seen_cache.json');
let seenCache = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      seenCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch(_) { seenCache = {}; }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(seenCache, null, 2)); } catch(_) {}
}

function hasSeen(key)  { return !!seenCache[key]; }
function markSeen(key) {
  if (!seenCache[key]) {
    seenCache[key] = new Date().toISOString();
    saveCache();
  }
}

// Cache çok büyümesin — 30 günden eski girişleri temizle
function pruneCache() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [k, v] of Object.entries(seenCache)) {
    if (new Date(v).getTime() < cutoff) {
      delete seenCache[k];
      changed = true;
    }
  }
  if (changed) saveCache();
}

// ─────────────────────────────────────────
//  ALARM motoru
// ─────────────────────────────────────────
const ALERT_LOG = path.join(__dirname, 'alerts.log');

function fireAlarm(source, title, body, url = '') {
  // Terminal
  const border = c.bold(c.red('▓'.repeat(64)));
  console.log('\n' + border);
  console.log(c.bold(c.red(`  🚨  ALARM — ${source}`)));
  console.log(c.bold(c.yellow(`  ${title}`)));
  body.split('\n').forEach(l => l && console.log(c.cyan(`  ${l}`)));
  if (url) console.log(c.blue(`  🔗  ${url}`));
  console.log(border + '\n');

  // Log dosyası
  fs.appendFileSync(ALERT_LOG,
    `[${new Date().toISOString()}] ${source} | ${title} | ${body.slice(0,300)} | ${url}\n`
  );

  // macOS ses (3x Glass)
  if (CFG.alert_sound !== false) {
    const snd = '/System/Library/Sounds/Glass.aiff';
    [0, 450, 900].forEach(d => setTimeout(() => {
      try { execSync(`afplay "${snd}"`); } catch(_) {}
    }, d));
  }

  // macOS popup
  if (CFG.alert_popup !== false) {
    const safeT = title.replace(/['"\\]/g, ' ').slice(0, 80);
    const safeB = body.replace(/['"\\]/g, ' ').slice(0, 200);
    const buttons = url ? `{"Kapat","Siteye Git"}` : `{"Tamam"}`;
    const defBtn  = url ? `"Siteye Git"` : `"Tamam"`;
    exec(
      `osascript -e 'display alert "${safeT}" message "${safeB}" buttons ${buttons} default button ${defBtn}'`,
      (_err, stdout) => {
        if (stdout && stdout.includes('Siteye Git') && url) exec(`open "${url}"`);
      }
    );
  }

  // node-notifier (ek)
  if (notifier) {
    notifier.notify({ title: source, message: title, sound: false, wait: false });
  }
}

// ─────────────────────────────────────────
//  HTTP GET yardımcısı
// ─────────────────────────────────────────
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function httpGet(url, extraHeaders = {}) {
  if (axios) {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': DEFAULT_UA, ...extraHeaders },
      validateStatus: () => true,
    });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }
  // Axios yoksa built-in
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': DEFAULT_UA, ...extraHeaders },
      timeout: 12000,
    }, res => {
      let d = '';
      res.on('data', ch => d += ch);
      res.on('end', () => res.statusCode >= 400
        ? reject(new Error(`HTTP ${res.statusCode}`))
        : resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─────────────────────────────────────────
//  CA / launch tespit
// ─────────────────────────────────────────
const EVM_CA      = /\b(0x[a-fA-F0-9]{40})\b/;
const LAUNCH_WORD = /\b(ca[:\s]|contract[:\s]|launched|live[\s!]|deployed|mint[\s!]|token address|pump\.fun)\b/i;

function detectCA(text) {
  const ca = (text.match(EVM_CA) || [])[1] || null;
  return { ca, hasKeyword: LAUNCH_WORD.test(text) };
}

// ═══════════════════════════════════════════════════
//  MODÜL 1: @clockincoin → Nitter HTTP
// ═══════════════════════════════════════════════════
async function checkClockIn() {
  const hosts = [bestNitter, ...NITTER_HOSTS.filter(h => h !== bestNitter)];

  for (const host of hosts) {
    try {
      const html = await httpGet(`https://${host}/${CLOCKIN}`);
      let tweets = [];

      if (cheerio) {
        const $ = cheerio.load(html);
        $('.timeline-item').each((_, el) => {
          const href    = $(el).find('a[href*="/status/"]').first().attr('href') || '';
          const tweetId = href.split('/status/')[1]?.split(/[#?]/)[0]?.trim();
          const text    = $(el).find('.tweet-content').text().trim();
          const time    = $(el).find('.tweet-date a').attr('title') || '';
          if (tweetId && text) tweets.push({ id: tweetId, text, time });
        });
      } else {
        // Cheerio yoksa regex
        const idMatches   = [...html.matchAll(/\/status\/(\d{10,})/g)].map(m => m[1]);
        const textMatches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
          .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        [...new Set(idMatches)].slice(0, 10).forEach((id, i) => {
          if (textMatches[i]) tweets.push({ id, text: textMatches[i], time: '' });
        });
      }

      if (!tweets.length) { continue; }

      bestNitter = host;
      log('Twitter', c.green, `@${CLOCKIN} → ${host} ✓ (${tweets.length} tweet)`);

      for (const tw of tweets) {
        const key = `tw_${tw.id}`;
        if (hasSeen(key)) continue;
        markSeen(key);

        const { ca, hasKeyword } = detectCA(tw.text);
        if (ca) {
          fireAlarm('⚡ @clockincoin', '🔥 CA ATTI! Contract Address!',
            `${tw.text.slice(0, 350)}\n\n📝 CA: ${ca}${tw.time ? '\n⏰ ' + tw.time : ''}`,
            `https://x.com/${CLOCKIN}/status/${tw.id}`);
        } else if (hasKeyword) {
          fireAlarm('⚡ @clockincoin', '🚀 LAUNCH / LIVE TESPİT!',
            `${tw.text.slice(0, 350)}${tw.time ? '\n⏰ ' + tw.time : ''}`,
            `https://x.com/${CLOCKIN}/status/${tw.id}`);
        } else {
          log('Twitter', c.magenta, `Yeni tweet: ${tw.text.slice(0, 90)}…`);
        }
      }
      return;

    } catch(e) {
      log('Twitter', c.yellow, `${host}: ${e.message.slice(0, 60)}`);
    }
  }
  log('Twitter', c.red, 'Tüm Nitter sunucuları başarısız');
}

// ═══════════════════════════════════════════════════
//  MODÜL 2: Anvil → YARD Projesi
//  Next.js SSR → HTML içinde __NEXT_DATA__ var
// ═══════════════════════════════════════════════════
async function checkAnvil() {
  try {
    const html = await httpGet('https://anvil.clutch.market/');

    let found = false;

    // Yöntem A: __NEXT_DATA__ JSON
    const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (ndMatch) {
      const raw = ndMatch[1];
      for (const kw of YARD_KWS) {
        if (raw.toUpperCase().includes(kw)) {
          found = true;
          // market adreslerini çek
          const mLinks = [...raw.matchAll(/"\/market\/(0x[a-fA-F0-9]{40})"/g)].map(m => m[1]);
          const key = `anvil_yard_${kw}_${mLinks[0] || 'page'}`;
          if (!hasSeen(key)) {
            markSeen(key);
            fireAlarm('🟢 ANVIL', `${kw} Market BULUNDU! Erken başvur!`,
              `Anvil'de ${kw} projesi canlıya geçti!`,
              mLinks.length ? `https://anvil.clutch.market/market/${mLinks[0]}` : 'https://anvil.clutch.market/');
          }
        }
      }
    }

    // Yöntem B: Cheerio ile link tarama
    if (cheerio) {
      const $ = cheerio.load(html);
      $('a[href*="/market/"]').each((_, el) => {
        const text = $(el).text().trim().toUpperCase();
        const href = $(el).attr('href') || '';
        for (const kw of YARD_KWS) {
          if (text.includes(kw)) {
            const key = `anvil_link_${href}`;
            if (!hasSeen(key)) {
              markSeen(key);
              found = true;
              fireAlarm('🟢 ANVIL [link]', `${kw} Market Linki!`,
                `Market: ${$(el).text().trim()}`,
                `https://anvil.clutch.market${href}`);
            }
          }
        }
      });
    }

    // Yöntem C: Ham metin içinde YARD geçiyor mu (basit kontrol)
    if (!found) {
      const textOnly = html.replace(/<[^>]+>/g, ' ');
      for (const kw of YARD_KWS) {
        if (textOnly.toUpperCase().includes(` ${kw} `) || textOnly.toUpperCase().includes(`"${kw}"`)) {
          const key = `anvil_text_${kw}_${Date.now().toString().slice(-6)}`;
          if (!hasSeen(`anvil_text_${kw}_today`)) {
            markSeen(`anvil_text_${kw}_today`);
            fireAlarm('🟢 ANVIL [text]', `${kw} Sayfada Görüldü!`,
              'Sayfa metninde tespit edildi, kontrol et!', 'https://anvil.clutch.market/');
          }
        }
      }
    }

    log('Anvil', c.green, `HTTP scan OK${found ? ' — EŞLEŞMELİ!' : ''}`);

  } catch(e) {
    log('Anvil', c.red, `Hata: ${e.message.slice(0, 80)}`);
  }
}

// ═══════════════════════════════════════════════════
//  MODÜL 3: StonkBrokers → Yeni Proje
// ═══════════════════════════════════════════════════
async function checkStonk() {
  try {
    const html = await httpGet('https://stonkbrokers.io/launcher');
    const projects = [];

    if (cheerio) {
      const $ = cheerio.load(html);
      $('section[aria-label]').each((_, el) => {
        const lbl  = ($(el).attr('aria-label') || '').toLowerCase();
        if (lbl.includes('countdown') || lbl.includes('deploy your own')) return;
        const h2   = $(el).find('h2').first().text().trim();
        const desc = $(el).find('p').first().text().trim();
        if (h2 && h2.length > 1 && h2.length < 60) projects.push({ name: h2, desc });
      });

      // Badge'li projeler
      $('[class*="badge"]').each((_, el) => {
        const txt = $(el).text().trim();
        if (/SPECIAL|NEW|LAUNCH/i.test(txt)) {
          const section = $(el).closest('section');
          const h2 = section.find('h2').first().text().trim();
          const desc = section.find('p').first().text().trim();
          if (h2 && !projects.find(p => p.name === h2)) projects.push({ name: h2, desc });
        }
      });
    } else {
      // Regex fallback
      const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim())
        .filter(t => t.length > 1 && t.length < 60);
      h2s.forEach(name => projects.push({ name, desc: '' }));
    }

    let newCount = 0;
    for (const p of projects) {
      const key = `stonk_proj_${p.name}`;
      if (hasSeen(key)) continue;
      markSeen(key);
      if (KNOWN_SET.has(p.name)) continue;
      KNOWN_SET.add(p.name);
      newCount++;
      fireAlarm('🚀 STONK LAUNCHER', `YENİ PROJE: ${p.name} — Erken gir!`,
        p.desc || 'Yeni proje eklendi!', 'https://stonkbrokers.io/launcher');
    }

    log('Stonk', c.cyan,
      `${projects.length} proje | ${newCount} YENİ | [${projects.map(p => p.name).join(', ')}]`);

  } catch(e) {
    log('Stonk', c.red, `Hata: ${e.message.slice(0, 80)}`);
  }
}

// ═══════════════════════════════════════════════════
//  Playwright Deep Scan (Chromium kurulunca aktif)
// ═══════════════════════════════════════════════════
let pwBrowser = null;

async function tryInitPlaywright() {
  if (!chromium || pwBrowser) return;
  try {
    pwBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    log('System', c.green, '✅ Playwright/Chromium AKTİF — derin tarama açıldı');
  } catch(e) {
    // Henüz hazır değil, sessizce geç
    pwBrowser = null;
  }
}

async function playwrightDeepScan() {
  if (!pwBrowser) return;
  let ctx;
  try {
    ctx = await pwBrowser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff2,ttf,otf,ico}', r => r.abort());
    page.setDefaultTimeout(25000);

    // Anvil deep
    await page.goto('https://anvil.clutch.market/', { waitUntil: 'networkidle', timeout: 25000 });
    const anvilLinks = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/market/"]')].map(a => ({
        text: (a.innerText || '').trim(),
        href: a.getAttribute('href') || '',
      }))
    );
    for (const l of anvilLinks) {
      for (const kw of YARD_KWS) {
        if (l.text.toUpperCase().includes(kw)) {
          const key = `pw_anvil_${l.href}`;
          if (!hasSeen(key)) {
            markSeen(key);
            fireAlarm('🟢 ANVIL [DEEP]', `${kw} BULUNDU (derin tarama)!`, l.text,
              `https://anvil.clutch.market${l.href}`);
          }
        }
      }
    }
    log('Anvil', c.green, `[DEEP] ${anvilLinks.length} market linki tarandı`);

    // Stonk deep
    await page.goto('https://stonkbrokers.io/launcher', { waitUntil: 'networkidle', timeout: 25000 });
    const stonkPjs = await page.evaluate(() => {
      const r = [];
      document.querySelectorAll('section[aria-label]').forEach(s => {
        const lbl = (s.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.includes('countdown') || lbl.includes('deploy')) return;
        const h2   = s.querySelector('h2')?.textContent?.trim() || '';
        const desc = s.querySelector('p')?.textContent?.trim()  || '';
        if (h2.length > 1) r.push({ name: h2, desc });
      });
      return r;
    });
    for (const p of stonkPjs) {
      const key = `stonk_proj_${p.name}`;
      if (hasSeen(key)) continue;
      markSeen(key);
      if (KNOWN_SET.has(p.name)) continue;
      KNOWN_SET.add(p.name);
      fireAlarm('🚀 STONK [DEEP]', `YENİ PROJE: ${p.name}`, p.desc || '-', 'https://stonkbrokers.io/launcher');
    }
    log('Stonk', c.cyan, `[DEEP] ${stonkPjs.length} proje`);

    // @clockincoin deep
    const hosts = [bestNitter, ...NITTER_HOSTS.filter(h => h !== bestNitter)];
    for (const host of hosts) {
      try {
        await page.goto(`https://${host}/${CLOCKIN}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
        const dTweets = await page.evaluate(() => {
          const r = [];
          document.querySelectorAll('.timeline-item').forEach(el => {
            const href = el.querySelector('a[href*="/status/"]')?.getAttribute('href') || '';
            const id   = href.split('/status/')[1]?.split(/[#?]/)[0]?.trim();
            const text = el.querySelector('.tweet-content')?.innerText?.trim() || '';
            if (id && text) r.push({ id, text });
          });
          return r;
        });
        if (!dTweets.length) continue;
        bestNitter = host;
        for (const tw of dTweets) {
          const key = `tw_${tw.id}`;
          if (hasSeen(key)) continue;
          markSeen(key);
          const { ca, hasKeyword } = detectCA(tw.text);
          if (ca) {
            fireAlarm('⚡ @clockincoin [DEEP]', 'CA ATTI!',
              `${tw.text.slice(0, 350)}\n\n📝 CA: ${ca}`,
              `https://x.com/${CLOCKIN}/status/${tw.id}`);
          } else if (hasKeyword) {
            fireAlarm('⚡ @clockincoin [DEEP]', 'LAUNCH TESPİT!',
              tw.text.slice(0, 350), `https://x.com/${CLOCKIN}/status/${tw.id}`);
          }
        }
        log('Twitter', c.green, `[DEEP] ${dTweets.length} tweet → ${host}`);
        break;
      } catch(_) {}
    }

  } catch(e) {
    log('System', c.yellow, `Playwright deep scan hata: ${e.message.slice(0, 80)}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════
//  ANA DÖNGÜ
// ═══════════════════════════════════════════════════
let round = 0;

async function runAll() {
  round++;
  console.log(`\n${c.bold(c.cyan(`━━━ Tur #${round} [${ts()}] `) + '━'.repeat(42))}`);

  // HTTP scan — paralel çalıştır
  await Promise.allSettled([
    checkClockIn(),
    checkAnvil(),
    checkStonk(),
  ]);

  // Playwright deep scan (varsa)
  if (pwBrowser) {
    await playwrightDeepScan();
  } else {
    await tryInitPlaywright();
  }

  log('Poll', c.dim, `Tur #${round} tamamlandı → ${POLL_MS / 1000}s bekleniyor`);
}

async function main() {
  console.clear();
  console.log(c.bold(c.cyan(`
╔══════════════════════════════════════════════════════════════╗
║   🚨  CRYPTO ALARM MONİTÖRÜ  v4.0 — TAM SİSTEM            ║
╠══════════════════════════════════════════════════════════════╣
║  ⚡  @clockincoin  → Nitter HTTP (${String(POLL_MS/1000).padEnd(2)}s)                 ║
║  🟢  Anvil YARD    → HTTP + NEXT_DATA (${String(POLL_MS/1000).padEnd(2)}s)            ║
║  🚀  StonkBrokers  → HTTP + Cheerio (${String(POLL_MS/1000).padEnd(2)}s)              ║
║  🔍  Playwright    → Chromium hazır olunca devreye girer    ║
╠══════════════════════════════════════════════════════════════╣
║  📄  Log: alerts.log     ⏹  Dur: Ctrl+C                     ║
╚══════════════════════════════════════════════════════════════╝
`)));

  loadCache();
  pruneCache();

  // Playwright varsa hemen başlat
  await tryInitPlaywright();

  // İlk tur
  await runAll();

  // Periyodik
  const timer = setInterval(runAll, POLL_MS);

  process.on('SIGINT', async () => {
    clearInterval(timer);
    log('System', c.yellow, '🛑 Durduruluyor...');
    if (pwBrowser) await pwBrowser.close().catch(() => {});
    process.exit(0);
  });
}

main().catch(e => {
  console.error(c.bold(c.red('KRİTİK HATA:')), e.message);
  process.exit(1);
});
