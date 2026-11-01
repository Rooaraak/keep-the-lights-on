#!/usr/bin/env node
// A quick browser pass of live mode WITH a game contract, on a local anvil chain (nothing leaves the box, no keys:
// anvil's dev accounts are unlocked). Not the full wallet test suite: one phone-size run through the main path.
//   deploy MockCore + MockSQK + LightsOn -> two other players bet -> the page: connect, switch network, pick a bulb,
//   allow exactly + bet (two wallet steps) -> he runs 4 bulbs and blacks out -> the page shows the blackout and
//   Collect right away (nobody else plays, so the collect itself counts the night) -> the SQK arrives.
// The page talks to anvil through the test (same origin, /__rpc), and window.ethereum is a small fake wallet that
// sends through anvil's unlocked account. Chrome stays under 90 s (the whole test is stopped at 85 s).
// The full browser suite is test/e2e.test.mjs; this is the quick pass.
// Usage: node site/test/contract.smoke.test.mjs [--out <dir for screenshots>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../chain.js';

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER || 'puppeteer');
const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const OUT_DIR = join(SITE, '..', 'contracts', 'out');
// free ports, picked at start (a fixed port can be held by another local server)
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const WEB = await freePort(), ANVIL = await freePort(), ORIGIN = `http://127.0.0.1:${WEB}`, RPC = `http://127.0.0.1:${ANVIL}`;
const outArg = process.argv.indexOf('--out');
const SHOTS = outArg > 0 ? resolve(process.argv[outArg + 1]) : mkdtempSync(join(tmpdir(), 'lights-contract-'));
mkdirSync(SHOTS, { recursive: true });
process.on('exit', () => { if (outArg < 0) rmSync(SHOTS, { recursive: true, force: true }); }); // keep screenshots only with --out
const W = 10n ** 18n;

