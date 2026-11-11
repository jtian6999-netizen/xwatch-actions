'use strict';

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile, execFileSync } = require('child_process');

const ROOT = __dirname;
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const POSTS_FILE = path.join(DATA_DIR, 'posts.jsonl');
const LOG_FILE = path.join(DATA_DIR, 'watch.log');
const COOKIES_FILE = process.env.WATCH_COOKIES_FILE || path.join(DATA_DIR, 'cookies.json');
const UA = process.env.WATCH_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

// ---------- 浏览器 / 登录态 ----------
// mode=cdp   ：连接本机常驻 Chrome 的调试端口（Windows 现状，登录态在 chrome-profile 里）
// mode=launch：自己拉起无头 Chromium，登录态用 cookie 注入（服务器 / Docker 用）
function browserMode(cfg) {
  const m = process.env.WATCH_BROWSER_MODE || (cfg.browser && cfg.browser.mode) || 'cdp';
  return String(m).toLowerCase();
}

function loadCookies() {
  let arr = [];
  const rawEnv = process.env.WATCH_COOKIES;
  if (rawEnv && rawEnv.trim()) {
    try {
      const j = JSON.parse(rawEnv);
      if (Array.isArray(j)) arr = j;
    } catch (e) {}
    if (!arr.length) {
      for (const part of rawEnv.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) arr.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
      }
    }
  } else if (fs.existsSync(COOKIES_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      if (Array.isArray(j)) arr = j;
    } catch (e) { log('cookies file parse error: ' + e.message); }
  }
  const ok = ['Strict', 'Lax', 'None'];
  return arr.filter(c => c && c.name && c.value != null).map(c => {
    const out = {
      name: String(c.name),
      value: String(c.value),
      domain: c.domain || '.x.com',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: c.httpOnly !== false,
      sameSite: ok.includes(c.sameSite) ? c.sameSite : 'Lax'
    };
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    return out;
  });
}

// launch 模式也要走代理（国内家用主机 / 本机测试）；云端 WATCH_NO_PROXY=1 时自动关闭
function launchProxy(cfg) {
  if (process.env.WATCH_NO_PROXY) return '';
  if (process.env.WATCH_PROXY) return process.env.WATCH_PROXY;
  const p = cfg.proxy || {};
  if (p.enabled && p.host && p.port) return `http://${p.host}:${p.port}`;
  return '';
}

// launch 模式优先用完整 Chrome（Chrome for Testing），不要用 headless shell：
// Playwright 的 headless shell 更容易被 Cloudflare 判成机器人（页面标题 "Just a moment..."）
function findFullChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')].filter(Boolean);
  for (const base of bases) {
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch (e) { continue; }
    for (const d of dirs) {
      if (!/^chromium-\d+$/.test(d)) continue;
      for (const rel of [['chrome-linux64', 'chrome'], ['chrome-win64', 'chrome.exe'], ['chrome-linux', 'chrome']]) {
        const p = path.join(base, d, rel[0], rel[1]);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

async function openBrowser(cfg) {
  const mode = browserMode(cfg);
  if (mode === 'launch') {
    const opts = {
      headless: true,
      executablePath: findFullChrome(),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
        '--no-default-browser-check', '--disable-blink-features=AutomationControlled']
    };
    const proxy = launchProxy(cfg);
    if (proxy) opts.proxy = { server: proxy };
    const browser = await chromium.launch(opts);
    if (proxy) log(`launch proxy: ${proxy}`);
    return { browser, external: false, mode };
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  return { browser, external: true, mode };
}

async function getContext(browser, external) {
  if (external) return browser.contexts()[0];
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 900 }
  });
  const cookies = loadCookies();
  if (!cookies.length) {
    log('WARN: 没有可用 cookie（WATCH_COOKIES 环境变量或 data/cookies.json），X 大概率未登录');
  } else {
    await ctx.addCookies(cookies);
    log(`cookies injected: ${cookies.length}`);
  }
  return ctx;
}

let state = { seen: [], firstRunDone: false, lastRun: null, notLoggedIn: false };
if (fs.existsSync(STATE_FILE)) {
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}
}
const seen = new Set(state.seen || []);

