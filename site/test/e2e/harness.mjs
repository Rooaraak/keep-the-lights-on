// The end-to-end harness: a local anvil chain with MockCore + MockSQK + LightsOn, a small web server for the page
// (with a test copy of config.json and a fake wheel-speed API), a fake EIP-1193 wallet for Chrome that forwards to
// anvil's unlocked dev accounts, and Chrome itself (puppeteer) with a hard 85 s limit per launch.
// Nothing here talks to a public chain or uses a key: anvil's dev accounts are unlocked, and every request the page
// makes outside the box (Google Fonts) is answered empty.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../../chain.js';

const require = createRequire(import.meta.url);
// where the tools are: PUPPETEER (path to puppeteer), CHROME (a Chrome instead of puppeteer's own), ANVIL (Foundry's anvil)
export const puppeteer = require(process.env.PUPPETEER || 'puppeteer');
export const CHROME = process.env.CHROME || undefined;
export const ANVIL = process.env.ANVIL || 'anvil';
export const HERE = dirname(fileURLToPath(import.meta.url));
export const SITE = join(HERE, '..', '..');
export const ROOT = join(SITE, '..');
const OUT = join(ROOT, 'out');
export const W = 10n ** 18n;
export const LAUNCH_LIMIT_MS = 85_000; // a cron kills Chrome older than ~2 min; stay well under 90 s
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');
export const hex = (n) => '0x' + BigInt(n).toString(16);

// ---------------------------------------------------------------- checks

export function createChecks() {
  const t = { passed: 0, failed: 0, fails: [] };
  t.check = (ok, what, detail = '') => {
    if (ok) t.passed++; else { t.failed++; t.fails.push(what + (detail ? ` (${detail})` : '')); }
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? ` (${detail})` : ''}`);
    return !!ok;
  };
  return t;
}

// ---------------------------------------------------------------- ports and processes

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const children = new Set();
export function killAll() { for (const p of children) { try { process.kill(p.pid, 'SIGKILL'); } catch {} } children.clear(); }
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });

// ---------------------------------------------------------------- anvil and the contracts

export function artifact(file, name) {
  const p = join(OUT, file, `${name}.json`);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  if (Object.keys(d.bytecode.linkReferences || {}).length) throw new Error(`${name} needs linking`);
  return { bytecode: d.bytecode.object, abi: d.abi, mtime: statSync(p).mtimeMs };
}

// out must be built from the current sources (forge build --offline)
export function checkBuildFresh() {
  const src = ['LightsOn.sol', 'LightsMath.sol', 'ISqueek.sol'].map((f) => statSync(join(ROOT, 'src', f)).mtimeMs);
  const out = artifact('LightsOn.sol', 'LightsOn').mtime;
  return { fresh: out >= Math.max(...src), out, src: Math.max(...src) };
}

export async function startAnvil({ accounts = 14 } = {}) {
  const port = await freePort();
  const proc = spawn(ANVIL, ['--port', String(port), '--host', '127.0.0.1', '--quiet', '--accounts', String(accounts), '--balance', '1000'], { stdio: 'ignore' });
  children.add(proc);
  const url = `http://127.0.0.1:${port}`;
  const rpc = C.createRpc([url], { timeoutMs: 8000 });
  for (let i = 0; ; i++) {
    try { await rpc.request('eth_chainId'); break; } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(150); }
  }
  return { url, port, rpc, stop: () => { try { process.kill(proc.pid, 'SIGKILL'); } catch {} children.delete(proc); } };
}

// mock helpers (cast sig): setActive(uint64,uint64), setSettled(uint64), setPaused(bool), mint(address,uint256)
export const MOCK = { setActive: '0x4bb7aa33', setSettled: '0xa915578b', setPaused: '0x16c38b3c', mint: '0x40c10f19' };