let passed = 0, failed = 0;
const check = (ok, what, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const bytecode = (file, name) => JSON.parse(readFileSync(join(OUT_DIR, file, `${name}.json`), 'utf8')).bytecode.object;

const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(ANVIL), '--host', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
const web = spawn('python3', ['-m', 'http.server', String(WEB), '--directory', SITE, '--bind', '127.0.0.1'], { stdio: 'ignore' });
const stopAll = () => { for (const p of [anvil, web]) { try { process.kill(p.pid, 'SIGKILL'); } catch {} } };
process.on('exit', stopAll);

let browser = null, chromePid = null;
const killer = setTimeout(() => { console.log('FAIL over 85 s'); try { if (chromePid) process.kill(chromePid, 'SIGKILL'); } catch {} stopAll(); process.exit(1); }, 85_000);

try {
  const rpc = C.createRpc([RPC], { timeoutMs: 5000 });
  for (let i = 0; ; i++) { try { await rpc.request('eth_chainId'); break; } catch { if (i > 50) throw new Error('anvil did not start'); await sleep(200); } }
  const [deployer, me, p1, p2] = await rpc.request('eth_accounts');
  const send = async (from, to, data) => {
    const hash = await rpc.request('eth_sendTransaction', [{ from, to, data, gas: '0x1c9c380' }]);
    let r = null;
    for (let i = 0; !r && i < 100; i++) { r = await rpc.request('eth_getTransactionReceipt', [hash]); if (!r) await sleep(20); }
    if (!r || r.status !== '0x1') throw new Error('tx failed');
    return r;
  };
  const t0 = Number((await rpc.request('eth_getBlockByNumber', ['latest', false])).timestamp);
  const G = t0 - 99 * 600 - 20; // the chain is 20 s into round 100
  const core = (await send(deployer, null, bytecode('Mocks.sol', 'MockCore'))).contractAddress;
  const sqk = (await send(deployer, null, bytecode('Mocks.sol', 'MockSQK'))).contractAddress;
  const lights = (await send(deployer, null, bytecode('LightsOn.sol', 'LightsOn') + addrWord(core) + addrWord(sqk) + word(G) + word(36) + word(99))).contractAddress;
  const deployBlock = Number(await rpc.request('eth_blockNumber'));
  const sig = { setActive: '0x4bb7aa33', setSettled: '0xa915578b', mint: '0x40c10f19' };
  for (const a of [me, p1, p2]) await send(deployer, sqk, sig.mint + addrWord(a) + word(1000n * W));
  await send(deployer, core, sig.setSettled + word(99));
  for (const [who, bulb, amt] of [[p1, 2, 100n], [p2, 5, 200n]]) {
    await send(who, sqk, C.encode.approve(lights, amt * W));
    await send(who, lights, C.encode.bet(bulb, amt * W));
  }
  const config = { chainId: 31337, chainName: 'Anvil', rpc: [`${ORIGIN}/__rpc`], explorer: '', squeekCore: core, sqk, lightsOn: lights, deployBlock, walkFrom: 99, statusApi: `${ORIGIN}/__status` };

  // ---------- the page ----------
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  chromePid = browser.process().pid;
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // the fake wallet: starts on another network; the test answers its requests
  await page.evaluateOnNewDocument(() => {
    const listeners = {};
    window.ethereum = {
      request: async ({ method, params }) => {
        const res = await fetch('/__wallet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
        const j = await res.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') (listeners.chainChanged || []).forEach((f) => f('0x7a69'));
        return j.result;
      },
      on: (e, f) => { (listeners[e] ||= []).push(f); },
    };
  });
  let walletChain = '0x1', shared = false; // like a real wallet: no account until the page asks
  const walletLog = [];
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    try {
      if (u === `${ORIGIN}/config.json`) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
      if (u === `${ORIGIN}/__status`) return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: new Date().toISOString(), measurement: { observedAt: new Date().toISOString(), staleAfterSeconds: 120, speedMmPerSecond: 0, rpmMilli: 0 } }) });
      if (u === `${ORIGIN}/__rpc`) {
        const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
        return req.respond({ status: 200, contentType: 'application/json', body: await r.text() });
      }
      if (u === `${ORIGIN}/__wallet`) {
        const { method, params } = JSON.parse(req.postData());
        walletLog.push(method === 'eth_sendTransaction' ? `send ${params[0].data.slice(0, 10)}` : method);
        let result = null, error = null;
        if (method === 'eth_requestAccounts') { shared = true; result = [me]; }
        else if (method === 'eth_accounts') result = shared ? [me] : [];
        else if (method === 'eth_chainId') result = walletChain;
        else if (method === 'wallet_switchEthereumChain') { if (params[0].chainId === '0x7a69') walletChain = '0x7a69'; else error = { code: 4902, message: 'Unrecognized chain' }; }
        else { try { result = await rpc.request(method, params); } catch (e) { error = { code: e.code ?? -32000, message: e.message, data: e.data }; } }
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(error ? { error } : { result }) });
      }
      if (u.startsWith(ORIGIN)) return req.continue();
      return req.respond({ status: 200, contentType: u.includes('css') ? 'text/css' : 'text/plain', body: '' });
    } catch (e) { errors.push(`test proxy: ${e.message}`); return req.respond({ status: 500, body: '' }); }
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${ORIGIN}/index.html`)).ok) break; } catch {} await sleep(100); }
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());
  const waitText = (sel, re, ms = 15_000) => page.waitForFunction((s, src) => new RegExp(src).test(document.querySelector(s).textContent), { timeout: ms }, sel, re.source).catch(() => null);
  const refresh = () => page.evaluate(() => window.lightsPage.live.refresh());

  await waitText('#act', /Connect wallet/);
  check(/Connect wallet/.test(await text('#act')), 'with a game contract: the button is "Connect wallet"', await text('#act'));
  await waitText('#riders', /bulb 5/);
  const riders = await text('#riders');
  check(/bulb 2/.test(riders) && /bulb 5/.test(riders) && /Bets for his next ride/.test(await text('#playersTitle')), 'the two bets already placed show for his next ride', riders);
  check(/He is asleep\. A bet now counts for his next ride/.test(await text('#status')), 'he is asleep: a bet counts for his next ride', await text('#status'));
  await page.click('#act');
  await waitText('#act', /Switch to Anvil/);
  check(/Switch to Anvil/.test(await text('#act')), 'the wallet is on another network: "Switch to Anvil"', await text('#act'));
  await page.click('#act');
  await waitText('#act', /^Bet 100 on bulb/);
  await waitText('#walletLine', /you have 1,000 SQK/);
  check(/you have 1,000 SQK/.test(await text('#walletLine')), 'connected: the wallet line shows 1,000 SQK', await text('#walletLine'));
  // pick bulb 3 with the minus button
  for (let i = 0; i < 3; i++) { await page.click('#bMinus'); await sleep(80); }
  await sleep(300);
  check(await text('#bPick') === '3' && /Bulb 3 · 30 min · no nights to count yet/.test(await text('#pickOdds')), 'bulb 3 picked; next to the picker its odds (this made-up chain has no nights yet)', await text('#pickOdds'));
  check(/^If the lights go out right after bulb 3$/.test(await text('#moneyLabel')) && /^[+−±]/.test(await text('#money')), `the one number: ${await text('#money')}`);
  await page.screenshot({ path: join(SHOTS, 'contract-before-bet.png') });
  await page.click('#act');
  await waitText('#status', /Bet placed/, 20_000);
  check(/Bet placed: 100 SQK on bulb 3, for his next ride/.test(await text('#status')), 'bet placed through the wallet, for his next ride', await text('#status'));
  const sends = walletLog.filter((x) => x.startsWith('send'));
  check(sends.length === 2 && sends[0] === 'send 0x095ea7b3' && sends[1] === 'send 0xffc37000', `two wallet steps: allow, then the bet (betUntil) (${sends.join(', ')})`);
  const allowance = BigInt(await rpc.request('eth_call', [{ to: sqk, data: C.encode.allowance(me, lights) }, 'latest']));
  check(allowance === 0n, 'the game was allowed exactly the bet: nothing left allowed after it');
  await refresh();
  await waitText('#act', /Bet placed/);
  check(/Bet placed/.test(await text('#act')), 'the button now says "Bet placed"', await text('#act'));
  await waitText('#mine', /waits for his next ride/);
  check(/Bulb 3 · 100 SQK/.test(await text('#mine')) && /waits for his next ride/.test(await text('#mine')), 'your bets: bulb 3, waiting for his next ride', await text('#mine'));

  // ---------- he runs: departs 101, bulbs 102-105, blackout 106-107 ----------
  for (let r = 101; r <= 105; r++) await send(deployer, core, sig.setActive + word(r) + word(500));
  await send(deployer, core, sig.setSettled + word(107));
  await rpc.request('evm_setNextBlockTimestamp', ['0x' + (G + 107 * 600 + 40).toString(16)]); // round 108, 40 s in
  await rpc.request('evm_mine', []);
  await refresh();
  await waitText('#status', /Blackout after 4 bulbs/, 20_000);
  check(/Blackout after 4 bulbs/.test(await text('#status')), 'the page follows the chain clock forward and shows the blackout after 4 bulbs', await text('#status'));
  await waitText('#mine', /to collect/);
  check(/lit · [\d,.]+ SQK to collect/.test(await text('#mine')), `your bet: lit, ready to collect (${await text('#mine')})`);
  check(/Press Collect to count the ride and take your [\d,.]+ SQK/.test(await text('#status')) || /Blackout after 4 bulbs/.test(await text('#status')), 'the status tells you to press Collect', await text('#status'));

  // ---------- nobody else plays: the contract hasn't counted the night, and Collect does it ----------
  const walkerBefore = await rpc.request('eth_call', [{ to: lights, data: C.SEL.getWalker }, 'latest']);
  check(C.decode.walker(walkerBefore).cursor <= 100, 'the contract has not read the night yet (nobody sent anything since)');
  await waitText('#act', /^Collect /, 20_000);
  const label = await text('#act');
  check(/^Collect [\d,.]+ SQK$/.test(label), `the button is "${label}" right after the blackout`);
  const before = BigInt(await rpc.request('eth_call', [{ to: sqk, data: C.encode.balanceOf(me) }, 'latest']));
  walletLog.length = 0;
  await page.click('#act');
  await waitText('#status', /Collected/, 20_000);
  const after = BigInt(await rpc.request('eth_call', [{ to: sqk, data: C.encode.balanceOf(me) }, 'latest']));
  const due = BigInt(await rpc.request('eth_call', [{ to: lights, data: C.encode.betOutcome(2) }, 'latest']).then((d) => '0x' + d.slice(2 + 64 * 3, 2 + 64 * 4)));
  check(after - before === due && label === `Collect ${sqkText(due)} SQK` && /Collected/.test(await text('#status')), `one collect counted the night and paid ${Number(after - before) / 1e18} SQK, what the button said and what the contract owes`, `${label} / ${await text('#status')}`);
  check(walletLog.filter((x) => x.startsWith('send')).join() === 'send 0x6ba4c138', `a single wallet step (${walletLog.filter((x) => x.startsWith('send')).join(', ')})`);
  await refresh();
  await waitText('#mine', /collected/);
  check(/collected/.test(await text('#mine')), 'your bets: collected', await text('#mine'));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 360, 'no sideways scroll at 360 px', String(wide));
  await page.screenshot({ path: join(SHOTS, 'contract-after-collect.png'), fullPage: true });
  const all = await page.evaluate(() => document.body.innerText);
  check(!/can.?t lose|claim|approve|revert|nonce/i.test(all), 'no "can\'t lose" and no jargon on the page', (all.match(/can.?t lose|claim|approve|revert|nonce/i) || [])[0]);
  check(errors.length === 0, 'no console errors', errors.join(' | '));
} catch (e) {
  failed++; console.log(`FAIL ${e.stack || e}`);
} finally {
  clearTimeout(killer);
  if (browser) await browser.close().catch(() => {});
  try { if (chromePid) process.kill(chromePid, 'SIGKILL'); } catch {}
  stopAll();
}
console.log(`\n${passed} passed, ${failed} failed${outArg > 0 ? ` · screenshots in ${SHOTS}` : ''}`);
process.exit(failed ? 1 : 0);

function sqkText(wei) {
  const cents = (wei * 100n + W / 2n) / W, whole = cents / 100n, frac = cents % 100n;
  return `${whole.toLocaleString('en-US')}${frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : ''}`;
}