function saveState() {
  if (state.seen.length > 5000) state.seen = state.seen.slice(-5000);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// ---------- scoring ----------
const RE_RESET = /\b(reset|resets|resetting|restored|replenish\w*|额度重置)\b/i;
const RE_LIMIT = /\b(limit|limits|limited|quota|credits?|usage|capacity|rate[\s-]?limit|allowance|cap)\b/i;
const RE_TOPIC = /\b(codex|chatgpt|openai|gpt-?5|gpt-?4|o[34])\b/i;
const RE_ANNOUNCE = /\b(available|rolling out|starting|now live|enabled|increased|doubled|boost|extra|more|free|bonus)\b/i;

function scoreTweet(t) {
  const text = (t.text || '');
  let s = 0;
  const reasons = [];
  if (RE_TOPIC.test(text)) { s += 2; reasons.push('topic'); }
  if (RE_RESET.test(text)) { s += 4; reasons.push('reset'); }
  if (RE_LIMIT.test(text)) { s += 2; reasons.push('limit'); }
  if (RE_ANNOUNCE.test(text)) { s += 1; reasons.push('announce'); }
  if (t.isRetweet) { s -= 3; reasons.push('-retweet'); }
  if (t.isReply) { s -= 1; reasons.push('-reply'); }
  return { s, reasons };
}

// ---------- tweet parsing ----------
function pickText(t) {
  const note = t.note_tweet && t.note_tweet.note_tweet_results &&
    t.note_tweet.note_tweet_results.result && t.note_tweet.note_tweet_results.result.text;
  if (note) return note;
  return (t.legacy && t.legacy.full_text) || '';
}

function parseTweet(t) {
  const l = t.legacy || {};
  const user = (t.core && t.core.user_results && t.core.user_results.result) || {};
  const screenName = (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name) || '';
  let createdAt = null;
  try { createdAt = new Date(l.created_at).toISOString(); } catch (e) {}
  return {
    id: t.rest_id,
    screenName,
    text: pickText(t),
    createdAt,
    url: `https://x.com/${screenName}/status/${t.rest_id}`,
    isRetweet: !!l.retweeted_status_result,
    isReply: !!l.in_reply_to_status_id_str,
    fav: l.favorite_count || 0,
    rt: l.retweet_count || 0,
    replies: l.reply_count || 0
  };
}

function extractTweets(json) {
  const out = [];
  const stack = [json];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const n of node) stack.push(n); continue; }
    if (node.__typename === 'Tweet' && node.rest_id && node.legacy) {
      out.push(parseTweet(node));
      if (node.legacy.retweeted_status_result) {
        out.push(parseTweet(node.legacy.retweeted_status_result.result));
      }
      continue;
    }
    for (const k in node) {
      if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
  }
  const map = new Map();
  for (const t of out) if (t.id) map.set(t.id, t);
  return [...map.values()];
}

// ---------- collection ----------
async function isLoggedIn(page) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  const u = page.url();
  return !u.includes('/i/jf/') && !u.includes('/login') && !u.includes('/i/flow');
}

async function collectOnce(ctx, screenName) {
  const page = await ctx.newPage();
  const found = [];
  const diag = { graphql: 0, timeline: 0, statuses: [] };
  const handler = async (resp) => {
    const u = resp.url();
    if (!u.includes('/graphql/')) return;
    diag.graphql++;
    if (!/User[A-Za-z]*Timeline|UserTweets/.test(u)) return;
    diag.timeline++;
    const tag = `${resp.status()} ${u.split('/graphql/')[1].split('?')[0]}`;
    if (diag.statuses.length < 4) diag.statuses.push(tag);
    try {
      const j = await resp.json();
      const arr = extractTweets(j);
      if (arr.length) {
        found.push(...arr);
        log(`  graphql ${u.split('/graphql/')[1].split('?')[0]} -> ${arr.length}`);
      } else {
        const errors = j && (j.errors || (j.data && j.data.errors));
        if (errors) log(`  graphql payload error @${screenName}: ${JSON.stringify(errors).slice(0, 300)}`);
      }
    } catch (e) {
      log(`  graphql parse error @${screenName} ${tag}: ${e.message}`);
    }
  };
  page.on('response', handler);
  try {
    const urls = [`https://x.com/${screenName}`];
    for (const u of urls) {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(6000);
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.scrollBy(0, 2500)).catch(() => {});
        await page.waitForTimeout(2500);
      }
    }
  } catch (e) {
    log(`  collect error @${screenName}: ${e.message}`);
  } finally {
    page.off('response', handler);
    if (!found.length) {
      let title = '';
      try { title = await page.title(); } catch (e) {}
      log(`  diag @${screenName}: graphql=${diag.graphql} timeline=${diag.timeline} [${diag.statuses.join(' | ')}] title="${title}" url=${page.url()}`);
    }
    await page.close().catch(() => {});
  }
  const map = new Map();
  for (const t of found) {
    if (!t.id) continue;
    if ((t.screenName || '').toLowerCase() !== screenName.toLowerCase()) continue;
    map.set(t.id, t);
  }
  return [...map.values()];
}