// A test chain: deploys MockCore, MockSQK and LightsOn(core, sqk, G, station, startRound) and drives time and rounds.
// G is chosen so the chain is `secs` seconds into round `round` right now.
export async function createTestChain(anvil, { round, secs = 20, station = 36, startRound }) {
  const { rpc } = anvil;
  const accounts = await rpc.request('eth_accounts');
  const deployer = accounts[0];
  const t0 = Number((await rpc.request('eth_getBlockByNumber', ['latest', false])).timestamp);
  const G = t0 - (round - 1) * 600 - secs;
  const receipt = async (hash) => {
    for (let i = 0; i < 200; i++) { const r = await rpc.request('eth_getTransactionReceipt', [hash]); if (r) return r; await sleep(15); }
    throw new Error(`no receipt for ${hash}`);
  };
  const send = async (from, to, data, { gas = 0x1c9c380, expectOk = true } = {}) => {
    const hash = await rpc.request('eth_sendTransaction', [{ from, to, data, gas: hex(gas) }]);
    const r = await receipt(hash);
    if (expectOk && r.status !== '0x1') throw Object.assign(new Error(`tx from ${from.slice(0, 8)} to ${to ? to.slice(0, 8) : 'create'} ${data.slice(0, 10)} failed`), { receipt: r });
    return r;
  };
  const deploy = async (code) => (await send(deployer, null, code)).contractAddress;
  const core = await deploy(artifact('Mocks.sol', 'MockCore').bytecode);
  const sqk = await deploy(artifact('Mocks.sol', 'MockSQK').bytecode);
  const lights = await deploy(artifact('LightsOn.sol', 'LightsOn').bytecode + addrWord(core) + addrWord(sqk) + word(G) + word(station) + word(startRound));
  const deployBlock = Number(await rpc.request('eth_blockNumber'));
  const active = new Map(); // round -> work, every active round recorded so far
  let settled = 0;

  const latestTs = async () => Number((await rpc.request('eth_getBlockByNumber', ['latest', false])).timestamp);
  const tc = {
    rpc, url: anvil.url, accounts, deployer, G, station, startRound, core, sqk, lights, deployBlock, active,
    get settled() { return settled; },
    send, receipt,
    chainCfg: { chainId: 31337, rpc: [anvil.url], squeekCore: core, sqk, lightsOn: lights, deployBlock },
    roundAt: (t) => (t < G ? 0 : Math.floor((t - G) / 600) + 1),
    latestTs,
    async now() { const t = await latestTs(); return { t, round: tc.roundAt(t), secs: (t - G) % 600 }; },
    // move the chain clock to `secs` into round `r` and mine a block there (time only moves forward)
    async at(r, s = 30) {
      const target = G + (r - 1) * 600 + s;
      const cur = await latestTs();
      if (target <= cur) throw new Error(`can't go back in time: round ${r} + ${s} s is before the chain's ${tc.roundAt(cur)} + ${(cur - G) % 600} s`);
      await rpc.request('evm_setNextBlockTimestamp', [hex(target)]);
      await rpc.request('evm_mine', []);
    },
    // record rounds in the core: active ones (with his turns) get a record, then settledThrough moves to `through`
    async record(through, works = new Map()) {
      for (let r = settled + 1; r <= through; r++) {
        const w = works.get(r);
        if (w > 0) { await send(deployer, core, MOCK.setActive + word(r) + word(w)); active.set(r, w); }
      }
      await send(deployer, core, MOCK.setSettled + word(through));
      settled = through;
    },
    async mint(to, amount) { await send(deployer, sqk, MOCK.mint + addrWord(to) + word(amount)); },
    async setPaused(p) { await send(deployer, core, MOCK.setPaused + word(p ? 1 : 0)); },
    // a bet sent straight to the contract (another player, or you from another device)
    async betDirect(from, bulb, amount) {
      await send(from, sqk, C.encode.approve(lights, amount));
      const r = await send(from, lights, C.encode.bet(bulb, amount));
      const log = r.logs.find((l) => l.topics[0] === C.TOPIC.BetPlaced);
      return C.decode.betPlaced(log);
    },
    async call(to, data, from) { return rpc.request('eth_call', [from ? { from, to, data } : { to, data }, 'latest']); },
    async balance(a) { return C.decode.uint(await tc.call(sqk, C.encode.balanceOf(a))); },
    async allowance(a) { return C.decode.uint(await tc.call(sqk, C.encode.allowance(a, lights))); },
    async getBet(id) { return C.decode.bet(await tc.call(lights, C.encode.getBet(id))); },
    async outcome(id) { return C.decode.outcome(await tc.call(lights, C.encode.betOutcome(id))); },
    async betCount() { return Number(C.decode.uint(await tc.call(lights, C.SEL.betCount))); },
    async allBets() {
      const n = await tc.betCount(), out = [];
      for (let i = 0; i < n; i++) out.push({ id: i, ...(await tc.getBet(i)) });
      return out;
    },
    async setEth(a, wei) { await rpc.request('anvil_setBalance', [a, hex(wei)]); },
  };
  return tc;
}

