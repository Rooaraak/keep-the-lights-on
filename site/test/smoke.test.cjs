#!/usr/bin/env node
// Browser smoke test for site in live mode without a game contract, and for the replay.
// The page is served by python's http.server from site/. Its config.json is answered by the test with a
// config whose RPC and status API point back at the same origin (/__rpc, /__status), where a fake SqueekCore
// answers state() and roundPage() from data/rounds.json plus a made-up tail for each scenario. The page's clock is
// set to the scenario's time. Nothing leaves the box (Google Fonts are answered empty).
// Two Chrome launches, each under 90 s: a phone (360 x 740, light, reduced motion) and a desktop (1280 x 900, dark).
// Checks: no console errors, no sideways scroll, the board's state, the dashboard and the wording per scenario,
// "Betting opens soon" with no wallet buttons, the odds next to the picker, tapping a bulb, and a replayed night.
// Usage: node site/test/smoke.test.cjs [--out <dir for screenshots>]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer'); // PUPPETEER: path to puppeteer if it isn't installed here

const CHROME = process.env.CHROME || undefined; // CHROME: a Chrome to use instead of puppeteer's own
const SITE = path.join(__dirname, '..');
const ROOT = path.join(SITE, '..');
// a free port, picked at start: a fixed one can be held by another local server, and the page would then load
// someone else's site
let PORT = 0;
let ORIGIN = '';
const freePort = () => new Promise((resolve, reject) => { const s = require('node:net').createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const LAUNCH_LIMIT_MS = 85_000;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'lights-site-'));
fs.mkdirSync(OUT, { recursive: true });
// screenshots only stay when --out names a folder; a temporary one is removed at the end
process.on('exit', () => { if (outArg < 0) fs.rmSync(OUT, { recursive: true, force: true }); });

let passed = 0, failed = 0;
const check = (ok, what, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the fake SqueekCore ----------
const ROUNDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rounds.json'), 'utf8'));
const G = ROUNDS.genesis;
const CORE = ROUNDS.core;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
function makeCore(tail, settled) {
  const active = ROUNDS.active.map((a) => ({ id: a.id, cum: BigInt(a.cumulative) }));
  let cum = active[active.length - 1].cum;
  for (const [id, work] of tail) { cum += BigInt(work); active.push({ id, cum }); }
  const posAt = (r) => { let c = 0n; for (const a of active) if (a.id <= r) c = a.cum; return c; };
  return {
    settled,
    state: () => '0x' + [settled, posAt(settled), 0, 0, 0, 10000, 0, 0].map(word).join(''),
    roundPage(after, through, max) {
      if (max > 16 || after > through || through > settled) return { error: { code: 3, message: 'execution reverted', data: '0x1fb83773' } };
      const recs = [];
      let cert = through;
      for (const a of active) {
        if (a.id <= after || a.id > through) continue;
        if (recs.length === max) { cert = a.id - 1; break; }
        recs.push(a);
      }
      const head = [0x20, cert, posAt(after), 0, 10000, posAt(cert), 0, 10000, 0x100, recs.length].map(word).join('');
      const body = recs.map((r) => [r.id, r.cum, 0, 10000, 0].map(word).join('')).join('');
      return { result: '0x' + head + body };
    },
  };
}
function rpcAnswer(core, now, msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'eth_chainId') return ok('0xaa36a7');
  if (method === 'eth_blockNumber') return ok('0xb7b8a4');
  if (method === 'eth_getBlockByNumber') return ok({ number: '0xb7b8a4', timestamp: '0x' + Math.floor(now() - 8).toString(16) });
  if (method === 'eth_call') {
    const { to, data } = params[0];
    if (to.toLowerCase() !== CORE) return { jsonrpc: '2.0', id, error: { code: -32000, message: 'no such contract' } };
    if (data.startsWith('0xc19d93fb')) return ok(core.state());
    if (data.startsWith('0xc8b9e08f')) {
      const a = (i) => Number(BigInt('0x' + data.slice(10 + 64 * i, 74 + 64 * i)));
      const r = core.roundPage(a(0), a(1), a(2));
      return r.error ? { jsonrpc: '2.0', id, error: r.error } : ok(r.result);
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `not faked: ${method}` } };
}

