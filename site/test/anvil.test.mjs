#!/usr/bin/env node
// chain.js and the live model against the real LightsOn bytecode on a local anvil chain (nothing leaves the box,
// no keys: anvil's dev accounts are unlocked). Deploys MockCore, MockSQK and LightsOn from contracts/out, plays
// four nights (a normal one, bets sent in the blackout joining the next night, a false start that rolls its pot,
// a night that wins it), and checks:
//   - every read decodes (bets, nights, walker, open night, bonus pot) and matches what the contract stored
//   - the page's own walk of the core, bets per bulb and pot chain give, before the contract has counted anything,
//     exactly the payouts the contract pays after it settles, bet by bet, to the wei
//   - the wallet flow through a fake EIP-1193 wallet: connect, wrong network, allow exactly the bet, bet, a second
//     bet refused as "already bet", not enough SQK, collect (only what pays), and logs of your own bets.
// Usage: node site/test/anvil.test.mjs [--port N] (default: a free port)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../chain.js';
import * as M from '../live-model.js';
import * as E from '../engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'contracts', 'out');
const portArg = process.argv.indexOf('--port');
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : await freePort();
const URL_ = `http://127.0.0.1:${PORT}`;
const W = 10n ** 18n;
const STATION = 36;

let failures = 0;
const ok = (cond, msg, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail ? ` (${detail})` : ''}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytecode = (file, name) => {
  const d = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), 'utf8'));
  if (Object.keys(d.bytecode.linkReferences || {}).length) throw new Error(`${name} needs linking`);
  return d.bytecode.object;
};
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');

const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--host', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
const stop = () => { try { anvil.kill('SIGKILL'); } catch {} };
process.on('exit', stop);
const killer = setTimeout(() => { console.log('FAIL over 120 s, stopping'); stop(); process.exit(1); }, 120_000);

