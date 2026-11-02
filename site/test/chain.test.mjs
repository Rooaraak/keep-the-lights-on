#!/usr/bin/env node
// chain.js offline: every encoder against `cast calldata` (Foundry 1.7.1, values pasted below), every decoder
// against raw answers saved from Sepolia (test/fixtures, decoded by `cast call` with the return types), the revert
// reasons, the plain-words messages, RPC failover and batching on a fake fetch, and the wheel's freshness rule.
// Optional: --live also reads the real SqueekCore once (gentle: 3 calls) and checks the page's walk against it.
// Usage: node site/test/chain.test.mjs [--live]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../chain.js';
import { holdWheel } from '../live-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8').trim();
let failures = 0;
const ok = (cond, msg, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail ? ` (${detail})` : ''}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(a === b, msg, `${a} != ${b}`);

const A = '0x1111111111111111111111111111111111111111', S = '0x2222222222222222222222222222222222222222';
const W = 10n ** 18n;

// ---------- encoders vs cast calldata ----------
eq(C.encode.approve(S, 100n * W), '0x095ea7b300000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000056bc75e2d63100000', 'approve(spender, 100 SQK)');
eq(C.encode.bet(6, 100n * W), '0x7c69538400000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000056bc75e2d63100000', 'bet(6, 100 SQK)');
eq(C.encode.betUntil(6, 100n * W, 845), '0xffc3700000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000000000000000000000000000000000000000034d', 'betUntil(6, 100 SQK, round 845)');
eq(C.encode.claim([1, 2, 300]), '0x6ba4c1380000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000012c', 'claim([1, 2, 300])');
eq(C.encode.claim([]), '0x6ba4c13800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000', 'claim([])');
eq(C.encode.balanceOf(A), '0x70a082310000000000000000000000001111111111111111111111111111111111111111', 'balanceOf');
eq(C.encode.allowance(A, S), '0xdd62ed3e00000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222', 'allowance');
eq(C.encode.roundPage(780, 842, 16), '0xc8b9e08f000000000000000000000000000000000000000000000000000000000000030c000000000000000000000000000000000000000000000000000000000000034a0000000000000000000000000000000000000000000000000000000000000010', 'roundPage(780, 842, 16)');
eq(C.encode.getBet(7), '0x061e494f0000000000000000000000000000000000000000000000000000000000000007', 'getBet(7)');
eq(C.encode.poke(4), '0x32145f900000000000000000000000000000000000000000000000000000000000000004', 'poke(4)');
eq(C.encode.settle(64), '0x8df828000000000000000000000000000000000000000000000000000000000000000040', 'settle(64)');
eq(C.encode.lastBet(A), '0x2c4ef7b50000000000000000000000001111111111111111111111111111111111111111', 'lastBet');
let threw = 0;
for (const f of [() => C.encode.approve('0x12', 1n), () => C.encode.bet(1, -1n), () => C.encode.bet(1.5, 1n), () => C.encode.approve(S, 1n << 256n)]) { try { f(); } catch { threw++; } }
eq(threw, 4, 'bad addresses and amounts are refused, not encoded');