async function collect(ctx, screenName) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await collectOnce(ctx, screenName);
    if (res.length) return res;
    log(`  retry @${screenName} attempt ${attempt}/3`);
    await new Promise(r => setTimeout(r, 4000));
  }
  return [];
}

// ---------- notify ----------
const TOAST = path.join(ROOT, 'toast.ps1');
function pushWindows(title, message) {
  if (process.platform !== 'win32') return; // 云端 Linux 容器没有桌面通知
  execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST, '-Title', title, '-Message', message],
    { windowsHide: true },
    (e) => { if (e) log('toast error: ' + e.message); });
}

async function pushWecom(cfg, content) {
  const w = cfg.channels.wecom;
  if (!w || !w.enabled) return;
  if (w.webhook) {
    try {
      const r = await fetch(w.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: content.slice(0, 2000) } })
      }).then(x => x.json());
      if (r.errcode !== 0) log('wecom webhook error: ' + JSON.stringify(r));
      else log('wecom webhook sent');
    } catch (e) {
      log('wecom webhook exception: ' + e.message);
    }
    return;
  }
  if (!w.corpid || !w.secret || !w.touser) return;
  try {
    const tk = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(w.corpid)}&corpsecret=${encodeURIComponent(w.secret)}`).then(r => r.json());
    if (tk.errcode !== 0) return log('wecom token error: ' + JSON.stringify(tk));
    const body = {
      touser: w.touser, msgtype: 'text', agentid: w.agentid,
      text: { content: content.slice(0, 2000) },
      safe: 0
    };
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tk.access_token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(x => x.json());
    if (r.errcode !== 0) log('wecom send error: ' + JSON.stringify(r));
    else log('wecom sent');
  } catch (e) {
    log('wecom exception: ' + e.message);
  }
}

async function translate(text, cfg) {
  if (!text) return '';
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  const tr = cfg.translate || {};
  if (tr.provider === 'deepseek' && tr.apiKey) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tr.apiKey },
        body: JSON.stringify({
          model: tr.model || 'deepseek-chat',
          messages: [
            { role: 'system', content: '你是推文翻译。把用户给的英文推文翻译成自然、口语化的中文，保留原意、语气、梗和 emoji，不要加解释，不要加引号，只输出译文。' },
            { role: 'user', content: text }
          ],
          temperature: 0.3,
          max_tokens: 800
        }),
        signal: AbortSignal.timeout(30000)
      }).then(x => x.json());
      const out = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
      if (out) return out.trim();
      log('deepseek translate error: ' + JSON.stringify(r.error || r));
    } catch (e) {
      log('deepseek translate exception: ' + e.message);
    }
  }
  try {
    const q = encodeURIComponent(text.slice(0, 1500));
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) }).then(x => x.json());
    return (r[0] || []).map(seg => (seg && seg[0]) || '').join('').trim();
  } catch (e) {
    log('translate fallback error: ' + e.message);
    return '';
  }
}

async function buildMessage(t, cfg) {
  const label = t.screenName === 'OpenAI' ? 'OpenAI 官方' : '@' + t.screenName;
  const title = `【Codex 动态】${label}`;
  const raw = t.text.replace(/\s+/g, ' ').trim();
  const zh = await translate(raw, cfg);
  const when = t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const lines = ['@' + t.screenName];
  if (zh) lines.push('中文：' + zh);
  lines.push('原文：' + raw.slice(0, 300));
  lines.push(when + '（北京时间）  ' + t.url);
  return { title, body: lines.join('\n') };
}

// ---------- quiet notice ----------
function fmtBJ(iso) {
  if (!iso) return '未知';
  return new Date(iso).toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function buildQuietMessage(cfg, state) {
  const lp = state.lastPostAt || {};
  const lines = ['【X Watch】暂无新帖（抓取正常）'];
  for (const acct of cfg.accounts) {
    const label = acct === 'OpenAI' ? 'OpenAI 官方' : '@' + acct;
    lines.push(`${label} 最新：${fmtBJ(lp[acct])}`);
  }
  lines.push('有新帖会立即推送，本条仅为存活提示。');
  return lines.join('\n');
}


// ---------- main ----------
let consecutiveEmpty = 0;
let emptyAlerted = false;
let proxyAlerted = false;
let openFailStreak = 0;

function checkProxy(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = v => { try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.setTimeout(timeout);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

async function cycle() {
  const cfg = loadConfig();

  const useProxy = process.env.WATCH_NO_PROXY ? false : !!(cfg.proxy && cfg.proxy.enabled);
  if (useProxy) {
    let ok = await checkProxy(cfg.proxy.host, cfg.proxy.port);
    for (let i = 0; i < 6 && !ok; i++) {
      log('proxy not ready, wait 10s');
      await new Promise(r => setTimeout(r, 10000));
      ok = await checkProxy(cfg.proxy.host, cfg.proxy.port);
    }
    if (!ok) {
      if (!proxyAlerted) {
        proxyAlerted = true;
        log(`ALERT: proxy ${cfg.proxy.host}:${cfg.proxy.port} unreachable, skip cycle`);
        pushWindows('代理断开', 'X 抓取已暂停，检查代理软件');
        await pushWecom(cfg, `【X Watch】代理 ${cfg.proxy.host}:${cfg.proxy.port} 连不上，X 抓取暂停中。`);
      }
      return;
    }
    if (proxyAlerted) { proxyAlerted = false; log('proxy recovered'); }
  }

  let browser;
  let external = true;
  const mode = browserMode(cfg);
  try {
    const opened = await openBrowser(cfg);
    browser = opened.browser;
    external = opened.external;
    log(`browser ready (mode=${opened.mode})`);
    openFailStreak = 0;
  } catch (e) {
    log(`browser open failed (mode=${mode}): ${e.message}`);
    openFailStreak++;
    // 云上（launch）浏览器起不来是最致命的静默失败：必须推企微，否则没人知道
    if (openFailStreak === 2 || openFailStreak === 6) {
      await pushWecom(cfg, `【X Watch】浏览器启动失败 ${openFailStreak} 次：${String(e.message).slice(0, 120)}`);
    }
    if (openFailStreak >= 6) {
      log('SELF_HEAL: browser keeps failing to open, exit for restart');
      process.exit(5);
    }
    if (mode === 'cdp') {
      try {
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'start-chrome.ps1')], { windowsHide: true }, () => {});
      } catch (e2) { log('relaunch error: ' + e2.message); }
    }
    return;
  }
  try {
    const ctx = await getContext(browser, external);
    let page = ctx.pages().find(p => p.url().includes('x.com'));
    if (!page) page = await ctx.newPage();

    const logged = await isLoggedIn(page);
    if (!logged) {
      const hint = external
        ? '请在专用 Chrome 窗口登录 X'
        : '云端 cookie 失效，需要重新导出 auth_token/ct0 并更新 WATCH_COOKIES';
      if (!state.notLoggedIn) {
        state.notLoggedIn = true;
        log('NOT_LOGGED_IN: ' + hint);
        pushWindows('X Watch 需要登录', hint);
        await pushWecom(cfg, `【X Watch】X 登录态失效。${hint}`);
      }
      saveState();
      return;
    }
    if (state.notLoggedIn) { state.notLoggedIn = false; log('login detected'); }

    const newly = [];
    let total = 0;
    const latest = {};
    for (const acct of cfg.accounts) {
      log(`fetching @${acct}`);
      const tweets = await collect(ctx, acct);
      log(`  got ${tweets.length} tweets from @${acct}`);
      total += tweets.length;
      for (const t of tweets) {
        if (!t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        state.seen.push(t.id);
        const { s, reasons } = scoreTweet(t);
        t.score = s; t.reasons = reasons;
        fs.appendFileSync(POSTS_FILE, JSON.stringify(t) + '\n');
        newly.push(t);
      }
      const orig = tweets
        .filter(t => t.createdAt && !t.isReply && !t.isRetweet)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (orig) latest[acct] = orig.createdAt;
    }
    if (Object.keys(latest).length) {
      state.lastPostAt = Object.assign({}, state.lastPostAt || {}, latest);
    }

    if (total === 0) {
      consecutiveEmpty++;
      state.emptyStreak = (state.emptyStreak || 0) + 1;
      if (consecutiveEmpty >= 2 && !emptyAlerted) {
        emptyAlerted = true;
        log('ALERT: consecutive empty cycles, scraper or proxy broken');
        pushWindows('X Watch 抓取异常', '连续 2 轮抓不到帖子，自动重启抓取进程');
        await pushWecom(cfg, `【X Watch】连续 ${consecutiveEmpty} 轮抓不到帖子（0 帖），抓取可能已异常，即将自动重启抓取进程。`);
      }
      // 自愈：进程太久会卡成 0 帖（2026-11-09 出现过），重启进程；再不行连专用 Chrome 一起重建
      if (state.emptyStreak >= 6) {
        log(`SELF_HEAL: emptyStreak=${state.emptyStreak}, restart`);
        await pushWecom(cfg, `【X Watch】已连续 ${state.emptyStreak} 轮 0 帖，正在重建抓取进程与浏览器。`);
        if (external) {
          try {
            execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
              "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
            ], { windowsHide: true, timeout: 20000 });
          } catch (e) { log('chrome kill error: ' + e.message); }
        }
        state.emptyStreak = 0;
        saveState();
        await new Promise(r => setTimeout(r, 3000));
        process.exit(4);
      }
      if (state.emptyStreak >= 2) {
        log(`SELF_HEAL: emptyStreak=${state.emptyStreak}, restart watcher process`);
        consecutiveEmpty = 0;
        emptyAlerted = false;
        saveState();
        process.exit(3);
      }
    } else {
      consecutiveEmpty = 0;
      emptyAlerted = false;
      state.emptyStreak = 0;
    }

    let pushed = 0;
    if (!state.firstRunDone) {
      state.firstRunDone = true;
      log(`first run: stored ${newly.length} tweets, no push`);
    } else {
      for (const t of newly) {
        const ageH = t.createdAt ? (Date.now() - new Date(t.createdAt).getTime()) / 3600000 : 0;
        if (ageH > cfg.maxAgeHours) continue;
        if (t.isReply) continue;   // 不回推回复/评论
        if (t.isRetweet) continue; // 不回推转推
        const always = (cfg.alwaysPushAccounts || []).includes(t.screenName);
        if (t.score < cfg.pushThreshold && !always) { log(`skip low score ${t.id} ${t.score} ${t.url}`); continue; }
        const m = await buildMessage(t, cfg);
        log(`PUSH score=${t.score} ${t.url}`);
        if (cfg.channels.windows) pushWindows(m.title, m.body);
        await pushWecom(cfg, m.body);
        pushed++;
      }
    }

    // 无新帖提示：抓取正常但本轮没有任何可推内容 → 1 小时后首条提示，之后每 6 小时重复
    if (state.firstRunDone && total > 0 && pushed === 0) {
      state.quietStreak = (state.quietStreak || 0) + 1;
      const lastNotice = state.lastQuietNoticeAt ? new Date(state.lastQuietNoticeAt).getTime() : 0;
      const firstDue = !lastNotice && state.quietStreak >= 2;
      const repeatDue = lastNotice && Date.now() - lastNotice >= 6 * 3600 * 1000;
      if (firstDue || repeatDue) {
        const body = buildQuietMessage(cfg, state);
        log(`QUIET NOTICE: no new posts (quietStreak=${state.quietStreak})`);
        if (cfg.channels.windows) pushWindows('X Watch 暂无新帖', body);
        await pushWecom(cfg, body);
        state.lastQuietNoticeAt = new Date().toISOString();
      }
    } else if (pushed > 0) {
      state.quietStreak = 0;
      state.lastQuietNoticeAt = null;
    }
    state.lastRun = new Date().toISOString();
  } catch (e) {
    log('cycle error: ' + e.message);
  } finally {
    try { await browser.close(); } catch (e) {}
    saveState();
  }
}

async function main() {
  log('=== X Watch start ===');
  const cfg = loadConfig();
  if (process.argv.includes('--test-notice')) {
    const body = buildQuietMessage(cfg, state);
    console.log('--- 无新帖通知样例 ---');
    console.log(body);
    log('TEST NOTICE (not sent):\n' + body);
    return;
  }
  const once = process.argv.includes('--once');
  const interval = Math.max(60, (cfg.intervalMinutes || 3) * 60) * 1000;
  while (true) {
    await cycle();
    if (once) break;
    await new Promise(r => setTimeout(r, interval));
  }
}

main().catch(e => { log('fatal: ' + e.message); process.exit(1); });