try {
  const rpc = C.createRpc([URL_], { timeoutMs: 5000 });
  for (let i = 0; ; i++) { try { await rpc.request('eth_chainId'); break; } catch { if (i > 50) throw new Error('anvil did not start'); await sleep(200); } }
  const accounts = await rpc.request('eth_accounts');
  const [deployer, p1, p2, p3, p4, me, p6, p7, p8, p9] = accounts;
  const poor = accounts[10] || '0x00000000000000000000000000000000000000f0';

  const send = async (from, to, data) => {
    const hash = await rpc.request('eth_sendTransaction', [{ from, to, data, gas: '0x1c9c380' }]);
    let r = null;
    for (let i = 0; !r && i < 100; i++) { r = await rpc.request('eth_getTransactionReceipt', [hash]); if (!r) await sleep(20); }
    if (!r || r.status !== '0x1') throw new Error(`tx from ${from.slice(0, 8)} to ${to ? to.slice(0, 8) : 'create'} failed`);
    return r;
  };
  const deploy = async (code) => (await send(deployer, null, code)).contractAddress;

  // time: round R = [G + (R-1)*600, G + R*600); start the clock in round 100
  const t0 = Number((await rpc.request('eth_getBlockByNumber', ['latest', false])).timestamp);
  const G = t0 - 99 * 600 - 5;
  const at = async (round, secs = 30) => { await rpc.request('evm_setNextBlockTimestamp', ['0x' + (G + (round - 1) * 600 + secs).toString(16)]); };
  const mine = async (round, secs = 30) => { await at(round, secs); await rpc.request('evm_mine', []); };

  const core = await deploy(bytecode('Mocks.sol', 'MockCore'));
  const sqk = await deploy(bytecode('Mocks.sol', 'MockSQK'));
  const lights = await deploy(bytecode('LightsOn.sol', 'LightsOn') + addrWord(core) + addrWord(sqk) + word(G) + word(STATION) + word(100));
  const deployBlock = Number(await rpc.request('eth_blockNumber'));
  const config = { chainId: 31337, rpc: [URL_], squeekCore: core, sqk, lightsOn: lights, deployBlock };
  const chain = C.createChain(config);

  // the mock helpers (cast sig): setActive(uint64,uint64), setSettled(uint64), mint(address,uint256)
  const sig = { setActive: '0x4bb7aa33', setSettled: '0xa915578b', mint: '0x40c10f19' };
  const coreActive = (r, w = 500) => send(deployer, core, sig.setActive + word(r) + word(w));
  const coreSettled = (r) => send(deployer, core, sig.setSettled + word(r));
  for (const a of [p1, p2, p3, p4, me, p6, p7, p8, p9]) await send(deployer, sqk, sig.mint + addrWord(a) + word(1000n * W));

  const k = await chain.lights.constants();
  ok(k.genesis === G && k.station === STATION && k.minBet === 10n * W && k.maxBet === 10_000n * W && k.core.toLowerCase() === core.toLowerCase() && k.sqk.toLowerCase() === sqk.toLowerCase(), 'constants: G, STATION, MIN_BET, MAX_BET, CORE, SQK read back');

  // a direct bet from an anvil account: allow exactly, then bet
  const betNow = async (from, bulb, amount) => {
    await send(from, sqk, C.encode.approve(lights, amount));
    return send(from, lights, C.encode.bet(bulb, amount));
  };

  // the wallet: a fake EIP-1193 provider over anvil, holding one account
  const events = {};
  let walletChain = '0x1';
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [me];
      if (method === 'eth_chainId') return walletChain;
      if (method === 'wallet_switchEthereumChain') { if (params[0].chainId !== '0x7a69') { const e = new Error('Unrecognized chain'); e.code = 4902; throw e; } walletChain = params[0].chainId; return null; }
      if (method === 'wallet_addEthereumChain') { provider.added = params[0]; walletChain = params[0].chainId; return null; }
      if (method === 'eth_sendTransaction' && provider.refuse) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
      return rpc.request(method, params);
    },
    on(e, f) { (events[e] ||= []).push(f); },
  };
  const wallet = C.createWallet(provider, config, chain);
  ok((await wallet.connect()) === me, 'wallet: connect shares the account');
  ok((await wallet.chainId()) === 1, 'wallet starts on another network');
  await wallet.switchChain();
  ok((await wallet.chainId()) === 31337 && !provider.added, 'wallet: switched to the game network');
  const fast = { everyMs: 50, timeoutMs: 10_000 };

  // ---------- night A: departs 103, bulbs in 104-108, blackout 109-110 ----------
  await at(101);
  const steps = [];
  let allowanceAtBet = null;
  const placed = await C.placeBet({ chain, wallet, account: me, bulb: 3, amount: 100n * W, waitOpts: fast, onStep: (s) => steps.push(s), beforeBet: async () => { allowanceAtBet = await chain.sqk.allowance(me, lights); await at(101, 40); } });
  ok(placed.betId === 0 && placed.bet && placed.bet.bulb === 3 && placed.bet.betRound === 101, `wallet: bet on bulb 3 placed in round 101 (bet ${placed.betId})`);
  ok(allowanceAtBet === 100n * W, 'wallet: the game was allowed exactly the bet, nothing more', String(allowanceAtBet));
  ok((await chain.sqk.allowance(me, lights)) === 0n, 'wallet: nothing left allowed after the bet');
  ok(steps.join(',') === 'check,allow,allowing,bet,betting,done', `wallet: steps ${steps.join(' > ')}`);
  await at(101, 100);
  await betNow(p1, 2, 100n * W);
  await at(101, 160);
  await betNow(p2, 5, 200n * W);
  await at(102);
  await betNow(p3, 8, 50n * W);
  // a second bet on the same ride is refused before the wallet even asks
  let err = null;
  steps.length = 0;
  try { await at(102, 90); await C.placeBet({ chain, wallet, account: me, bulb: 9, amount: 50n * W, waitOpts: fast, onStep: (s) => steps.push(s) }); } catch (e) { err = e; }
  ok(err && C.explain(err).kind === 'already' && !steps.includes('allow'), 'wallet: a second bet on the same ride is "already bet", stopped before any allow', err && err.message);
  err = null;
  try { await C.placeBet({ chain, wallet, account: poor, bulb: 9, amount: 50n * W, waitOpts: fast }); } catch (e) { err = e; }
  ok(err && C.explain(err).kind === 'balance', `wallet: no SQK reads "${err && C.explain(err).text}"`);
  err = null;
  provider.refuse = true;
  try { await C.placeBet({ chain, wallet, account: p9, bulb: 9, amount: 50n * W, waitOpts: fast }); } catch (e) { err = e; }
  provider.refuse = false;
  ok(err && C.explain(err).kind === 'rejected', 'wallet: saying no in the wallet reads "you said no"');

  for (let r = 103; r <= 108; r++) await coreActive(r);
  // round 105: the core has recorded 103 (departure) and 104 (bulb 1)
  await coreSettled(104);
  await at(105);
  await betNow(p4, 4, 100n * W); // litBefore 1, bulb 4 lights in 107 = N + 2: counts, weight 100 x 3
  {
    const st = await chain.core.state();
    const rounds = await chain.core.activeRounds(100, st.settledThrough);
    const view = M.walkNights({ rides: [], settledThrough: 100 }, rounds, st.settledThrough, STATION);
    const snap = await chain.lights.snapshot();
    const bets = await chain.lights.bets(0, snap.betCount);
    const g = M.groupBets(bets, view.rides);
    const pb = M.perBulb(g.current, me);
    ok(view.open && view.open.start === 103 && M.litOf(view.open) === 1, 'round 105: the page sees tonight open since 103 with 1 bulb lit');
    ok(snap.openNight.start === 103 && snap.openNight.litSoFar === 1 && snap.walker.cursor === 104, 'and so does the contract (openNight, walker)', JSON.stringify(snap.openNight));
    ok(g.current.length === 5 && pb.get(3).mine && pb.get(5).stake === 200n * W, `bets per bulb tonight: ${[...pb].map(([b, x]) => `${b}:${Number(x.stake / W)}`).join(' ')}`);
    ok(bets[4].owner.toLowerCase() === p4.toLowerCase() && bets[4].betRound === 105 && bets[4].bulb === 4 && bets[4].stake === 100n * W && bets[4].status === C.STATUS.WAITING, 'getBet decodes owner, round, bulb, stake, status');
    const win = M.betWindow({ S: 104, cur: 105, N: M.betRoundSent(G + 104 * 600 + 30, G), open: view.open, wheel: { fresh: true, running: true } });
    ok(win.floor === 4 && win.night === 'tonight', `round 105: lowest bulb ${win.floor}, for tonight's ride`);
  }
  await coreSettled(110);
  // ---------- blackout in 109-110: bets in 109 and 110 are for the next ride ----------
  await at(109);
  await betNow(p6, 1, 100n * W);
  await at(111);
  await betNow(p7, 3, 100n * W);
  // ---------- night B: departs 112, bulb 1 in 113, blackout 114 ----------
  await coreActive(112); await coreActive(113);
  await at(116);
  await betNow(p8, 2, 50n * W); // night C: a false start (117, then 118-119 quiet), bulb 2 stays dark, rolls on
  await coreActive(117);
  await at(120);
  await betNow(p9, 2, 100n * W); // night D: departs 121, bulbs 122-124, blackout 125: wins the 50 rolled in
  for (const r of [121, 122, 123, 124]) await coreActive(r);
  await coreSettled(126);
  await mine(127);

  // ---------- before the contract counts anything: the page's own numbers ----------
  const snapBefore = await chain.lights.snapshot();
  const st = await chain.core.state();
  const rounds = await chain.core.activeRounds(100, st.settledThrough);
  const view = M.walkNights({ rides: [], settledThrough: 100 }, rounds, st.settledThrough, STATION);
  ok(JSON.stringify(view.rides.map((r) => [r.start, r.C, r.lit, r.lastBetRound])) === '[[103,109,5,108],[112,114,1,113],[117,118,0,117],[121,125,3,124]]' && !view.open, `the page walks 4 nights: ${JSON.stringify(view.rides.map((r) => [r.start, r.C, r.lit]))}`);
  // the bets cranked the contract along: it may have settled the first nights already. The page reads from the
  // first bet of the first night it hasn't settled, and chains from the bonus pot the contract carries into it.
  const startIdx = snapBefore.nextSettle > 0 ? (await chain.lights.night(snapBefore.nextSettle - 1)).betEnd : 0;
  const unsettled = await chain.lights.bets(startIdx, snapBefore.betCount);
  const chained = M.chainPot(view.rides, M.groupBets(unsettled, view.rides).byRide, snapBefore.bonusPot);
  console.log(`     before settling: the contract had settled ${snapBefore.nextSettle} night(s), the page reads bets ${startIdx}-${snapBefore.betCount - 1}`);
  const allBets = await chain.lights.bets(0, snapBefore.betCount);
  const groups = M.groupBets(allBets, view.rides);
  const fromZero = M.chainPot(view.rides, groups.byRide, 0n);
  ok(groups.byRide.get(1).length === 5 && groups.byRide.get(2).length === 2 && groups.byRide.get(3).length === 1 && groups.byRide.get(4).length === 1 && groups.current.length === 0, 'bets land in their nights (the round-109 bet in night B)');
  ok(fromZero.potIn === chained.potIn && unsettled.every((b) => fromZero.results.get(b.id).payout === chained.results.get(b.id).payout), 'chaining from the contract\'s pot gives the same numbers as chaining every night from 0');

  // ---------- the contract counts and settles ----------
  await at(127, 60);
  await send(deployer, lights, C.encode.poke(16));
  await at(127, 90);
  await send(deployer, lights, C.encode.settle(500));
  const snapAfter = await chain.lights.snapshot();
  ok(snapAfter.nightCount === 4 && snapAfter.nextSettle === 4 && snapAfter.bonusPot === chained.potIn, `contract settled 4 nights, bonus pot ${snapAfter.bonusPot} == page ${chained.potIn}`);
  const outcomes = await chain.lights.outcomes(allBets.map((b) => b.id));
  const clsName = { [C.CLS.WIN]: 'win', [C.CLS.LOSE]: 'lose', [C.CLS.REFUND]: 'refund' };
  const mism = outcomes.filter((o) => { const p = fromZero.results.get(o.id); return !p || p.payout !== o.payout || p.cls !== clsName[o.cls] || !o.ready; });
  ok(mism.length === 0, `page payouts == contract payouts for all ${outcomes.length} bets, to the wei`, mism.map((o) => `#${o.id} ${o.payout} vs ${fromZero.results.get(o.id)?.payout}`).join('; '));
  const n0 = await chain.lights.night(0), n3 = await chain.lights.night(3);
  ok(n0.start === 103 && n0.c === 109 && n0.lastBetRound === 108 && n0.result === C.RESULT.PAID && n0.betEnd === 5, 'getNight(0): start 103, C 109, last bet round 108, paid, bets 0-4');
  ok(n3.bonusIn === 50n * W && n3.result === C.RESULT.PAID && n3.burned === W, 'getNight(3): won the 50 SQK bonus pot, burned 1 SQK (2%)');
  const p9out = outcomes.find((o) => o.id === allBets.find((b) => b.owner.toLowerCase() === p9.toLowerCase()).id);
  ok(p9out.payout === 149n * W, `night D's only winner gets its 100 + the 50 bonus pot - 1 burned = ${Number(p9out.payout) / 1e18}`);

  // ---------- your bets and collect ----------
  const mineLogs = await chain.lights.betIdsOf(me);
  ok(mineLogs && mineLogs.length === 1 && mineLogs[0].betId === 0 && mineLogs[0].bulb === 3, 'your bets from the BetPlaced logs (owner is indexed)');
  const myOut = (await chain.lights.outcomes([0]))[0];
  const before = await chain.sqk.balanceOf(me);
  steps.length = 0;
  const got = await C.collect({ chain, wallet, account: me, ids: [0], waitOpts: fast, onStep: (s) => steps.push(s) });
  const after = await chain.sqk.balanceOf(me);
  ok(got.collected === myOut.payout && after - before === myOut.payout && myOut.payout > 0n, `collect: ${Number(myOut.payout) / 1e18} SQK arrived (${steps.join(' > ')})`);
  err = null;
  try { await C.collect({ chain, wallet, account: me, ids: [0], waitOpts: fast }); } catch (e) { err = e; }
  ok(err && C.explain(err).kind === 'counting', 'collecting twice sends nothing (the simulation says nothing is due)');
  const b0 = (await chain.lights.bets(0, 1))[0];
  ok(b0.status === C.STATUS.CLAIMED, 'the bet now reads as collected');

  // ---------- a long night nobody touches: collect counts it, with one helper first ----------
  // you bet bulb 1 before he starts; he runs 36 rounds (a STATION end); nobody sends anything after. Collect's own
  // counting reads 2 pages of 16 rounds, not enough for 36, so it sends a helper (poke) first, then collects.
  await at(128);
  const second = await C.placeBet({ chain, wallet, account: me, bulb: 1, amount: 100n * W, waitOpts: fast });
  for (let r = 130; r <= 165; r++) await coreActive(r);
  await coreSettled(166);
  await mine(167);
  {
    const st2 = await chain.core.state();
    const v2 = M.walkNights({ rides: [], settledThrough: 100 }, await chain.core.activeRounds(100, st2.settledThrough), st2.settledThrough, STATION);
    const snap2 = await chain.lights.snapshot();
    const from = snap2.nextSettle > 0 ? (await chain.lights.night(snap2.nextSettle - 1)).betEnd : 0;
    const ch2 = M.chainPot(v2.rides, M.groupBets(await chain.lights.bets(from, snap2.betCount), v2.rides).byRide, snap2.bonusPot);
    const want = ch2.results.get(second.betId);
    ok(v2.rides.at(-1).end === 'station' && v2.rides.at(-1).lit === 35 && want && want.payout === 100n * W, `the page sees a STATION night (35 bulbs) and your 100 back as the only bet (${want && Number(want.payout) / 1e18})`);
    const outBefore = (await chain.lights.outcomes([second.betId]))[0];
    ok(!outBefore.ready, 'the contract has not counted it yet');
    const st = [];
    const got2 = await C.collect({ chain, wallet, account: me, ids: [second.betId], waitOpts: fast, onStep: (x) => st.push(x) });
    ok(got2.helpers.length === 1 && got2.collected === want.payout, `collect: ${got2.helpers.length} helper, then ${Number(got2.collected) / 1e18} SQK, the page's number (${st.join(' > ')})`);
  }
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack || e}`);
} finally {
  clearTimeout(killer);
  stop();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall anvil checks passed');
process.exit(failures ? 1 : 0);