// ---------- decoders vs saved Sepolia answers ----------
{
  const p = C.decode.roundPage(fx('roundPage-780-842-16.hex'));
  ok(p.certifiedThrough === 842 && p.start.cumulativeWork === 62576n && p.end.cumulativeWork === 67023n && p.end.workPerThousandBlocks === 10958, 'roundPage(780, 842, 16): certified 842, ledger 62,576 -> 67,023', JSON.stringify({ c: p.certifiedThrough, s: String(p.start.cumulativeWork) }));
  ok(JSON.stringify(p.rounds.map((r) => r.roundId)) === '[791,792,793,794,795,796,797,819,820,821]', 'its 10 records are rounds 791-797 and 819-821', JSON.stringify(p.rounds.map((r) => r.roundId)));
  ok(p.rounds[0].cumulativeWork === 63065n && p.rounds[0].cumulativeBlockUnits === 5614819553022n && p.rounds[0].workPerThousandBlocks === 10979 && p.rounds[0].dataHash === '0x639671c86ab93629a622fb45c95a00c41b901507893563ee3ac7674d6ea9c4e6', 'record 791 decodes field by field as cast does');
  const q = C.decode.roundPage(fx('roundPage-780-842-3.hex'));
  ok(q.certifiedThrough === 793 && q.rounds.length === 3 && q.rounds[2].roundId === 793, 'roundPage(780, 842, 3) hits the cap: certified 793 = the round before 794, the first that did not fit');
  const r = C.decode.roundPage(fx('roundPage-52-80-1.hex'));
  ok(r.certifiedThrough === 54 && r.rounds.length === 1 && r.rounds[0].roundId === 53 && r.start.cumulativeWork === 4304n && r.rounds[0].cumulativeWork === 4815n, 'roundPage(52, 80, 1): record 53, certified 54 (docs/claims-check.md)');
  const s = C.decode.state(fx('state-12040340.hex'));
  ok(s.settledThrough === 842 && s.cumulativeWork === 67023n && s.paused === false, 'state() at block 12040340: settled through 842, not paused');
  let bad = 0;
  for (const h of ['0x', '0x1234', fx('roundPage-780-842-16.hex').slice(0, 2 + 64 * 9)]) { try { C.decode.roundPage(h); } catch { bad++; } }
  eq(bad, 3, 'cut-off or malformed pages are refused');
}
{
  // getBet/getNight/getWalker/betOutcome are static tuples: their words in order
  const w = (...xs) => '0x' + xs.map((x) => BigInt(x).toString(16).padStart(64, '0')).join('');
  const b = C.decode.bet(w(BigInt(A), 845, 6, 1, 2, 3, 4, 100n * W, 12345));
  ok(b.owner === A && b.betRound === 845 && b.bulb === 6 && b.status === 1 && b.cls === 2 && b.litBefore === 3 && b.night === 4 && b.stake === 100n * W && b.cumBefore === 12345n, 'getBet: owner, betRound, bulb, status, cls, litBefore, night, stake, cumBefore');
  const n = C.decode.night(w(791, 798, 0x7f, 799, 797, 12, 1, 9, 8, 7, 6, 5));
  ok(n.start === 791 && n.c === 798 && n.stops === 0x7fn && n.spanEnd === 799 && n.lastBetRound === 797 && n.betEnd === 12 && n.result === 1 && n.sumW === 9n && n.burned === 5n, 'getNight: 12 words in Night order');
  const k = C.decode.walker(w(842, 0, 0, 0, 821, 821));
  ok(k.cursor === 842 && k.openStart === 0 && k.lastActive === 821 && k.lastBetRound === 821, 'getWalker');
  const o = C.decode.outcome(w(3, 1, 1, 183n * W, 1));
  ok(o.night === 3 && o.cls === 1 && o.result === 1 && o.payout === 183n * W && o.ready === true, 'betOutcome');
  const log = C.decode.betPlaced({ topics: [C.TOPIC.BetPlaced, '0x' + '7'.padStart(64, '0'), '0x' + A.slice(2).padStart(64, '0')], data: w(6, 100n * W, 845), blockNumber: '0x10', transactionHash: '0x' + 'ab'.repeat(32) });
  ok(log.betId === 7 && log.owner === A && log.bulb === 6 && log.stake === 100n * W && log.betRound === 845 && log.block === 16, 'BetPlaced log: indexed betId and owner, then bulb, amount, betRound');
}