const tsOf = (round, secs) => G + (round - 1) * 600 + secs;
const runs = (from, to, w = 500) => Array.from({ length: to - from + 1 }, (_, i) => [from + i, w]);
// rounds 791-797 and 819-821 as they really were after 780 (test/fixtures), then each scenario's own tail
const REAL_TAIL = [[791, 489], [792, 648], [793, 277], [794, 635], [795, 232], [796, 504], [797, 486], [819, 285], [820, 609], [821, 282]];
const SCENARIOS = {
  asleep: { tail: REAL_TAIL, settled: 842, now: tsOf(843, 120), speed: 0 },
  running: { tail: [...REAL_TAIL, ...runs(850, 853)], settled: 853, now: tsOf(854, 120), speed: 210 },
  break: { tail: [...REAL_TAIL, ...runs(850, 853)], settled: 854, now: tsOf(855, 90), speed: 0 },
  blackout: { tail: [...REAL_TAIL, ...runs(850, 853)], settled: 855, now: tsOf(856, 90), speed: 0 },
};
const CONFIG = { chainId: 11155111, chainName: 'Sepolia', rpc: [`${ORIGIN}/__rpc`], explorer: 'https://sepolia.etherscan.io', squeekCore: CORE, sqk: '0x5501e1fa81be1c3f49225fa7668da0245d07db60', lightsOn: '', deployBlock: 0, statusApi: `${ORIGIN}/__status` };