// ---------------------------------------------------------------- the web server

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Serves site/ as it is, plus /config.e2e.json (the test copy of config.json, pointed at anvil) and
// /__status (Squeekchain's status API, with the wheel speed the scenario sets: `state.wheel` mm/s, or null for an
// API that is down; `state.stale` makes the reading 10 minutes old).
export async function startWeb(state) {
  const port = await freePort();
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/config.e2e.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(state.config)); }
    if (u.pathname === '/__status') {
      if (state.wheel == null) { res.writeHead(503); return res.end(); }
      const now = new Date().toISOString(), seen = state.stale ? new Date(Date.now() - 600_000).toISOString() : now;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ generatedAt: now, measurement: { observedAt: seen, staleAfterSeconds: 120, speedMmPerSecond: state.wheel, rpmMilli: state.wheel ? 52_000 : 0 } }));
    }
    const rel = normalize(decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname)).replace(/^([/\\])+/, '');
    const file = join(SITE, rel);
    if (!file.startsWith(SITE) || rel.startsWith('test') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())) };
}

// ---------------------------------------------------------------- the fake wallet

// What a browser wallet does, as far as the page can tell: it holds one account (shared only after
// eth_requestAccounts), sits on some network, knows a few networks (switching to an unknown one fails with 4902
// until it is added), asks before every transaction (the test can say no, or hold the answer while it moves the
// chain), and sends through anvil's unlocked account. Every request is logged.
export function createFakeWallet(anvil, { account, chainId = '0x1' } = {}) {
  const w = {
    account, chainId, known: new Set(['0x1']), shared: false,
    refuse: 0, // say no to this many of the next transactions
    hold: null, // async (tx) => {} awaited before a transaction is sent
    log: [], sends: [], added: null, page: null,
  };
  w.emit = async (event, value) => { if (w.page) await w.page.evaluate((e, v) => window.ethereum.__emit(e, v), event, value).catch(() => {}); };
  w.switchAccount = async (a) => { w.account = a; await w.emit('accountsChanged', [a]); };
  w.handle = async (method, params = []) => {
    w.log.push(method);
    switch (method) {
      case 'eth_requestAccounts': w.shared = true; return [w.account];
      case 'eth_accounts': return w.shared ? [w.account] : [];
      case 'eth_chainId': return w.chainId;
      case 'net_version': return String(parseInt(w.chainId, 16));
      case 'wallet_switchEthereumChain': {
        const id = params[0] && params[0].chainId;
        if (!w.known.has(id)) throw { code: 4902, message: `Unrecognized chain ID "${id}". Try adding the chain using wallet_addEthereumChain first.` };
        w.chainId = id; await w.emit('chainChanged', id); return null;
      }
      case 'wallet_addEthereumChain': {
        w.added = params[0]; w.known.add(params[0].chainId); w.chainId = params[0].chainId; await w.emit('chainChanged', w.chainId); return null;
      }
      case 'eth_sendTransaction': {
        const tx = { ...params[0] };
        if (!w.shared) throw { code: 4100, message: 'The requested account and/or method has not been authorized by the user.' };
        if (!tx.from || tx.from.toLowerCase() !== w.account.toLowerCase()) throw { code: -32602, message: 'from is not the connected account' };
        if (w.chainId !== '0x7a69') throw { code: -32000, message: 'test wallet: a transaction on the wrong network' };
        if (w.hold) await w.hold(tx);
        if (w.refuse > 0) { w.refuse--; w.sends.push({ ...tx, refused: true }); throw { code: 4001, message: 'User rejected the request.' }; }
        w.sends.push(tx);
        return anvil.rpc.request('eth_sendTransaction', [tx]);
      }
      default:
        return anvil.rpc.request(method, params);
    }
  };
  // attach to a page before it loads: window.ethereum calls back into node
  w.attach = async (page) => {
    w.page = page;
    await page.exposeFunction('__walletRequest', async (json) => {
      const { method, params } = JSON.parse(json);
      try { return JSON.stringify({ result: await w.handle(method, params) }); } catch (e) { return JSON.stringify({ error: { code: e.code ?? -32603, message: e.message || String(e), data: e.data } }); }
    });
    await page.evaluateOnNewDocument(() => {
      const listeners = {};
      window.ethereum = {
        isTestWallet: true,
        request: async ({ method, params }) => {
          const r = JSON.parse(await window.__walletRequest(JSON.stringify({ method, params })));
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
          return r.result;
        },
        on: (e, f) => { (listeners[e] ||= []).push(f); },
        removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((g) => g !== f); },
        __emit: (e, v) => { for (const f of listeners[e] || []) { try { f(v); } catch (err) { setTimeout(() => { throw err; }); } } },
      };
    });
  };
  return w;
}