// ---------- revert reasons and plain words ----------
{
  const bal = '0xe450d38c00000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000022b1c8c1227a000000000000000000000000000000000000000000000000000056bc75e2d63100000';
  const r = C.decodeRevert(bal);
  ok(r.name === 'ERC20InsufficientBalance' && r.args[1] === 40n * W && r.args[2] === 100n * W, 'ERC20InsufficientBalance(holder, 40, 100) decodes (cast calldata)');
  eq(C.explain({ revert: r }).text, 'Not enough SQK: you have 40, this bet needs 100.', 'and reads as plain words');
  const str = C.decodeRevert('0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000762616c616e636500000000000000000000000000000000000000000000000000');
  ok(str.name === 'Error' && str.args[0] === 'balance', 'Error("balance") from the local MockSQK decodes');
  // MetaMask-style nesting, an RpcError, a message with the data in it
  const nested = { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, message: 'execution reverted', data: '0xa820742e' } };
  eq(C.explain(nested).kind, 'already', 'AlreadyBet found inside a wallet error (data.data)');
  eq(C.explain(new C.RpcError('execution reverted', { code: 3, data: '0x749b5939' })).kind, 'amount', 'BadAmount from the node');
  eq(C.explain({ message: 'execution reverted: custom error 0xccbb40ce' }).kind, 'ended', 'IsVoided found in a message');
  eq(C.explain({ cause: { data: { originalError: { data: '0x2e96fc6c' } } } }).kind, 'bulb', 'BadBulb under cause.data.originalError');
  eq(C.explain({ code: 4001, message: 'User rejected the request.' }).kind, 'rejected', 'a no in the wallet');
  eq(C.explain({ code: 'ACTION_REJECTED' }).kind, 'rejected', 'a no in the wallet (ethers code)');
  eq(C.explain({ code: -32002 }).kind, 'pending', 'a request already open in the wallet');
  eq(C.explain({ code: 'WRONG_NETWORK' }).kind, 'network', 'the wrong network');
  eq(C.explain({ message: 'insufficient funds for gas * price + value' }).kind, 'gas', 'no Sepolia ETH for the fee');
  eq(C.explain(new C.RpcError('could not reach', { transport: true })).kind, 'offline', 'the network is down');
  // errors added by the contract's audit fixes (selectors from cast sig)
  eq(C.explain(new C.RpcError('execution reverted', { code: 3, data: '0xecdd1c29' })).kind, 'late', 'TooLate (betUntil landed after its round)');
  eq(C.explain({ code: -32603, data: { code: 3, data: '0x5d3c83b2' } }).kind, 'catchup', 'PokeFirst (the game is catching up)');
  ok(['0xc28d4aae', '0xeb966ada', '0x085de625', '0xc27d258a', '0xba329a9b', '0x383c03c7'].every((sel) => C.decodeRevert(sel).name !== 'Unknown'), 'NeedMoreGas, SettleFirst, TooEarly, NotStalled, NotSettled, BadPage are known');
  const words = ['AlreadyBet', 'BadAmount', 'BadBulb', 'IsVoided', 'ERC20InsufficientAllowance', 'TooLate', 'PokeFirst'].map((n) => C.explain({ revert: { name: n, args: [A, 0n, 1n] } }).text).join(' ');
  ok(!/claim|approve|revert|allowance|nonce|gas/i.test(words), 'no jargon in the bet messages', words);
}