// ---------- browser ----------
async function withChrome(name, opts, fn) {
  const t0 = Date.now();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', `--window-size=${opts.width},${opts.height}`] });
  const pid = browser.process().pid;
  const guard = setTimeout(() => { console.log(`FAIL ${name}: over ${LAUNCH_LIMIT_MS / 1000} s, killing Chrome ${pid}`); failed++; try { process.kill(pid, 'SIGKILL'); } catch {} }, LAUNCH_LIMIT_MS);
  try { await fn(browser); } finally {
    clearTimeout(guard);
    await browser.close().catch(() => {});
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
    console.log(`     ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}

async function openPage(browser, opts, scenarioName, hash = '') {
  const sc = SCENARIOS[scenarioName];
  const core = makeCore(sc.tail, sc.settled);
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: opts.reduced ? 'reduce' : 'no-preference' }]);
  const errors = [], offBox = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => { if (!r.url().includes('fonts.')) errors.push(`request failed: ${r.url()}`); });
  // the page's clock: the scenario's moment, then ticking
  const startMs = sc.now * 1000;
  await page.evaluateOnNewDocument((ms) => { const t0 = performance.now(); Date.now = () => Math.floor(ms + performance.now() - t0); }, startMs);
  const t0 = Date.now();
  const now = () => (startMs + Date.now() - t0) / 1000;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u === `${ORIGIN}/config.json`) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(CONFIG) });
    if (u === `${ORIGIN}/__rpc`) {
      const body = JSON.parse(req.postData());
      const ans = Array.isArray(body) ? body.map((m) => rpcAnswer(core, now, m)) : rpcAnswer(core, now, body);
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(ans) });
    }
    if (u === `${ORIGIN}/__status`) {
      const gen = new Date(now() * 1000).toISOString();
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: gen, measurement: { observedAt: new Date(now() * 1000 - 2000).toISOString(), staleAfterSeconds: 120, speedMmPerSecond: sc.speed, rpmMilli: sc.speed * 150, coreStatus: 'ACTIVE' } }) });
    }
    if (u.startsWith(ORIGIN)) return req.continue();
    offBox.push(u);
    req.respond({ status: 200, contentType: u.includes('css') ? 'text/css' : 'text/plain', body: '' });
  });
  await page.goto(`${ORIGIN}/index.html${hash}`, { waitUntil: 'load' });
  return { page, errors, offBox };
}

const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && el.offsetParent !== null && getComputedStyle(el).display !== 'none');
async function noSideScroll(page, width, when) {
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: innerWidth, wide: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.id || el.className || el.tagName).slice(0, 5) }));
  check(m.doc <= width && m.body <= width, `no sideways scroll at ${width} px, ${when}`, `scrollWidth ${m.doc}/${m.body}, too wide: ${m.wide.join(', ')}`);
}
const derived = (page) => page.evaluate(() => { const d = window.lightsPage.live.debug().derived; return JSON.parse(JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); });
const waitLoaded = (page) => page.waitForFunction(() => window.lightsPage && !window.lightsPage.live.debug().derived.loading && /Live ·/.test(document.getElementById('caption').textContent), { timeout: 15_000 });

async function liveScenarios(browser, opts, tag) {
  for (const name of ['asleep', 'running', 'break', 'blackout']) {
    const { page, errors, offBox } = await openPage(browser, opts, name);
    try {
      await waitLoaded(page);
      await sleep(400);
      const d = await derived(page);
      const cap = await text(page, '#caption'), status = await text(page, '#status'), label = await page.$eval('#board', (el) => el.getAttribute('aria-label'));
      if (name === 'asleep') {
        check(!d.open && d.last && d.last.lit === 2 && d.last.start === 819, `${tag} asleep: no ride open, his last ride (819) lit 2 bulbs`, JSON.stringify(d.last && { s: d.last.start, l: d.last.lit }));
        check(/He is asleep\. His last ride lit 2 bulbs/.test(cap), `${tag} asleep: caption says so`, cap);
        check(/asleep/i.test(status) && /lights come on when he starts/i.test(status), `${tag} asleep: status in plain words`, status);
        check(/ 0 lit/.test(label), `${tag} asleep: board dark`, label);
        // no contract: no wallet buttons, "Betting opens soon", odds as the one number
        check(!(await visible(page, '#act')) && (await visible(page, '#soon')) && !(await visible(page, '#amountRow')) && !(await visible(page, '#walletLine')), `${tag}: no contract, so no wallet buttons and "Betting opens soon"`);
        check(await text(page, '#soon') === 'Betting opens soon', `${tag}: the words are "Betting opens soon"`);
        // 19 nights through round 780 lit bulb 6 seven times; the ride of 791 (6 bulbs) makes it 8 of 21
        check(await text(page, '#money') === '38%' && /How often bulb 6 lit/.test(await text(page, '#moneyLabel')) && /8 of his 21 nights/.test(await text(page, '#moneySub')), `${tag}: bulb 6's odds shown with the picker, counting the nights read from the chain (8 of 21)`, `${await text(page, '#money')} / ${await text(page, '#moneySub')}`);
        await page.click('#bPlus'); await sleep(350);
        check(await text(page, '#bPick') === '7' && /How often bulb 7 lit/.test(await text(page, '#moneyLabel')), `${tag}: + picks bulb 7`);
        // tap bulb 3 on the board, where the board says it is drawn (nothing lit, so no scrolling)
        const pt = await page.evaluate(() => window.lightsPage.bulbPoint(3, 0));
        await page.mouse.click(pt.x, pt.y); await sleep(350);
        check(await text(page, '#bPick') === '3', `${tag}: tapping bulb 3 on the board picks it`, await text(page, '#bPick'));
        check(!(await visible(page, '#playersPanel')), `${tag}: no bets list without a contract`);
      }
      if (name === 'running') {
        check(d.open && d.open.start === 850 && d.lit === 3 && d.running === true, `${tag} running: ride open since 850, 3 bulbs lit, wheel turning`, JSON.stringify({ open: d.open && d.open.start, lit: d.lit, run: d.running }));
        check(/Squeektoshi is running\. 3 bulbs lit since/.test(cap), `${tag} running: caption`, cap);
        check(/He is running: bulb 4 lights next/.test(status), `${tag} running: status`, status);
        check(d.win.floor === 6 && d.win.night === 'tonight', `${tag} running: lowest bulb a bet could take is 6 (3 lit + 2 unknown rounds + 1), for tonight`, JSON.stringify(d.win));
        check(/ 3 lit/.test(label), `${tag} running: 3 bulbs lit on the board`, label);
      }
      if (name === 'break') {
        check(d.open && d.open.idleRun === 1 && d.lit === 3 && d.running === false, `${tag} break: one quiet round, still the same ride`, JSON.stringify({ idle: d.open && d.open.idleRun, lit: d.lit }));
        check(/stopped for a moment/.test(cap) && /flicker/.test(status), `${tag} break: caption and status`, `${cap} | ${status}`);
      }
      if (name === 'blackout') {
        check(!d.open && d.last && d.last.start === 850 && d.last.lit === 3 && d.last.C === 854, `${tag} blackout: ride 850 closed at C = 854 with 3 bulbs`, JSON.stringify(d.last && { s: d.last.start, c: d.last.C }));
        check(/Blackout after 3 bulbs\./.test(status), `${tag} blackout: status`, status);
        check(/He is asleep\. His last ride lit 3 bulbs/.test(cap), `${tag} blackout: caption`, cap);
      }
      const all = await page.evaluate(() => document.body.innerText);
      check(!/can.?t lose|claim|approve|revert|nonce/i.test(all), `${tag} ${name}: no "can't lose" and no jargon on the page`, (all.match(/can.?t lose|claim|approve|revert|nonce/i) || [])[0]);
      await noSideScroll(page, opts.width, `${tag} ${name}`);
      await page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), fullPage: false });
      check(errors.length === 0, `${tag} ${name}: no console errors`, errors.join(' | '));
      if (offBox.length) console.log(`     ${name}: ${offBox.length} request(s) off the box answered empty (${[...new Set(offBox.map((u) => new URL(u).host))].join(', ')})`);
    } finally { await page.close(); }
  }
}

