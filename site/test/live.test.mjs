#!/usr/bin/env node
// live.js itself, without a browser: the page's live mode runs in node on a fake page (plain objects for the
// dashboard's elements) against the real contract on anvil, through a page RPC that lags behind the wallet like a
// public node (its 'latest' is the newest block at least LAG seconds old; the wallet talks to anvil directly).
// Fast and steady on a busy machine, where Chrome tests can run out of time. Checks the bug bash round 1 fixes:
//   - right after "Bet placed" the page shows your bet at once (button off, your bulb, the balance), and a second
//     press sends nothing, though its node doesn't show the bet yet
//   - the allow step on a lagging node: the wallet's own node confirms it (no 15 s wait, no second allow); a wallet
//     that can't check: "your allow went through", and the next press goes straight to the bet
//   - the line above the button: your bet's bulb, and the time still to run while he runs
//   - after the blackout, a lit bulb that gets back less than its bet is told so, the dashboard keeps the result
//     ("Last ride", −11.11) until collected, and a collect on a lagging node can't be pressed twice
//   - no wallet in the browser: a way forward (open in a wallet app, copy the link)
// and the bug bash round 2 fixes:
//   - the one number has its unit (SQK) and is labelled as the best case ("Best case: he lights 6 to 8 bulbs"), with
//     "test SQK, no real money" right under it; the button says "Bet 100 SQK on bulb 6"
//   - a quiet round recorded while the wheel turns again: the board says he is back and stops flickering
//   - after the blackout the lights go out on the board, then it shows his next ride (no bulb lit, so a tap picks
//     the bulb it shows), and the sign still says how far he got
//   - a wallet with no test ETH: the page says it needs a little (free) test ETH for the fee, with a link, and
//     doesn't ask the wallet for anything (the button says "Get test ETH first"); with ETH but no SQK in the rehearsal the
//     button says "Get practice SQK first" and gets them
//   - a phone with no wallet: the button says "How to bet on a phone"
// and the bug bash round 2b fixes:
//   - a win not yet collected never hides the bet controls: the picker stays, picking a bulb turns the button into
//     the bet and the win gets a "Collect" link in the sentence; with the bet placed, the button collects the win
//   - a lost bet stays on the first screen ("Bulb 20 · stayed dark", "Last ride −100 SQK", "…you lost your 100 SQK.")
//     after the 6-round window, until he picks a new bulb
// and the bug bash round 3 fixes:
//   - he stops after running in the round: a bet now stays on tonight's ride (lost if he sleeps on), and the page says
//     so ("…if he stays asleep, the lights go out and your bulb stays dark", "for tonight's ride"), from the wheel it
//     saw turning or from the wheel's counter; quiet so far: "…or for his next ride if the lights go out"
// Only anvil and its unlocked dev accounts. Usage: node site/test/live.test.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import * as H from './e2e/harness.mjs';
import * as C from '../chain.js';

const LAG = 8_000;
// ONLY=bet,slow,eth,lost,stopped,nowallet runs a part (bet = the bet, his ride, the blackout and the collect; slow = the
// slow allow; eth = a wallet with no test ETH in the rehearsal; lost = a lost bet, then a win left uncollected;
// stopped = a bet right after he stopped, in a round he already ran in)
const ONLY = process.env.ONLY || '';
const part = (name) => !ONLY || ONLY.split(',').includes(name);
let failures = 0;
const ok = (cond, msg, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail ? ` (${detail})` : ''}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = H.W;
const ROUNDS = JSON.parse(readFileSync(H.ROOT + '/data/rounds.json', 'utf8'));
const REAL = new Map(ROUNDS.active.map((a) => [a.id, a.work]));
const works = (a, b) => new Map([...REAL].filter(([id]) => id >= a && id <= b));
const JARGON = /\b(claim|claimed|approve|approval|revert|reverted|nonce|allowance|calldata|gas limit)\b|can'?t lose/i;

// ---------------------------------------------------------------- a fake page
class El {
  constructor(tag = 'div') {
    Object.assign(this, { tag, own: '', kids: [], hidden: false, disabled: false, dataset: {}, className: '', title: '', value: '', href: '', attrs: {}, listeners: {} });
    // classList over className, like a browser's
    const list = () => this.className.split(/\s+/).filter(Boolean), put = (xs) => { this.className = xs.join(' '); };
    this.classList = {
      contains: (k) => list().includes(k),
      add: (k) => { if (!list().includes(k)) put([...list(), k]); },
      remove: (k) => put(list().filter((x) => x !== k)),
      toggle: (k, on = !list().includes(k)) => { if (on) this.classList.add(k); else this.classList.remove(k); return on; },
    };
  }
  get textContent() { return this.own + this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v) { this.own = String(v); this.kids = []; }
  get childElementCount() { return this.kids.filter((k) => typeof k !== 'string').length; }
  append(...xs) { this.kids.push(...xs); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  get links() { return this.kids.filter((k) => typeof k !== 'string' && k.tag === 'a'); }
}
globalThis.document = { hidden: false, createElement: (tag) => new El(tag), addEventListener() {} };
function fakePage() {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, new El()); return els.get(id); };
  const setText = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
  const setStatus = (msg) => { const el = $('status'); if (el.textContent !== msg || el.childElementCount) { el.textContent = msg; el.dataset.key = ''; } };
  const t = (id) => $(id).textContent.replace(/\s+/g, ' ').trim();
  return { $, setText, setStatus, t };
}
const { createLive } = await import('../live.js');

// ---------------------------------------------------------------- the chain, a lagging page RPC, the wallet
const anvil = await H.startAnvil();
const c = await H.createTestChain(anvil, { round: 40, secs: 15, startRound: 39 });
await c.record(39);
const [, me, p3, p4, p5] = c.accounts;
for (const a of [me, p3, p4, p5]) await c.mint(a, 1000n * W);
await c.betDirect(p3, 3, 100n * W); await c.betDirect(p4, 9, 200n * W);