// ---------------------------------------------------------------- Chrome

// One Chrome launch. Kills Chrome (and fails the run) if it lives longer than LAUNCH_LIMIT_MS.
export async function launch({ viewport, scheme = 'light', reducedMotion = false, label, t }) {
  const started = Date.now();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const pid = browser.process().pid;
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; console.log(`FAIL ${label}: Chrome over ${LAUNCH_LIMIT_MS / 1000} s, killed`); try { process.kill(pid, 'SIGKILL'); } catch {} }, LAUNCH_LIMIT_MS);
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }]);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' && /error/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  // a request cut off by a reload (net::ERR_ABORTED) is the browser's doing, not the page's
  page.on('requestfailed', (r) => { const why = r.failure() && r.failure().errorText; if (!/fonts\.(googleapis|gstatic)/.test(r.url()) && why !== 'net::ERR_ABORTED') errors.push(`request failed: ${r.url()} ${why}`); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:')) return req.continue();
    // nothing leaves the box: fonts (and anything else) are answered empty
    return req.respond({ status: 200, contentType: /css/.test(u) ? 'text/css' : 'text/plain', body: '' });
  });
  const close = async () => {
    clearTimeout(killer);
    await browser.close().catch(() => {});
    try { process.kill(pid, 'SIGKILL'); } catch {}
    const secs = (Date.now() - started) / 1000;
    t.check(!timedOut && secs < 90, `${label}: Chrome closed after ${secs.toFixed(1)} s (limit 90)`);
  };
  return { browser, page, errors, close, started };
}

// ---------------------------------------------------------------- page helpers