async function replayScenario(browser, opts, tag) {
  const { page, errors } = await openPage(browser, opts, 'asleep', '#past');
  try {
    await page.waitForFunction(() => window.lightsPage && window.lightsPage.mode() === 'replay', { timeout: 10_000 });
    check(await visible(page, '#replayControls') && !(await visible(page, '#soon')) && await visible(page, '#act'), `${tag} replay: "Watch a past night" shows the ride picker and its own bet button`);
    // the new rides read from the (fake) chain join the list: 19 + 791 + 819
    await page.waitForFunction(() => document.querySelectorAll('#ride option').length >= 21, { timeout: 10_000 }).catch(() => {});
    const n = await page.$$eval('#ride option', (o) => o.length);
    check(n === 21, `${tag} replay: 21 nights to pick from (19 + 2 read from the chain)`, String(n));
    // a short night at 4x: night 2 (2 bulbs)
    const short = await page.$$eval('#ride option', (os) => (os.find((o) => / 2 bulbs/.test(o.textContent) && o.value === '2') || {}).value);
    await page.select('#ride', short || '2');
    await page.click('#sp4');
    await page.click('#act');
    await sleep(300);
    check(/Bet placed/.test(await text(page, '#act')), `${tag} replay: a pretend bet is placed`);
    await page.waitForFunction(() => !document.getElementById('results').hidden, { timeout: 25_000 });
    const res = await text(page, '#resYou');
    check(/Bulb 6 stayed dark/.test(res), `${tag} replay: the night plays to the blackout and the result shows`, res);
    await page.click('#modeLive');
    await waitLoaded(page);
    check(!(await visible(page, '#replayControls')) && (await visible(page, '#soon')) && !(await visible(page, '#amountRow')) && /Live ·/.test(await text(page, '#caption')), `${tag}: back to live`);
    await page.click('#modeReplay');
    await sleep(300);
    check((await visible(page, '#amountRow')) && (await visible(page, '#act')) && !(await visible(page, '#soon')) && /Bet on bulb/.test(await text(page, '#act')), `${tag}: and to the replay again, with its bet buttons back`);
    await page.click('#modeLive');
    await noSideScroll(page, opts.width, `${tag} replay`);
    check(errors.length === 0, `${tag} replay: no console errors`, errors.join(' | '));
  } finally { await page.close(); }
}