// ---------- RPC failover and batching on a fake fetch ----------
{
  const seen = [];
  const answer = (body) => (Array.isArray(body) ? body.map((b) => ({ jsonrpc: '2.0', id: b.id, result: '0x' + (b.id % 255).toString(16).padStart(2, '0') })) : { jsonrpc: '2.0', id: body.id, result: '0x01' });
  const fetchFn = async (url, init) => {
    seen.push(url);
    if (url.includes('down')) throw new TypeError('Failed to fetch');
    if (url.includes('busy')) return { status: 429, json: async () => ({}) };
    return { status: 200, json: async () => answer(JSON.parse(init.body)) };
  };
  const rpc = C.createRpc(['https://down.example', 'https://busy.example', 'https://up.example'], { fetchFn });
  eq(await rpc.request('eth_chainId'), '0x01', 'skips an RPC that is down and one that rate-limits');
  seen.length = 0;
  await rpc.request('eth_chainId');
  ok(seen.length === 1 && seen[0] === 'https://up.example', 'and keeps using the one that answered');
  const res = await rpc.batch(Array.from({ length: 45 }, () => ({ method: 'eth_call', params: [] })));
  ok(res.length === 45 && res.every((r) => typeof r.result === 'string') && seen.length === 1 + 3, `45 calls go as 3 batches of up to 20 (${seen.length - 1} requests)`);
  // a node that answers batches with a single error object: one by one from then on
  let posts = 0;
  const noBatch = C.createRpc(['https://one.example'], { fetchFn: async (u, init) => { posts++; const b = JSON.parse(init.body); return { status: 200, json: async () => (Array.isArray(b) ? { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch not allowed' } } : { jsonrpc: '2.0', id: b.id, result: '0x02' }) }; } });
  const r2 = await noBatch.batch([{ method: 'a' }, { method: 'b' }, { method: 'c' }]);
  ok(r2.every((r) => r.result === '0x02') && posts === 4, 'a node that refuses batches gets the calls one by one');
  // a revert is an answer, not a dead RPC: no failover, the data comes through
  const revert = C.createRpc(['https://a.example', 'https://b.example'], { fetchFn: async (u, init) => { seen.push(u); const b = JSON.parse(init.body); return { status: 200, json: async () => ({ jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted', data: '0xa820742e' } }) }; } });
  seen.length = 0;
  let err;
  try { await revert.request('eth_call', [{}]); } catch (e) { err = e; }
  ok(err && err.data === '0xa820742e' && !err.transport && seen.length === 1, 'a revert comes back with its data and does not switch RPC');
  const dead = C.createRpc(['https://down.example'], { fetchFn });
  try { await dead.request('eth_chainId'); err = null; } catch (e) { err = e; }
  ok(err && err.transport, 'all RPCs down is a transport error');
}

// ---------- the wheel ----------
{
  const at = (obsAgo, speed, staleAfter = 120) => C.readWheel({ generatedAt: '2026-11-01T10:15:10.000Z', measurement: { observedAt: new Date(Date.parse('2026-11-01T10:15:10.000Z') - obsAgo * 1000).toISOString(), speedMmPerSecond: speed, staleAfterSeconds: staleAfter, coreStatus: speed ? 'IDLE' : 'ACTIVE', rpmMilli: speed * 100 } });
  const a = at(5, 230), b = at(5, 0), c = at(300, 230), d = C.readWheel({});
  ok(a.fresh && a.running, 'speed > 0 on a fresh reading = running (coreStatus ignored)');
  ok(b.fresh && !b.running, 'speed 0 on a fresh reading = resting');
  ok(!c.fresh && !c.running, 'an old reading says nothing');
  ok(!d.fresh && !d.running, 'an empty answer says nothing');
  // the wheel's counter (a string in the real answer, e.g. "71387") and how old the reading is
  const e = C.readWheel({ generatedAt: '2026-11-01T23:37:09.063Z', measurement: { observedAt: '2026-11-01T23:37:08.269Z', staleAfterSeconds: 120, speedMmPerSecond: 0, rpmMilli: 0, cumulativeWorkUnits: '71387' } });
  ok(e.fresh && e.work === 71387 && Math.abs(e.age - .794) < .01, 'the wheel\'s counter is read (71387) with the reading\'s age (0.8 s)', JSON.stringify(e));
  ok(a.work === null && d.work === null && C.readWheel({ measurement: { cumulativeWorkUnits: 'x' } }).work === null, 'no counter (or a bad one): work is null');
}

// ---------- optional: the real SqueekCore, gently ----------
if (process.argv.includes('--live')) {
  const chain = C.createChain({ rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'], squeekCore: '0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44' });
  const st = await chain.core.state();
  const rounds = await chain.core.activeRounds(780, Math.min(st.settledThrough, 900));
  const want = [[791, 489], [792, 648]];
  ok(want.every(([id, work]) => rounds.find((r) => r.id === id)?.work === work), `live: rounds after 780 read with their turns (${rounds.length} active through ${Math.min(st.settledThrough, 900)}, 791 = 489 turns)`);
  const id = await chain.chainId();
  eq(id, 11155111, 'live: the RPC is Sepolia');
}

// After the allow step, the node that simulates the bet may not have seen it yet (the Sepolia rehearsal hit this):
// placeBet asks the wallet's own node, looks again a few times instead of failing, and asks the wallet to allow only
// once. If no node shows it in that time, it says the allow went through (never "wasn't allowed"), and the next press
// goes straight to the bet.
{
  const GAME = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), ME = '0x' + '33'.repeat(20), amount = 100n * 10n ** 18n;
  // lagLooks: how many page-node looks after the allow still miss it; walletSees: undefined = the wallet doesn't
  // answer reads, true/false = its node shows the allow / doesn't; approvedAlready: the allow went through on an
  // earlier press (the page remembers it as priorAllow)
  const run = async (lagLooks, { walletSees, approvedAlready = false, priorAllow = null } = {}) => {
    let approved = approvedAlready, looksAfter = 0, approves = 0, bets = 0, pauses = 0, walletLooks = 0;
    const steps = [];
    const chain = { lights: { address: GAME }, config: { sqk: TOKEN }, sqk: { balanceOf: async () => amount * 10n, allowance: async () => (approved && looksAfter > lagLooks ? amount : 0n) } };
    const wallet = {
      preflight: async () => {
        if (approved && ++looksAfter > lagLooks) return '0x';
        throw Object.assign(new Error('reverted'), { revert: { name: 'Error', args: ['allowance'] } });
      },
      send: async (from, to) => { if (to === TOKEN) { approves++; approved = true; return '0xa1'; } bets++; return '0xb2'; },
      waitReceipt: async () => ({ ok: true, receipt: { logs: [] } }),
    };
    if (walletSees !== undefined) {
      wallet.simulate = async () => {
        walletLooks++;
        if (approved && walletSees) return '0x';
        throw Object.assign(new Error('this would fail'), { revert: { name: 'Error', args: ['allowance'] } });
      };
    }
    let err = null, res = null;
    try { res = await C.placeBet({ chain, wallet, account: ME, bulb: 4, amount, priorAllow, onStep: (s) => steps.push(s), waitOpts: { sleep: async () => { pauses++; } } }); } catch (e) { err = e; }
    return { err, res, approves, bets, pauses, walletLooks, steps };
  };
  const show = (x) => JSON.stringify({ e: x.err && (x.err.code || x.err.message), a: x.approves, b: x.bets, p: x.pauses, w: x.walletLooks, s: x.steps });
  const slow = await run(3);
  ok(!slow.err && slow.approves === 1 && slow.bets === 1 && slow.pauses === 3, 'allow seen only on the 4th look: the bet goes out after 3 short waits, with one allow', show(slow));
  ok(slow.steps.join() === 'check,allow,allowing,allowed,allowWait,bet,betting,done', 'and the page hears "allowed" (to remember it) and "allowWait" once (to say it went through)', show(slow));
  const viaWallet = await run(99, { walletSees: true });
  ok(!viaWallet.err && viaWallet.approves === 1 && viaWallet.bets === 1 && viaWallet.pauses === 0 && viaWallet.walletLooks === 1, "the page's node lags but the wallet's own node shows the allow: the bet goes out at once, one allow", show(viaWallet));
  const never = await run(99);
  ok(never.err && never.err.code === 'ALLOW_SLOW' && never.approves === 1 && never.bets === 0 && never.pauses === C.ALLOW_LAG.tries, `allow never seen (the wallet can't check): stops after ${C.ALLOW_LAG.tries} looks, no second allow, no bet`, show(never));
  const neverW = await run(99, { walletSees: false });
  ok(neverW.err && neverW.err.code === 'ALLOW_SLOW' && neverW.approves === 1 && neverW.bets === 0 && neverW.walletLooks === 2, "neither node shows it: the same, after asking the wallet's node twice", show(neverW));
  const said = C.explain(never.err).text;
  ok(/allow went through/.test(said) && /won't ask to allow again/.test(said) && !/wasn't allowed/.test(said), `it says the allow went through, not "wasn't allowed": "${said}"`);
  // the next press, with the allow remembered: no second allow, whatever the nodes show
  const next = await run(99, { approvedAlready: true, priorAllow: { amount } });
  ok(!next.err && next.approves === 0 && next.bets === 1, "next press, the page's node still lags and the wallet can't check: straight to the bet, no second allow", show(next));
  const nextW = await run(99, { approvedAlready: true, priorAllow: { amount }, walletSees: true });
  ok(!nextW.err && nextW.approves === 0 && nextW.bets === 1 && nextW.pauses === 0, "next press, the wallet's node shows it: the bet at once", show(nextW));
  const nextSeen = await run(0, { approvedAlready: true, priorAllow: { amount } });
  ok(!nextSeen.err && nextSeen.approves === 0 && nextSeen.bets === 1 && nextSeen.pauses === 0, 'next press, the node has caught up: the bet at once', show(nextSeen));
  // a remembered allow the wallet's node says is gone (used or changed elsewhere): allow again, once
  const gone = await run(0, { approvedAlready: false, priorAllow: { amount }, walletSees: false });
  ok(!gone.err && gone.approves === 1 && gone.bets === 1, "a remembered allow the wallet's node doesn't show: the wallet asks to allow again, then the bet", show(gone));
  const smaller = await run(0, { approvedAlready: false, priorAllow: { amount: amount / 2n } });
  ok(!smaller.err && smaller.approves === 1 && smaller.bets === 1, 'a remembered allow smaller than this bet is not used', show(smaller));
}

// A bet that fails on chain: the reason comes from the page's node, or else from the wallet's own node (the page's
// node may not have seen the first bet yet: a second tap must say "already", not "please try again").
{
  const GAME = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), ME = '0x' + '33'.repeat(20), amount = 100n * 10n ** 18n;
  const chain = { lights: { address: GAME }, config: { sqk: TOKEN }, sqk: { balanceOf: async () => amount, allowance: async () => amount } };
  const make = (walletKnows) => ({
    preflight: async () => '0x',
    simulate: walletKnows ? async () => { throw Object.assign(new Error('x'), { revert: { name: 'AlreadyBet', args: [] } }); } : undefined,
    send: async () => '0xb2',
    waitReceipt: async () => ({ ok: false, receipt: { logs: [] } }),
  });
  let e1 = null, e2 = null;
  try { await C.placeBet({ chain, wallet: make(true), account: ME, bulb: 4, amount, waitOpts: { sleep: async () => {} } }); } catch (e) { e1 = e; }
  try { await C.placeBet({ chain, wallet: make(false), account: ME, bulb: 4, amount, waitOpts: { sleep: async () => {} } }); } catch (e) { e2 = e; }
  ok(e1 && C.explain(e1).kind === 'already' && e1.hash === '0xb2', "a failed bet the page's node can't explain: the wallet's node says why (already bet)", e1 && e1.message);
  ok(e2 && e2.code === 'FAILED', 'no node says why: "didn\'t go through"', e2 && e2.message);
}

// the wallet's own simulation: a revert comes back with its reason, a wallet that doesn't answer reads is "unsupported"
{
  const cfg = { chainId: 31337, rpc: ['http://127.0.0.1:1'] };
  const w1 = C.createWallet({ request: async () => { throw Object.assign(new Error('execution reverted'), { code: 3, data: '0xa820742e' }); } }, cfg, {});
  const w2 = C.createWallet({ request: async () => { throw Object.assign(new Error('The method eth_call is not supported'), { code: 4200 }); } }, cfg, {});
  const w3 = C.createWallet({ request: async ({ method }) => (method === 'eth_call' ? '0x' : null) }, cfg, {});
  let a = null, b = null, c = 'none';
  try { await w1.simulate('0x' + '33'.repeat(20), '0x' + '11'.repeat(20), '0x'); } catch (e) { a = e; }
  try { await w2.simulate('0x' + '33'.repeat(20), '0x' + '11'.repeat(20), '0x'); } catch (e) { b = e; }
  try { c = await w3.simulate('0x' + '33'.repeat(20), '0x' + '11'.repeat(20), '0x'); } catch (e) { c = e; }
  ok(a && a.revert && a.revert.name === 'AlreadyBet' && !a.unsupported, "wallet simulation: a revert is read from the wallet's error", a && a.message);
  ok(b && b.unsupported && !b.revert, 'wallet simulation: a wallet that does not answer reads is "unsupported"', b && b.message);
  ok(c === '0x', 'wallet simulation: a call that goes through returns its data');
}

// The wheel blip hold (11-01 real night): one zero between running readings is not a stop; a zero that lasts 8 s is.
{
  const run = (t, speed = 1000) => ({ fresh: true, running: speed > 0, speed, rpm: speed / 15, observedAt: t });
  let h = holdWheel(run(0), run(4000, 0), { at: 4000 });
  ok(h.wheel.running && h.wheel.held && h.zeroSince === 4000 && h.again, 'a zero right after running is held as running, and read again soon');
  h = holdWheel(h.wheel, run(8000), { zeroSince: h.zeroSince, at: 8000 });
  ok(h.wheel.running && !h.wheel.held && h.zeroSince === null, 'running again: the blip is forgotten');
  h = holdWheel(run(0), run(2000, 0), { at: 2000 });
  h = holdWheel(h.wheel, run(6000, 0), { zeroSince: h.zeroSince, at: 6000 });
  ok(h.wheel.running && h.wheel.held, 'still 0 after 4 s: still held');
  h = holdWheel(h.wheel, run(10500, 0), { zeroSince: h.zeroSince, at: 10500 });
  ok(!h.wheel.running && h.zeroSince === null, 'still 0 after 8.5 s: a real stop');
  h = holdWheel(run(0), run(1000, 0), { at: 1000, holdMs: 0 });
  ok(!h.wheel.running, 'hold 0 (fast-forward tests): a zero is a stop at once');
  h = holdWheel(run(0), null, { lastAt: 0, at: 20000 });
  ok(h.kept && h.wheel.running, 'a failed read keeps the last good reading for a while');
  h = holdWheel(run(0), null, { lastAt: 0, at: 40000 });
  ok(h.wheel === null, '... but not after 30 s');
  h = holdWheel(run(0), { fresh: false, running: false, speed: 0, rpm: 0, observedAt: -600000 }, { at: 5000 });
  ok(h.wheel && !h.wheel.fresh, 'an old reading (the sensor stopped reporting) counts at once');
  h = holdWheel({ fresh: true, running: false, speed: 0, rpm: 0, observedAt: 0 }, run(3000, 0), { at: 3000 });
  ok(!h.wheel.running, 'asleep and still 0: nothing to hold');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall chain checks passed');
process.exit(failures ? 1 : 0);