const seen = new Map(), st = { lag: LAG, wheel: 0, work: null };
// the newest block, asked at most every 200 ms (this machine can be very busy)
let headAt = 0, headN = null;
async function head() {
  if (headN == null || Date.now() - headAt > 200) { headN = Number(await anvil.rpc.request('eth_blockNumber')); headAt = Date.now(); }
  if (!seen.has(headN)) seen.set(headN, Date.now());
  return headN;
}
async function lagBlock() { const n = await head(); if (!st.lag) return n; let b = n; while (b > 0 && (seen.get(b) ?? 0) > Date.now() - st.lag) b--; return b; }
async function one(q) {
  let { method, params = [] } = q;
  const lb = await lagBlock(), n = headN;
  // a lagging node answers 'latest' from its own head, lb, even while it hasn't seen a newer block (the newest block
  // is looked up at most every 200 ms, and a block mined in that time must not show early)
  if (st.lag && lb <= n) {
    if (method === 'eth_call' && (params[1] == null || params[1] === 'latest')) params = [params[0], '0x' + lb.toString(16)];
    if (method === 'eth_blockNumber') return { jsonrpc: '2.0', id: q.id, result: '0x' + lb.toString(16) };
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') params = ['0x' + lb.toString(16), params[1]];
    if (method === 'eth_getTransactionReceipt') { const r = await anvil.rpc.request(method, params).catch(() => null); return { jsonrpc: '2.0', id: q.id, result: r && Number(r.blockNumber) > lb ? null : r }; }
  }
  try { return { jsonrpc: '2.0', id: q.id, result: await anvil.rpc.request(method, params) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: e.code ?? -32000, message: e.message, data: e.data } }; }
}
const proxy = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    // (st.work: the wheel's counter of his turns, like the real API's cumulativeWorkUnits; left out unless set)
    if (req.method === 'GET') { const now = new Date().toISOString(); return res.end(JSON.stringify({ generatedAt: now, measurement: { observedAt: now, staleAfterSeconds: 120, speedMmPerSecond: st.wheel, rpmMilli: st.wheel ? 52_000 : 0, ...(st.work != null ? { cumulativeWorkUnits: String(st.work) } : {}) } })); }
    const q = JSON.parse(body);
    res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q)));
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const config = { ...c.chainCfg, rpc: [proxyUrl], chainName: 'Test chain', explorer: '', walkFrom: 39, clock: 'chain', statusApi: `${proxyUrl}/status` };

// a browser wallet (harness): starts on another network, sends through anvil's unlocked accounts; `reads: false`
// is a wallet that doesn't answer eth_call
function walletFor(account, { reads = true } = {}) {
  const w = H.createFakeWallet(anvil, { account, chainId: '0x1' });
  const provider = {
    request: async ({ method, params }) => {
      if (!reads && method === 'eth_call') throw Object.assign(new Error('The method eth_call is not supported'), { code: 4200 });
      try { return await w.handle(method, params); } catch (e) { throw Object.assign(new Error(e.message || String(e)), { code: e.code, data: e.data }); }
    },
    on() {},
  };
  return { w, provider };
}

function startPage(provider, cfg = config) {
  const P = fakePage();
  const live = createLive({ ...P, config: cfg, base: {}, provider, onRides: () => {} });
  live.start(); live.enter();
  // what the board is told to draw: the last frame, and the last frame while the lights go out after a blackout
  const frames = { last: null, out: null };
  const tick = setInterval(() => { try { const v = live.view(performance.now() / 1000); frames.last = v; if (v.outP != null) frames.out = v; } catch (e) { console.log('view threw', e); } }, 100);
  const until = async (fn, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; };
  const said = [];
  const watch = setInterval(() => { const x = P.t('status'); if (x && said[said.length - 1] !== x) said.push(x); }, 50);
  return { ...P, live, until, said, frames, stop: () => { clearInterval(tick); clearInterval(watch); } };
}
const dash = (pg) => ({ you: pg.t('youState'), youSub: pg.t('youSub'), ml: pg.t('moneyLabel'), money: pg.t('money'), ms: pg.t('moneySub'), act: pg.t('act'), off: pg.$('act').disabled, odds: pg.t('pickOdds'), pickHidden: pg.$('pickRow').hidden, wallet: pg.t('walletLine'), status: pg.t('status') });
const show = (x) => JSON.stringify(x);
const meter = (pg) => ({ hidden: pg.$('meter').hidden, text: pg.t('meterText'), tone: pg.$('meter').dataset.tone });