// The board's pages: a 9-bulb night replayed at 4x. The row starts on page 1 (bulbs 1-8 on a wide board, 1-6 on a
// narrow one), turns to page 2 once he keeps running after its last bulb, and after the blackout the lights have gone
// out back across the pages, so the row ends on page 1 again.
async function pagingScenario(browser, opts, tag) {
  const { page, errors } = await openPage(browser, opts, 'asleep', '#past');
  try {
    await page.waitForFunction(() => window.lightsPage && window.lightsPage.mode() === 'replay', { timeout: 10_000 });
    const v = await page.$$eval('#ride option', (os) => (os.find((o) => / 9 bulbs/.test(o.textContent)) || {}).value);
    check(v != null, `${tag} pages: a 9-bulb night to replay`);
    await page.select('#ride', v);
    await page.click('#sp4');
    const P = await page.evaluate(() => (document.getElementById('board').parentElement.clientWidth >= 760 ? 8 : 6));
    const pt = (k) => page.evaluate((n) => window.lightsPage.bulbPoint(n, 0), k);
    const litNow = () => page.$eval('#board', (e) => Number((e.getAttribute('aria-label').match(/(\d+) lit/) || [])[1] || 0));
    await sleep(400);
    check(!!(await pt(1)) && !!(await pt(P)) && !(await pt(P + 1)), `${tag} pages: the row starts on page 1 (bulbs 1-${P}); bulb ${P + 1} is not on it`);
    await page.waitForFunction((n) => Number((document.getElementById('board').getAttribute('aria-label').match(/(\d+) lit/) || [])[1] || 0) >= n, { timeout: 40_000, polling: 100 }, P + 1).catch(() => {});
    // the row turns once bulb P has visibly switched on (at 4x the switch-on runs behind the count), and a moment more
    let turned = false;
    for (let i = 0; i < 40 && !turned; i++) { turned = !!(await pt(P + 1)) && !(await pt(1)); if (!turned) await sleep(200); }
    check(turned, `${tag} pages: after bulb ${P} the row turned to page 2 (bulb ${P + 1} on the board, bulb 1 not)`, String(await litNow()));
    await page.waitForFunction(() => !document.getElementById('results').hidden, { timeout: 40_000 }).catch(() => {});
    await sleep(4000);
    check(!!(await pt(1)) && !(await pt(P + 1)), `${tag} pages: after the blackout the lights went out back to page 1`, String(await litNow()));
    // his last nights: up to 5, newest first, each with a strip of 24 dots (as many lit as the night's bulbs); a tap replays it
    const nights = await page.$$eval('#lastNights .night', (rs) => rs.map((r) => ({ when: r.querySelector('.when').textContent, n: r.querySelector('.n').textContent, on: r.querySelectorAll('.strip i.on').length, dots: r.querySelectorAll('.strip i').length })));
    check(nights.length === 5 && nights.every((x) => x.dots === 24 && Number(x.n.split(' ')[0]) === x.on), `${tag} last nights: 5 nights, each with 24 dots and its lit bulbs`, JSON.stringify(nights));
    await page.click('#modeLive');
    await sleep(300);
    await page.click('#lastNights .night:nth-child(2)');
    await sleep(600);
    const picked = await page.evaluate(() => ({ mode: window.lightsPage.mode(), ride: document.getElementById('ride').selectedOptions[0].textContent }));
    check(picked.mode === 'replay' && picked.ride.includes(nights[1].n), `${tag} last nights: a tap on a night replays it`, JSON.stringify(picked));
    check(errors.length === 0, `${tag} pages: no console errors`, errors.join(' | '));
  } finally { await page.close(); }
}