export function pageTools(page) {
  const P = {
    text: (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => ''),
    visible: (sel) => page.$eval(sel, (el) => !el.closest('[hidden]') && el.getClientRects().length > 0).catch(() => false),
    disabled: (sel) => page.$eval(sel, (el) => el.disabled).catch(() => null),
    waitText: (sel, re, ms = 12_000) => page.waitForFunction((s, src, fl) => { const el = document.querySelector(s); return !!el && new RegExp(src, fl).test(el.textContent.replace(/\s+/g, ' ')); }, { timeout: ms, polling: 100 }, sel, re.source, re.flags).then(() => true).catch(() => false),
    // the page's own reading of the chain, as plain numbers (debug() holds BigInts)
    state: () => page.evaluate(() => {
      const { derived: d, state: L } = window.lightsPage.live.debug();
      if (d.loading) return { loading: true };
      return { S: L.S, cur: d.cur, N: d.N, floor: d.win.floor, night: d.win.night, lit: d.lit, open: d.open ? { start: d.open.start, idleRun: d.open.idleRun } : null, rides: L.view.rides.map((r) => ({ n: r.n, start: r.start, C: r.C, lit: r.lit, end: r.end })), betCount: L.snap ? L.snap.betCount : null, current: d.current.map((b) => b.id), mine: d.mine ? d.mine.id : null, collect: d.collectIds, collectSum: String(d.collectSum), potIn: String(d.potIn), account: L.account, busy: L.busy, pick: L.pick, running: { ...L.running }, chainOk: L.chainOk };
    }),
    // read everything again now, and wait until the page has read the chain up to `S` (and `bets` bets)
    async refresh({ S, bets, ms = 12_000 } = {}) {
      await page.evaluate(() => window.lightsPage.live.refresh());
      return page.waitForFunction((s, n) => {
        const L = window.lightsPage.live.debug().state;
        if (L.running.core || L.running.game || L.running.mine || L.running.wheel) return false;
        if (s != null && L.S !== s) { window.lightsPage.live.refresh(); return false; }
        if (n != null && (!L.snap || L.snap.betCount !== n)) { window.lightsPage.live.refresh(); return false; }
        return true;
      }, { timeout: ms, polling: 250 }, S ?? null, bets ?? null).then(() => true).catch(() => false);
    },
    // what the board draws: the live view's return value, recorded every frame
    async watchBoard() {
      await page.waitForFunction(() => window.lightsPage && window.lightsPage.live, { timeout: 10_000 });
      await page.evaluate(() => {
        const live = window.lightsPage.live;
        if (live.__wrapped) return;
        const v0 = live.view;
        live.view = (time, step) => { const v = v0(time, step); window.__board = { lit: v.lit, flicker: !!v.flicker, resting: !!v.resting, pot: v.pot || 0, msg: v.msg, pick: v.pick, markers: (v.markers || []).map((m) => m.bulb) }; return v; };
        live.__wrapped = true;
        // every sentence shown under the dashboard, including the short-lived ones
        window.__said = window.__said || [];
        const st = document.getElementById('status');
        new MutationObserver(() => { const x = st.textContent.replace(/\s+/g, ' ').trim(); if (x && window.__said[window.__said.length - 1] !== x) window.__said.push(x); }).observe(st, { childList: true, characterData: true, subtree: true });
      });
    },
    said: (from = 0) => page.evaluate((f) => (window.__said || []).slice(f), from),
    saidCount: () => page.evaluate(() => (window.__said || []).length),
    async waitSaid(re, from = 0, ms = 15_000) {
      const until = Date.now() + ms;
      while (Date.now() < until) { const all = await P.said(from); const hit = all.find((x) => re.test(x)); if (hit) return hit; await sleep(150); }
      return null;
    },
    board: () => page.evaluate(() => window.__board || null),
    async waitBoard(fn, ms = 6000) {
      const until = Date.now() + ms;
      let b = null;
      while (Date.now() < until) { b = await P.board(); if (b && fn(b)) return b; await sleep(120); }
      return b;
    },
    scrollWidth: () => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)),
    // the dashboard row: widths of "your bulb" and the one number, and how many lines each big value takes
    dash: () => page.evaluate(() => {
      const lines = (id) => { const el = document.getElementById(id), cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.1; return Math.round(el.getBoundingClientRect().height / lh); };
      return { cells: [...document.querySelectorAll('.dash > .cell:not(.cta)')].map((c) => Math.round(c.getBoundingClientRect().width)), you: lines('youState'), money: lines('money') };
    }),
    bodyText: () => page.evaluate(() => document.body.innerText),
    click: (sel) => page.click(sel),
    async pickBulb(k) {
      for (let i = 0; i < 30; i++) {
        const cur = Number(await P.text('#bPick'));
        if (cur === k) return true;
        await page.click(cur > k ? '#bMinus' : '#bPlus');
        await sleep(60);
        const after = Number(await P.text('#bPick'));
        if (after === cur) await sleep(300);
        if (Number(await P.text('#bPick')) === cur) return false; // can't go lower (the lowest safe bulb) or higher
      }
      return false;
    },
    async typeAmount(v) {
      await page.$eval('#amtOther', (el) => { el.value = ''; });
      await page.type('#amtOther', String(v));
      await sleep(350);
    },
  };
  return P;
}

// whole SQK with up to 2 decimals, as the page prints it
export function sqkText(wei) {
  const cents = (wei * 100n + W / 2n) / W, whole = cents / 100n, frac = cents % 100n;
  return `${whole.toLocaleString('en-US')}${frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : ''}`;
}