let pg = null;
try {
  if (part('bet')) {
  // ---------------------------------------------------------------- 1. the bet on a lagging node
  const A = walletFor(me);
  pg = startPage(A.provider);
  ok(await pg.until(() => /Connect wallet/.test(pg.t('act'))), 'the page reads the chain through the lagging node', show(dash(pg)));
  await pg.live.act();
  ok(await pg.until(() => /Switch to Test chain/.test(pg.t('act'))), 'connected: switch to the test chain');
  await pg.live.act();
  ok(await pg.until(() => /^Bet 100 SQK on bulb 6$/.test(pg.t('act')), 60_000), 'switched: "Bet 100 SQK on bulb 6"', show(dash(pg)));
  // (the node lags: wait until it shows the two bets placed before the page opened)
  ok(await pg.until(() => { const L = pg.live.debug().state; if (L.snap && L.snap.betCount >= 2 && !L.running.game) return true; if (!L.running.game) pg.live.refresh(); return false; }, 30_000), 'the page shows the two bets placed before it opened');
  await sleep(400);
  let d = dash(pg);
  // bets on bulbs 3 and 9: a bet on bulb 6 gets the most while he lights 6, 7 or 8 bulbs
  const unit = pg.$('money').kids.find((k) => typeof k !== 'string');
  ok(d.ml === 'Best case: he lights 6 to 8 bulbs' && /^\+[\d,.]+ SQK$/.test(d.money) && unit && unit.tag === 'small' && unit.textContent === ' SQK', `the one number is the best case, with its unit in small print: "${d.ml}" ${d.money}`, show(d));
  ok(d.ms === 'test SQK, no real money', 'right under it, above the bet buttons: "test SQK, no real money"', d.ms);
  const t0 = Date.now();
  await pg.live.act();
  const took = (Date.now() - t0) / 1000;
  const sends = A.w.sends.map((x) => x.data.slice(0, 10));
  ok(sends.join() === `${C.SEL.approve},${C.SEL.betUntil}`, 'one allow, one bet', sends.join());
  ok(!pg.said.some((x) => /network is slow/.test(x)), `the lagging node didn't show the allow, the wallet's own node did: the bet went out without waiting for the node (${took.toFixed(1)} s)`, show(pg.said));
  ok(!pg.said.some((x) => /wasn't allowed|Press the button again to allow/.test(x)), 'never "wasn\'t allowed"', show(pg.said));
  await sleep(400);
  d = dash(pg);
  ok(/^Bet placed: 100 SQK on bulb 6/.test(d.status), '"Bet placed: 100 SQK on bulb 6…"', d.status);
  ok(d.ml === 'Best case: he lights 6 to 8 bulbs' && d.ms === 'with the bets so far', 'your bet: "Best case: he lights 6 to 8 bulbs", "with the bets so far"', show(d));
  ok(d.act === 'Bet placed' && d.off, 'right after "Bet placed", the button says so and is off (the node still lags)', show(d));
  ok(d.you === 'Bulb 6' && /next ride · bet 100/.test(d.youSub) && d.pickHidden, 'your bulb shows your bet: "Bulb 6 · next ride · bet 100", no picker', show(d));
  ok(/you have 900 SQK/.test(d.wallet), 'the wallet line shows 900 SQK at once', d.wallet);
  ok(/^Bulb 6 · 1 hour · /.test(d.odds), 'the line above the button is about your bet: "Bulb 6 · 1 hour · …"', d.odds);
  const lagging = await c.betCount();
  const { state: L0 } = pg.live.debug();
  ok(L0.snap.betCount < lagging, `the page's node really lags (it shows ${L0.snap.betCount} bets, the chain has ${lagging})`);
  const n0 = A.w.sends.length;
  await pg.live.act();
  await sleep(300);
  ok(A.w.sends.length === n0, 'a second press sends nothing', A.w.sends.slice(n0).map((x) => x.data.slice(0, 10)).join());
  // the node catches up: the bet is read from the chain, nothing changes on the page
  await sleep(LAG + 500);
  pg.live.refresh();
  ok(await pg.until(() => { const { state: L } = pg.live.debug(); return !L.pending && L.snap && L.snap.betCount === lagging && !L.running.mine; }, 60_000), 'once the node shows the bet, the page reads it from the chain');
  await sleep(500);
  d = dash(pg);
  const { state: L1 } = pg.live.debug();
  ok(d.act === 'Bet placed' && d.off && d.you === 'Bulb 6' && /you have 900 SQK/.test(d.wallet) && ![...L1.bets.values()].some((b) => b.local), 'and still shows the same bet and 900 SQK', show(d));
  const sh = pg.$('share'), shText = decodeURIComponent((sh.href.match(/text=([^&]*)/) || [])[1] || '');
  ok(!sh.hidden && pg.t('share') === 'Share my bet on X' && /^https:\/\/x\.com\/intent\/post\?/.test(sh.href) && /I bet 100 SQK that Squeektoshi the hamster lights bulb 6 on his next ride/.test(shText) && /[?&]url=https/.test(sh.href), 'a placed bet can be shared: "Share my bet on X", a ready post "I bet 100 SQK that Squeektoshi the hamster lights bulb 6 on his next ride…" with the page\'s link', show({ hidden: sh.hidden, label: pg.t('share'), text: shText }));
  ok((await c.allBets()).filter((b) => b.owner.toLowerCase() === me.toLowerCase()).length === 1, 'one bet on chain');

  // ---------------------------------------------------------------- 3. his ride: the line above the button
  pg.stop();
  pg = startPage(A.provider);
  ok(await pg.until(() => pg.t('act') === 'Bet placed', 60_000), 'waited for "Bet placed" on the button', show(dash(pg)));
  st.wheel = 480;
  await c.at(50, 50); await c.record(49, works(45, 49));
  await sleep(LAG + 300);
  pg.live.refresh();
  ok(await pg.until(() => pg.live.debug().state.S === 49 && !pg.live.debug().state.running.core, 60_000), 'waited for the page read round 49', show(dash(pg)));
  await sleep(600);
  d = dash(pg);
  const lit49 = pg.live.debug().derived.lit;
  ok(lit49 === 4, 'his ride: 4 bulbs lit through round 49', String(lit49));
  ok(/^Bulb 6 · about 20 min more · /.test(d.odds), `while he runs, the line is about your bulb 6 and the time still to run: "${d.odds}"`, d.odds);
  ok(pg.frames.last.msg === 'HE IS RUNNING * NEXT: BULB 5' && !pg.frames.last.flicker, 'the board: "HE IS RUNNING * NEXT: BULB 5"', pg.frames.last.msg);
  let mt = meter(pg);
  ok(!mt.hidden && /^Bulb 5 lights in [89]:\d\d$/.test(mt.text) && mt.tone === 'run', 'the countdown under the board: "Bulb 5 lights in 9:xx" (round 50 ends in about 9 minutes)', show(mt));

  // ---------------------------------------------------------------- 3b. a quiet round, then he is back on the wheel
  // rounds 50-53 light bulbs 5-8, round 54 is quiet (his real night), and the wheel turns again right now
  await c.at(55, 50); await c.record(54, works(50, 54));
  await sleep(LAG + 300);
  pg.live.refresh();
  ok(await pg.until(() => pg.live.debug().state.S === 54 && !pg.live.debug().state.running.core && !pg.live.debug().state.running.wheel, 60_000), 'waited for the page read round 54 (core and wheel)', show(dash(pg)));
  await sleep(400);
  let v = pg.frames.last;
  ok(v.lit === 8 && v.msg === 'HE IS BACK ON THE WHEEL * NEXT: BULB 9' && !v.flicker && !v.resting, 'a quiet round is recorded but the wheel turns again (the cam shows him running): "HE IS BACK ON THE WHEEL * NEXT: BULB 9", no flicker', show(v));
  mt = meter(pg);
  ok(!mt.hidden && /^Bulb 9 lights in [89]:\d\d$/.test(mt.text) && mt.tone === 'run', 'back on the wheel after a break: "Bulb 9 lights in 9:xx"', show(mt));
  st.wheel = 0;
  pg.live.refresh();
  ok(await pg.until(() => pg.frames.last.flicker, 20_000), 'waited for the board flickers (a break)', show(dash(pg)));
  v = pg.frames.last;
  ok(v.msg === 'LIGHTS FLICKER ... IS HE ASLEEP?' && v.flicker && v.resting, 'the wheel stops too: "LIGHTS FLICKER ... IS HE ASLEEP?", the bulbs flicker', show(v));
  st.wheel = 480;

  // ---------------------------------------------------------------- 4. the blackout: bulb 6 lit, but less than the bet
  await c.at(64, 50); await c.record(63, works(55, 63));
  st.wheel = 0;
  await sleep(LAG + 300);
  pg.live.refresh();
  ok(await pg.until(() => /^Collect /.test(pg.t('act')), 60_000), 'after the blackout: Collect', show(dash(pg)));
  await sleep(500);
  d = dash(pg);
  ok(/^Blackout after 14 bulbs\. Your bulb 6 lit, but higher bulbs and earlier bets got bigger slices of the pot, so you get back 88\.89 of your 100 SQK\. Press Collect/.test(d.status), 'the sentence says it gets back less than the bet: "…you get back 88.89 of your 100 SQK."', d.status);
  ok(d.you === 'Bulb 6 lit' && /^last ride · bet 100$/.test(d.youSub) && d.ml === 'Last ride' && d.money === '−11.11 SQK' && pg.$('money').className === 'lose' && /you get back 88\.89 SQK/.test(d.ms), 'the dashboard keeps the result: "Bulb 6 lit", "Last ride −11.11 SQK" (red)', show(d));
  // the board: the 14 lights went out (the last one first), then it shows his next ride, scrolled to bulb 1
  ok(pg.frames.out && pg.frames.out.lit === 14 && pg.frames.out.outP < 1 && !pg.frames.out.markers.length, 'the board: the 14 lit bulbs go out', show(pg.frames.out));
  ok(await pg.until(() => pg.frames.last.outP == null, 5000), 'and then the lights are out');
  v = pg.frames.last;
  ok(v.lit === 0 && pg.live.debug().state.boardLit === 0 && v.msg === 'BLACKOUT AFTER 14 BULBS * SWEET DREAMS' && v.pick === Number(pg.$('bPick').textContent) && v.pick > 0, 'then the board shows his next ride: no bulb lit (a tap reads that same board), the sign still "BLACKOUT AFTER 14 BULBS", the picker\'s bulb marked', show(v));
  ok(d.act === 'Collect 88.89 SQK' && !d.pickHidden && /^Bulb \d+ · /.test(d.odds), '"Collect 88.89 SQK", and the picker stays (a win waiting to be collected never blocks a new bet)', show(d));
  ok(/ To bet on his next ride, pick a bulb\.$/.test(d.status), 'the sentence ends with how to bet again: "To bet on his next ride, pick a bulb."', d.status);
  ok(!JARGON.test(d.status) && !JARGON.test(d.you + d.youSub + d.ml + d.ms), 'plain words');
  // he picks a bulb for his next ride: the dashboard shows that bet and the button is for it; the win waiting to be
  // collected moves into the sentence, with its own Collect link
  pg.live.plus();
  await sleep(400);
  d = dash(pg);
  const bp = Number(pg.$('bPick').textContent);
  ok(d.you === `Bulb ${bp}?` && /^Best case: /.test(d.ml) && d.act === `Bet 100 SQK on bulb ${bp}` && !d.off, `picking a bulb: the dashboard shows the new bet, "Bet 100 SQK on bulb ${bp}"`, show(d));
  const link = pg.$('status').links[0];
  ok(/88\.89 SQK from your last ride is waiting for you\. Collect 88\.89 SQK$/.test(d.status) && link && link.textContent === 'Collect 88.89 SQK', 'the sentence: "…88.89 SQK from your last ride is waiting for you." with a "Collect 88.89 SQK" link', show({ status: d.status, links: pg.$('status').links.map((a) => a.textContent) }));
  // collect on a lagging node, from the link: the button can't offer it twice
  const before = await c.balance(me), n1 = A.w.sends.length;
  link.listeners.click[0]({ preventDefault() {}, currentTarget: link });
  ok(await pg.until(() => /^Collected /.test(pg.t('status')), 30_000), 'the link collects', pg.t('status'));
  const got = (await c.balance(me)) - before;
  ok(got > 88_88n * W / 100n && got < 88_90n * W / 100n, 'collected 88.89 SQK', String(got));
  d = dash(pg);
  ok(/^Collected 88\.89 SQK\./.test(d.status), '"Collected 88.89 SQK."', d.status);
  ok(!/^Collect/.test(d.act), 'right after "Collected", the button doesn\'t offer the same collect (the node still lags)', show(d));
  ok(/you have 988\.89 SQK/.test(d.wallet), 'the wallet line adds it at once: 988.89 SQK', d.wallet);
  ok(pg.live.debug().derived.collectIds.length === 0 && A.w.sends.slice(n1).filter((x) => x.data.startsWith(C.SEL.claim)).length === 1, 'one collect sent, nothing left to collect on the page', A.w.sends.slice(n1).map((x) => x.data.slice(0, 10)).join());
  const mineRow = pg.t('mine');
  ok(/collected 88\.89 SQK/.test(mineRow) && /−11\.11/.test(mineRow), 'your bets: "collected 88.89 SQK … −11.11"', mineRow);
  await sleep(400);
  v = pg.frames.last;
  const dc = pg.live.debug().derived;
  ok(v.lit === 0 && v.pick >= dc.win.floor && v.pick === Number(pg.$('bPick').textContent) && /^Bulb \d+\?$/.test(pg.t('youState')) && pg.t('act') === `Bet 100 SQK on bulb ${v.pick}` && !pg.$('status').links.length, `collected: the board marks the bulb you pick for his next ride (bulb ${v.pick}), the button is for the bet, no Collect link left`, show({ v, d: dash(pg) }));
  // he gets back on the wheel soon after the blackout: the sign says so (the cam shows him running)
  st.wheel = 480;
  pg.live.refresh();
  ok(await pg.until(() => /BACK ON THE WHEEL/.test(pg.frames.last.msg), 20_000) && pg.frames.last.msg === 'BLACKOUT AFTER 14 BULBS * HE IS BACK ON THE WHEEL * LIGHTS ON SOON' && !pg.frames.last.resting, 'back on the wheel soon after the blackout: "BLACKOUT AFTER 14 BULBS * HE IS BACK ON THE WHEEL * LIGHTS ON SOON"', show(pg.frames.last));
  st.wheel = 0;
  pg.stop();

  }
  if (part('slow')) {
  // ---------------------------------------------------------------- 2. a wallet that can't check, a node 20 s behind
  // after the blackout, bets are for his next ride; the node first catches up with everything so far
  if (part('bet')) await sleep(21_000);
  st.lag = 20_000;
  const saved = { ...C.ALLOW_LAG };
  C.ALLOW_LAG.everyMs = 300; // the same number of looks, closer together
  const B = walletFor(p5, { reads: false });
  if (pg) pg.stop();
  pg = startPage(B.provider);
  ok(await pg.until(() => /Connect wallet/.test(pg.t('act'))), 'another player (a wallet that doesn\'t answer reads): Connect wallet', show(dash(pg)));
  await pg.live.act(); ok(await pg.until(() => /Switch to/.test(pg.t('act'))), 'connected', show(dash(pg)));
  await pg.live.act(); ok(await pg.until(() => /^Bet 100 SQK on bulb/.test(pg.t('act')), 60_000), 'switched: "Bet 100 SQK on bulb …"', show(dash(pg)));
  const said0 = pg.said.length;
  await pg.live.act();
  await sleep(200);
  const allowSaid = pg.said.slice(said0);
  ok(B.w.sends.map((x) => x.data.slice(0, 10)).join() === C.SEL.approve, 'a node 20 s behind and a wallet that can\'t check: only the allow went out', B.w.sends.map((x) => x.data.slice(0, 10)).join());
  ok(allowSaid.some((x) => /allow went through\. The network is slow/.test(x)), 'while it looks again: "…your allow went through. The network is slow…"', show(allowSaid));
  ok(/^Your allow went through, but the network is slow to show it\. Press the button again/.test(pg.t('status')) && !/wasn't allowed/.test(pg.t('status')), 'then: "Your allow went through, but the network is slow to show it. Press the button again…"', pg.t('status'));
  ok((await c.allowance(p5)) === 100n * W, 'the allow is on chain');
  ok(/^Bet 100 SQK on bulb/.test(pg.t('act')) && !pg.$('act').disabled, 'the button offers the bet again', pg.t('act'));
  await pg.live.act();
  await sleep(200);
  const sends5 = B.w.sends.map((x) => x.data.slice(0, 10));
  ok(sends5.join() === `${C.SEL.approve},${C.SEL.betUntil}`, 'the next press goes straight to the bet: no second allow', sends5.join());
  ok(/^Bet placed: 100 SQK on bulb/.test(pg.t('status')) && pg.t('act') === 'Bet placed', '"Bet placed", the button off', show(dash(pg)));
  ok((await c.allowance(p5)) === 0n, 'nothing left allowed');
  Object.assign(C.ALLOW_LAG, saved);
  pg.stop();
  st.lag = LAG;

  }
  if (part('eth')) {
  // ---------------------------------------------------------------- 6. the rehearsal, a fresh wallet with no test ETH
  const p6 = c.accounts[6], FAUCET = 'https://faucet.example/sepolia';
  await c.setEth(p6, 0n);
  const E = walletFor(p6);
  if (pg) pg.stop();
  pg = startPage(E.provider, { ...config, practice: true, ethFaucet: FAUCET });
  ok(await pg.until(() => /Connect wallet/.test(pg.t('act'))), 'waited for "Connect wallet"', show(dash(pg)));
  await pg.live.act(); ok(await pg.until(() => /Switch to/.test(pg.t('act'))), 'waited for "Switch to …" after connecting', show(dash(pg)));
  await pg.live.act();
  ok(await pg.until(() => pg.t('act') === 'Get test ETH first' && /test ETH/.test(pg.t('status')), 30_000), 'connected with no test ETH: the button says "Get test ETH first" and the sentence under it says where', show(dash(pg)));
  let links = pg.$('status').links;
  ok(/^Your wallet needs a little test ETH to pay the network fee\. Test ETH is free from a faucet\. Then tap Get 1,000 practice SQK below\./.test(pg.t('status')) && links.length === 1 && links[0].href === FAUCET && links[0].textContent === 'Get free test ETH', `"${pg.t('status')}", with a link to the faucet`, show(links.map((a) => [a.href, a.textContent])));
  ok(pg.t('moneySub') === 'practice SQK, no real money' && /practice SQK, no real money/.test(pg.t('eyebrow')), 'the rehearsal: "practice SQK, no real money" under the number and in the eyebrow', `${pg.t('moneySub')} / ${pg.t('eyebrow')}`);
  ok(!pg.$('faucet').hidden, 'the "Get 1,000 practice SQK" button is offered');
  await pg.live.act();
  await pg.$('faucet').listeners.click[0]();
  await sleep(300);
  ok(E.w.sends.length === 0 && /needs a little test ETH/.test(pg.t('status')), 'the bet and the practice SQK button ask the wallet for nothing: it couldn\'t pay the fee', show({ sends: E.w.sends.length, status: pg.t('status') }));
  ok(!JARGON.test(pg.t('status')), 'plain words', pg.t('status'));
  // he gets test ETH from the faucet: the hint goes away
  await c.setEth(p6, 1000n * W);
  pg.live.refresh();
  ok(await pg.until(() => !/test ETH/.test(pg.t('status')), 30_000), 'with test ETH the hint goes away', pg.t('status'));
  ok(await pg.until(() => pg.t('act') === 'Get practice SQK first', 10_000), 'no SQK yet: the button says "Get practice SQK first"', pg.t('act'));
  E.w.refuse = 1;
  await pg.live.act();
  await sleep(300);
  ok(pg.t('status') === 'You said no in your wallet, so nothing was sent.' && E.w.sends.length === 1 && E.w.sends[0].refused && E.w.sends[0].data === '0xde5f72fd', 'the button asks the wallet for the practice SQK (faucet), and saying no: "You said no in your wallet, so nothing was sent."', show({ status: pg.t('status'), sends: E.w.sends.map((x) => x.data) }));
  E.w.refuse = 1;
  await pg.$('faucet').listeners.click[0]();
  await sleep(300);
  ok(pg.t('status') === 'You said no in your wallet, so nothing was sent.' && E.w.sends.length === 2 && E.w.sends[1].refused, 'the practice SQK button, then saying no in the wallet: "You said no in your wallet, so nothing was sent."', pg.t('status'));
  // the real game (not the rehearsal): a wallet with test ETH but no SQK hears where SQK comes from, with a link to the
  // practice page; the button says "Not enough SQK" and there is no practice tap
  {
    const Z = walletFor(c.accounts[11]);
    pg.stop();
    pg = startPage(Z.provider, { ...config, practiceUrl: '?config=rehearsal.json' });
    ok(await pg.until(() => /Connect wallet/.test(pg.t('act'))), 'waited for "Connect wallet"', show(dash(pg)));
    await pg.live.act(); ok(await pg.until(() => /Switch to/.test(pg.t('act'))), 'waited for "Switch to …" after connecting', show(dash(pg)));
    await pg.live.act();
    ok(await pg.until(() => /no SQK yet/.test(pg.t('status')), 30_000), 'the real game, a wallet with no SQK: the sentence under the button says so', show(dash(pg)));
    const zl = pg.$('status').links;
    ok(pg.t('status').startsWith('Your wallet has no SQK yet. SQK comes from staking Squeeks on Squeekchain. Meanwhile you can play the same game with free practice SQK.') && zl.length === 1 && zl[0].href === '?config=rehearsal.json' && zl[0].textContent === 'Try it with practice SQK', '"Your wallet has no SQK yet …", with a link "Try it with practice SQK" to the practice page', show({ status: pg.t('status'), links: zl.map((x) => [x.href, x.textContent]) }));
    ok(pg.t('act') === 'Not enough SQK' && pg.$('faucet').hidden, 'the button says "Not enough SQK", and the real game has no practice tap', show({ act: pg.t('act'), faucet: pg.$('faucet').hidden }));
    ok(!JARGON.test(pg.t('status')), 'plain words', pg.t('status'));
    await pg.live.act();
    await sleep(300);
    ok(/^Not enough SQK: you have 0, this bet needs 100\./.test(pg.t('status')) && pg.$('status').links.length === 1 && Z.w.sends.length === 0, 'pressing it: "Not enough SQK: you have 0, this bet needs 100." with the practice link, and nothing sent', show({ status: pg.t('status'), sends: Z.w.sends.length }));
  }
  pg.stop();
  }
  if (part('lost')) {
  // ---------------------------------------------------------------- 7. a lost bet, then a win left uncollected
  // (bug bash round 2: a lost bet vanished from the first screen; a win not yet collected hid the bet controls)
  if (!part('bet')) { await c.at(64, 50); await c.record(63, works(45, 63)); }
  const p7 = c.accounts[7], p8 = c.accounts[8];
  for (const a of [p7, p8]) await c.mint(a, 1000n * W);
  await c.at(66, 30);
  await c.betDirect(p8, 2, 100n * W); await c.betDirect(p7, 20, 100n * W);   // both before his next ride
  // his next ride: rounds 68-71 run (3 bulbs), 72-73 quiet: the blackout
  await c.at(74, 40); await c.record(73, new Map([[68, 500], [69, 500], [70, 500], [71, 500]]));
  const connect = async (pgx) => { await pgx.until(() => /Connect wallet/.test(pgx.t('act'))); await pgx.live.act(); await pgx.until(() => /Switch to/.test(pgx.t('act'))); await pgx.live.act(); };
  const P7 = walletFor(p7);
  if (pg) pg.stop();
  await sleep(LAG + 300);
  pg = startPage(P7.provider);
  await connect(pg);
  ok(await pg.until(() => /stayed dark/.test(pg.t('status')), 60_000), 'his bet on bulb 20, the ride lit 3 bulbs: the page says it stayed dark', show(dash(pg)));
  await sleep(400);
  let d = dash(pg);
  ok(/^Blackout after 3 bulbs\. Your bulb 20 stayed dark: you lost your 100 SQK\. To bet on his next ride, pick a bulb\.$/.test(d.status), 'the sentence gives the amount: "Blackout after 3 bulbs. Your bulb 20 stayed dark: you lost your 100 SQK. To bet on his next ride, pick a bulb."', d.status);
  ok(d.you === 'Bulb 20' && d.youSub === 'stayed dark · bet 100' && d.ml === 'Last ride' && d.money === '−100 SQK' && pg.$('money').classList.contains('lose') && d.ms === 'you lost your bet', 'the dashboard shows the lost bet like a win: "Bulb 20 · stayed dark", "Last ride −100 SQK"', show(d));
  ok(!d.pickHidden && /^Bet 100 SQK on bulb \d+$/.test(d.act) && !d.off, 'the picker and the bet button stay', show(d));
  // two hours later he is still asleep: the lost bet is still on the first screen
  await c.at(86, 30); await c.record(85);
  await sleep(LAG + 300);
  pg.live.refresh();
  ok(await pg.until(() => pg.live.debug().state.S === 85 && !pg.live.debug().state.running.core, 60_000), 'waited for the page read round 85', show(dash(pg)));
  await sleep(400);
  d = dash(pg);
  ok(/^Your bulb 20 stayed dark on his last ride: you lost your 100 SQK\. To bet on his next ride, pick a bulb\.$/.test(d.status) && d.money === '−100 SQK' && d.ml === 'Last ride', 'two hours later: "Your bulb 20 stayed dark on his last ride: you lost your 100 SQK." and still "Last ride −100 SQK"', show(d));
  ok(pg.$('meter').hidden, 'he is asleep: no countdown under the board', show(meter(pg)));
  ok(!JARGON.test(d.status + d.you + d.youSub + d.ml + d.ms), 'plain words');
  pg.live.plus();
  await sleep(400);
  d = dash(pg);
  ok(/^Bulb \d+\?$/.test(d.you) && /^Best case: /.test(d.ml) && !/stayed dark/.test(d.status), 'once he picks a bulb, the dashboard shows the new bet', show(d));
  pg.stop();
  // a win left uncollected while he runs his next ride: the bet controls stay, and the button can be for either
  st.wheel = 480;
  await c.at(90, 30); await c.record(89, new Map([[87, 500], [88, 500], [89, 500]]));
  const P8 = walletFor(p8);
  await sleep(LAG + 300);
  pg = startPage(P8.provider);
  await connect(pg);
  ok(await pg.until(() => /^Collect [\d.,]+ SQK$/.test(pg.t('act')) && pg.live.debug().derived.open, 60_000), 'his next ride is on, your win from the last one isn\'t collected: "Collect"', show(dash(pg)));
  await sleep(400);
  d = dash(pg);
  const dl = pg.live.debug().derived, due = d.act.replace(/^Collect | SQK$/g, '');
  ok(!d.pickHidden && dl.lit === 2, 'the picker stays while he runs (2 bulbs lit)', show(d));
  ok(new RegExp(`^Your bulb 2 lit on his last ride\\. Press Collect to count the ride and take your ${due.replace('.', '\\.')} SQK\\. To bet on this ride, pick a bulb \\(${dl.win.floor} or higher\\)\\.$`).test(d.status), `the sentence: your win, then how to bet on this ride (bulb ${dl.win.floor} or higher)`, d.status);
  pg.live.plus();
  await sleep(400);
  d = dash(pg);
  const bp8 = Number(pg.$('bPick').textContent);
  ok(d.act === `Bet 100 SQK on bulb ${bp8}` && pg.$('status').links.length === 1 && pg.$('status').links[0].textContent === `Collect ${due} SQK`, `after picking: "Bet 100 SQK on bulb ${bp8}", the win has its Collect link`, show({ d, links: pg.$('status').links.map((a) => a.textContent) }));
  const s0 = P8.w.sends.length;
  await pg.live.act();
  await sleep(400);
  ok(P8.w.sends.slice(s0).map((x) => x.data.slice(0, 10)).join() === `${C.SEL.approve},${C.SEL.betUntil}` && /^Bet placed/.test(pg.t('status')), 'the bet on this ride goes out', show({ sends: P8.w.sends.slice(s0).map((x) => x.data.slice(0, 10)), status: pg.t('status') }));
  await sleep(400);
  d = dash(pg);
  ok(d.act === `Collect ${due} SQK` && d.you === `Bulb ${bp8}`, 'with the bet placed, the button collects the earlier win', show(d));
  const b8 = await c.balance(p8);
  await pg.live.act();
  ok(await pg.until(() => /^Collected /.test(pg.t('status')), 30_000) && (await c.balance(p8)) > b8, 'and collects it', pg.t('status'));
  st.wheel = 0;
  pg.stop();
  }
  if (part('stopped')) {
  // ---------------------------------------------------------------- 8. he stops in a round he already ran in
  // (bug bash round 3: the page promised a bet sent right after he stopped would move to his next ride if the lights
  // went out; but the round already had his turns, so the bet stayed on tonight's ride and was lost). A ride leaves
  // in D, bulbs 1-4 light in D+1..D+4, and in D+5 he runs a few minutes, then stops for good.
  const D = c.settled + 4, pa = c.accounts[9], pb = c.accounts[10];
  for (const a of [pa, pb]) await c.mint(a, 1000n * W);
  st.wheel = 0; st.work = null;
  await c.at(D + 5, 20); await c.record(D + 4, new Map([[D, 500], [D + 1, 500], [D + 2, 500], [D + 3, 500], [D + 4, 500]]));
  const connect = async (pgx) => { await pgx.until(() => /Connect wallet/.test(pgx.t('act'))); await pgx.live.act(); await pgx.until(() => /Switch to/.test(pgx.t('act'))); await pgx.live.act(); await pgx.until(() => /^Bet 100 SQK on bulb/.test(pgx.t('act')), 60_000); };
  const PA = walletFor(pa);
  if (pg) pg.stop();
  await sleep(LAG + 300);
  pg = startPage(PA.provider);
  await connect(pg);
  ok(await pg.until(() => pg.live.debug().state.S === D + 4 && !pg.live.debug().state.running.core, 60_000), 'waited for the page read round D + 4', show(dash(pg)));
  await sleep(400);
  let d = dash(pg);
  // the round in progress is quiet so far: tonight if he runs again, else his next ride
  ok(/^He stopped for a moment\. A bet now counts for this ride, or for his next ride if the lights go out\. Bulb 7 or higher\.$/.test(d.status) && d.youSub === 'for tonight, or his next ride if the lights go out', 'quiet so far in this round: "…for this ride, or for his next ride if the lights go out."', show(d));
  let mt = meter(pg);
  ok(!mt.hidden && /^He stopped: bulb 5 still lights if he runs again in the next 9:\d\d$/.test(mt.text) && mt.tone === 'wait', 'the countdown: "He stopped: bulb 5 still lights if he runs again in the next 9:xx"', show(mt));
  // he runs (the page sees it), then stops
  st.wheel = 480; pg.live.refresh();
  ok(await pg.until(() => /^He is running\./.test(pg.t('status')), 30_000) && pg.t('youSub') === "for tonight's ride", 'he runs: "He is running…", for tonight\'s ride', show(dash(pg)));
  st.wheel = 0; pg.live.refresh();
  ok(await pg.until(() => /^He stopped/.test(pg.t('status')), 30_000), 'he stops');
  await sleep(300);
  d = dash(pg);
  ok(/^He stopped for a moment\. A bet now counts for this ride: if he stays asleep, the lights go out and your bulb stays dark\. Bulb 7 or higher\.$/.test(d.status) && d.youSub === "for tonight's ride", 'he ran in this round: "A bet now counts for this ride: if he stays asleep, the lights go out and your bulb stays dark." (no promise of his next ride)', show(d));
  ok(pg.frames.last.msg === 'SHORT BREAK * LIGHTS FLICKER' && pg.frames.last.flicker, 'the board: "SHORT BREAK * LIGHTS FLICKER"', show(pg.frames.last));
  mt = meter(pg);
  ok(!mt.hidden && /^Bulb 5 lights in \d:\d\d$/.test(mt.text) && mt.tone === 'run', 'he ran in this round, then stopped: the round has his turns, so "Bulb 5 lights in m:ss"', show(mt));
  await pg.live.act();
  ok(await pg.until(() => /^Bet placed/.test(pg.t('status')), 30_000) && pg.t('status') === "Bet placed: 100 SQK on bulb 7, for tonight's ride.", '"Bet placed: 100 SQK on bulb 7, for tonight\'s ride."', pg.t('status'));
  const mineBet = (await c.allBets()).find((b) => b.owner.toLowerCase() === pa.toLowerCase());
  ok(mineBet && mineBet.betRound === D + 5 && mineBet.bulb === 7, `the bet is in round ${D + 5}, the round he ran in`, show(mineBet && { r: mineBet.betRound, b: mineBet.bulb }));
  // another visitor opens the page now: it never saw him run. The wheel's counter first at SqueekCore's count (no turns
  // in this round as far as it shows), then above it (his turns in this round)
  const coreNow = await C.createChain({ rpc: [anvil.url], squeekCore: c.core }).core.state();
  st.work = Number(coreNow.cumulativeWork);
  const PB = walletFor(pb);
  const pg2 = startPage(PB.provider);
  try {
    await connect(pg2);
    ok(await pg2.until(() => /^He stopped for a moment\. A bet now counts for this ride, or for his next ride if the lights go out\./.test(pg2.t('status')), 30_000), 'a page opened after he stopped, the counter at SqueekCore\'s count: "…or for his next ride if the lights go out"', pg2.t('status'));
    st.work = Number(coreNow.cumulativeWork) + 300;
    pg2.live.refresh();
    ok(await pg2.until(() => /if he stays asleep, the lights go out and your bulb stays dark/.test(pg2.t('status')), 30_000) && pg2.t('youSub') === "for tonight's ride", 'the counter above SqueekCore\'s count (his turns in this round): "A bet now counts for this ride: if he stays asleep…", for tonight\'s ride', show(dash(pg2)));
  } finally { pg2.stop(); }
  st.work = null;
  // he stays asleep: D+5 has his turns (bulb 5), D+6 and D+7 are quiet: the lights go out
  await c.at(D + 8, 20); await c.record(D + 7, new Map([[D + 5, 300]]));
  await sleep(LAG + 300);
  pg.live.refresh();
  ok(await pg.until(() => /stayed dark/.test(pg.t('status')), 60_000), 'the blackout: the page says your bulb stayed dark', show(dash(pg)));
  ok(/^Blackout after 5 bulbs\. Your bulb 7 stayed dark/.test(pg.t('status')), `"${pg.t('status')}"`);
  // the contract agrees: the bet stayed on that ride and lost
  // (counting it: read the rounds, then count the bets, a page at a time; earlier parts may have left nights to count)
  for (let i = 0; i < 20 && (await c.getBet(mineBet.id)).status === C.STATUS.WAITING; i++) {
    await anvil.rpc.request('eth_sendTransaction', [{ from: c.deployer, to: c.lights, data: C.encode.poke(16) }]);
    await anvil.rpc.request('eth_sendTransaction', [{ from: c.deployer, to: c.lights, data: C.encode.settle(64) }]);
  }
  const out = await c.outcome(mineBet.id), bet = await c.getBet(mineBet.id);
  const night = C.decode.night(await c.call(c.lights, C.encode.getNight(out.night)));
  // (when nobody won, its stake rides on in the bonus pot: lost to him, but not "ready" on chain)
  ok(bet.status === C.STATUS.COUNTED && out.payout === 0n && out.cls === C.CLS.LOSE && night.start === D && night.c === D + 6, `on chain: the bet counted in the ride of round ${D} (lights out at ${D + 6}) and lost`, show({ out: { ...out, payout: String(out.payout) }, start: night.start, c: night.c, status: bet.status }));
  pg.stop();
  // right after the blackout he gets on the wheel for a few minutes, then stops, before that round is recorded: a page
  // opened now knows from the wheel's counter that he started a ride (not "he is asleep, a bet counts for his next ride")
  const coreOut = await C.createChain({ rpc: [anvil.url], squeekCore: c.core }).core.state();
  st.wheel = 0; st.work = Number(coreOut.cumulativeWork) + 150;
  const pg3 = startPage(walletFor(pb).provider);
  try {
    await connect(pg3);
    ok(await pg3.until(() => /He got on the wheel and stopped for a moment\. A bet now counts for the ride he just started: if he stays asleep, the lights go out and your bulb stays dark\./.test(pg3.t('status')), 30_000) && pg3.t('youSub') === 'for the ride he just started' && pg3.t('playersTitle') === "This ride's bets", 'he ran since the last record, then stopped: "He got on the wheel and stopped for a moment. A bet now counts for the ride he just started…", "This ride\'s bets"', show({ ...dash(pg3), title: pg3.t('playersTitle') }));
    const f3 = pg3.frames.last;
    ok(f3 && /^BLACKOUT AFTER 5 BULBS \* SHORT BREAK \* LIGHTS ON SOON( \* BONUS POT \d+ ROLLS ON)?$/.test(f3.msg) && f3.flicker && f3.resting, 'the board: "BLACKOUT AFTER 5 BULBS * SHORT BREAK * LIGHTS ON SOON", and the cam shows a short break (not asleep)', show(f3));
    ok(/stopped for a moment/.test(pg3.t('caption')), 'the caption: he stopped for a moment', pg3.t('caption'));
  } finally { pg3.stop(); st.work = null; }
  }
  if (part('nowallet')) {
  // ---------------------------------------------------------------- 5. no wallet in the browser
  const page = 'http://127.0.0.1:8080/index.html?config=rehearsal.json';
  Object.defineProperty(globalThis, 'location', { value: { href: page + '#x' }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Twitter for iPhone' }, configurable: true });
  if (pg) pg.stop();
  pg = startPage(undefined);
  ok(await pg.until(() => pg.t('act') === 'How to bet on a phone'), 'a phone with no wallet: the button says "How to bet on a phone"', pg.t('act'));
  await pg.live.act();
  await sleep(300);
  const links = pg.$('status').links;
  ok(/^No wallet in this browser\. To bet, open this page in a wallet app's own browser/.test(pg.t('status')), 'a phone with no wallet: what to do', pg.t('status'));
  ok(links.length === 2 && links[0].href === 'https://metamask.app.link/dapp/127.0.0.1:8080/index.html?config=rehearsal.json' && links[1].href === page && links[1].textContent === 'Copy the link', 'with a way forward: "Open in MetaMask" (this page, its settings kept) and "Copy the link"', show(links.map((a) => [a.href, a.textContent])));
  pg.stop();
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, configurable: true });
  pg = startPage(undefined);
  ok(await pg.until(() => /Connect wallet/.test(pg.t('act'))), 'waited for "Connect wallet"', show(dash(pg)));
  await pg.live.act();
  await sleep(300);
  ok(/^No wallet found in this browser\. To bet, add a wallet such as MetaMask or Rabby/.test(pg.t('status')), 'a computer with no wallet: add one, then open the page again', pg.t('status'));
  pg.stop();
  }
} catch (e) {
  console.log('FAIL', e && e.stack || e); failures++;
} finally {
  if (pg) pg.stop();
  proxy.close(); anvil.stop(); H.killAll();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