// Wide screens: two columns (the hamster cam beside the board), and the bet row on the first screen, also on a short
// laptop screen (the board's height is capped there).
async function wideScenario(browser, opts, tag) {
  const { page, errors } = await openPage(browser, opts, 'asleep');
  try {
    await waitLoaded(page);
    await sleep(600);
    const m = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect(), board = r(document.getElementById('board')), cam = r(document.getElementById('cam'));
      return { boardRight: board.right, boardH: board.height, camLeft: cam.left, dashBottom: r(document.querySelector('.dash')).bottom, h: innerHeight };
    });
    check(m.camLeft > m.boardRight, `${tag}: two columns, the hamster cam beside the board`, JSON.stringify(m));
    check(m.dashBottom <= m.h, `${tag}: the bet row is on the first screen (${Math.round(m.dashBottom)} <= ${m.h})`, JSON.stringify(m));
    await noSideScroll(page, opts.width, tag);
    check(errors.length === 0, `${tag}: no console errors`, errors.join(' | '));
  } finally { await page.close(); }
}

// --real: one page on the real config.json, reading the real Sepolia RPC and status API (a handful of calls).
async function realPass(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 740 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().includes('fonts.g') ? req.respond({ status: 200, contentType: 'text/css', body: '' }) : req.continue()));
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  const ok = await waitLoaded(page).then(() => true, () => false);
  await sleep(4000); // let the wheel's reading arrive
  const d = ok ? await derived(page) : null;
  const st = ok ? await page.evaluate(() => ({ rides: window.lightsPage.live.debug().state.view.rides.length, wheel: window.lightsPage.live.debug().state.wheel })) : null;
  check(ok && d.S >= 842 && st.rides >= 21, `real Sepolia: the page read SqueekCore through round ${d && d.S}, ${st && st.rides} nights`, JSON.stringify(st));
  check(ok && st.wheel !== null, `real status API: wheel reading ${st && JSON.stringify(st.wheel)}`);
  console.log(`     caption: ${await text(page, '#caption')}`);
  console.log(`     status:  ${await text(page, '#status')}`);
  await page.screenshot({ path: path.join(OUT, 'real-360.png') });
  check(errors.length === 0, 'real Sepolia: no console errors', errors.join(' | '));
  await page.close();
}

(async () => {
  PORT = await freePort();
  ORIGIN = `http://127.0.0.1:${PORT}`;
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', SITE, '--bind', '127.0.0.1'], { stdio: 'ignore' });
  const stop = () => { try { process.kill(server.pid, 'SIGKILL'); } catch {} };
  process.on('exit', stop);
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`${ORIGIN}/index.html`); if (r.ok) break; } catch {} await sleep(100); }
    if (process.argv.includes('--real')) {
      await withChrome('real Sepolia', { width: 360, height: 740 }, realPass);
      stop();
      console.log(`\n${passed} passed, ${failed} failed${outArg > 0 ? ` · screenshots in ${OUT}` : ''}`);
      process.exit(failed ? 1 : 0);
    }
    const phone = { width: 360, height: 740, dark: false, reduced: true };
    const desk = { width: 1280, height: 900, dark: true, reduced: false };
    await withChrome('phone 360 light reduced-motion', phone, async (b) => { await liveScenarios(b, phone, 'phone'); await replayScenario(b, phone, 'phone'); await pagingScenario(b, phone, 'phone'); });
    await withChrome('desktop 1280 dark', desk, async (b) => { await liveScenarios(b, desk, 'desktop'); await replayScenario(b, desk, 'desktop'); await pagingScenario(b, desk, 'desktop'); });
    const laptop = { width: 1366, height: 768, dark: true, reduced: false }, big = { width: 1920, height: 1080, dark: false, reduced: false };
    await withChrome('wide 1366x768 and 1920x1080', laptop, async (b) => { await wideScenario(b, laptop, 'wide 1366x768'); await wideScenario(b, big, 'wide 1920x1080 light'); });
  } catch (e) {
    failed++; console.log(`FAIL ${e.stack || e}`);
  } finally { stop(); }
  console.log(`\n${passed} passed, ${failed} failed${outArg > 0 ? ` · screenshots in ${OUT}` : ''}`);
  process.exit(failed ? 1 : 0);
})();
