// Live mode (the default): follows Squeektoshi's ride right now. SqueekCore's records decide the bulbs, breaks and
// the blackout; the status API only says whether the wheel is turning this minute. With a LightsOn address in
// config.json it also shows the bonus pot, everyone's bets, your bet and what you can collect, and lets you bet
// through your wallet. Every read and write goes through chain.js; the rules are live-model.js + engine.js.
import * as C from './chain.js';
import * as M from './live-model.js';
import * as Board from './board.js';

const W = 10n ** 18n;
const EVERY = { core: 20_000, wheel: 15_000, game: 30_000, mine: 30_000 };
// how long the page trusts what it saw go through over a node that doesn't show it yet
const PENDING_MS = 5 * 60_000, ALLOW_MEMO_MS = 10 * 60_000;
const STEP_LABEL = { check: 'Checking…', catchup: 'Confirm in your wallet', catching: 'Catching up…', allow: 'Allow in your wallet', allowing: 'Allowing…', allowed: 'Waiting for the network…', allowWait: 'Waiting for the network…', bet: 'Confirm in your wallet', betting: 'Placing your bet…', count: 'Confirm in your wallet', counting: 'Counting the ride…', collect: 'Confirm in your wallet', collecting: 'Collecting…' };

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// whole SQK with up to 2 decimals, for display
export function sqkText(wei) {
  const neg = wei < 0n, v = neg ? -wei : wei;
  const cents = (v * 100n + W / 2n) / W, whole = cents / 100n, frac = cents % 100n;
  const s = `${whole.toLocaleString('en-US')}${frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : ''}`;
  return neg ? `−${s}` : s;
}
const signedSqk = (wei) => (wei > W / 2n ? `+${sqkText(wei)}` : wei < -W / 2n ? `−${sqkText(-wei)}` : '±0');
const bulbs = (n) => `${n} bulb${n === 1 ? '' : 's'}`;
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
// which ride a bet counts for (live-model.betWindow's night)
const FOR_TEXT = {
  tonight: "for tonight's ride", either: 'for tonight, or his next ride if the lights go out', next: 'for his next ride',
  started: 'for the ride he just started', startedEither: 'for the ride he just started, or his next ride if the lights go out',
};
// the wheel readings kept, to know which rounds not recorded yet already have his turns
const SEEN_MAX = 60;
const KEEP_MS = 30_000; // a failed wheel read keeps the last good reading this long

export function createLive({ $, setText, setStatus, config, base, onRides, provider }) {
  const hasGame = C.isAddress(config.lightsOn);
  const chain = C.createChain(config);
  const HOLD_MS = Number.isFinite(config.wheelHoldMs) ? config.wheelHoldMs : 8000; // a zero reading must last this long to count as a stop
  const sameCore = !!(base && base.core && same(base.core, config.squeekCore));
  const history = sameCore ? { rides: base.rides, settledThrough: base.settledThrough } : { rides: [], settledThrough: Number(config.walkFrom) || 0 };
  const wallet = hasGame && provider ? C.createWallet(provider, config, chain) : null;
  const netName = config.chainName || (Number(config.chainId) === C.SEPOLIA_ID ? 'Sepolia' : 'the game network');
  // the bets are play money: practice SQK in the rehearsal, test SQK on the test network
  const PLAY = `${config.practice ? 'practice' : 'test'} SQK, no real money`;
  const ethFaucet = typeof config.ethFaucet === 'string' && /^https:\/\//.test(config.ethFaucet) ? config.ethFaucet : null;
  // the real game links to the practice page (same game, free practice SQK) for wallets without SQK
  const practiceUrl = !config.practice && typeof config.practiceUrl === 'string' && /^(\?|https:\/\/)/.test(config.practiceUrl) ? config.practiceUrl : null;
  const practiceLink = practiceUrl ? [{ href: practiceUrl, text: 'Try it with practice SQK' }] : [];

  const L = {
    active: false,
    G: Number(config.genesis) || (sameCore ? base.genesis : 1793022600),
    station: 36,
    consts: null,
    S: null, rounds: [], view: null, paused: false,
    wheel: null, offset: 0,
    // seen = the wheel readings since the page opened [{ t (chain time of the reading), work, running }], oldest first;
    // coreCum = SqueekCore's count of his turns at the end of the last recorded round { S, cum }
    seen: [], coreCum: null,
    snap: null, startIdx: 0, bets: new Map(), groups: { byRide: new Map(), current: [] }, chained: { potIn: 0n, results: new Map() },
    account: null, chainOk: null, balance: null, my: new Map(), myLogs: false,
    // what this page saw go through but the page's node may not show yet (public nodes lag behind the wallet):
    // pending = your bet from its receipt { id, account, balanceAfter, at }, allowMemo = a confirmed allow
    // { account, amount, at }, lastPlaced = your last bet { id, account, bulb, stake }
    pending: null, allowMemo: null, lastPlaced: null,
    // eth = the wallet's test ETH for network fees (null = not read yet); boardLit = the lit bulbs the board drew last
    eth: null, boardLit: null,
    // ack = the key of the last-ride result he has moved on from (by picking a bulb or an amount for a new bet): the
    // dashboard then shows the new pick, and a win still to collect is offered in the sentence under the button
    ack: null,
    pick: 6, amountText: '100', busy: null, msg: null,
    lastLit: null, lastOpen: null, lastNights: null, outAt: null,
    err: { core: null, game: null }, due: { core: 0, wheel: 0, game: 0, mine: 0 }, running: { core: false, wheel: false, game: false, mine: false },
    again: { core: false, wheel: false, game: false, mine: false },
    soon: { core: false, wheel: false, game: false, mine: false }, // a read to try again in a few seconds
    lastDash: -1, timer: null,
  };

  const nowSec = () => Date.now() / 1000 + L.offset;
  // the "Get 1,000 practice SQK" button is offered (the rehearsal, a wallet with less than 1,000)
  const practiceTap = () => !!(config.practice && hasGame && L.account && L.chainOk !== false && L.balance != null && L.balance < 1000n * W);
  const amountWei = () => {
    const t = String(L.amountText).trim();
    if (!/^\d{1,5}$/.test(t)) return null;
    const v = BigInt(t);
    return v >= 10n && v <= 10_000n ? v * W : null;
  };
  // the wallet holds less SQK than the bet chosen (known only once its balance has been read)
  const lacksSqk = () => { const a = amountWei(); return !!(a && L.balance != null && L.balance < a); };

  // ---------------------------------------------------------------- reading

  async function refreshCore() {
    const st = await chain.core.state();
    L.paused = st.paused;
    L.coreCum = { S: st.settledThrough, cum: Number(st.cumulativeWork) };
    const from = L.S ?? history.settledThrough;
    if (st.settledThrough > from) L.rounds.push(...await chain.core.activeRounds(from, st.settledThrough));
    if (st.settledThrough > from || L.view == null) {
      // a new record: the wheel is read again first and both show together, so the board's sign gets one piece of news
      // (a bulb lit, and whether he still runs) rather than two a moment apart (a phone's sign lets a long message
      // scroll through before the next one when two come within a few seconds)
      if (L.view != null) await refreshWheel();
      L.S = Math.max(st.settledThrough, history.settledThrough);
      L.view = M.walkNights(history, L.rounds, L.S, L.station);
      onRides(L.view.rides, L.G);
      regroup();
    }
    // A round just ended: its record usually lands 30-60 s later. Until it does, look every few seconds (instead of every
    // 20 s), so a new bulb shows within seconds of the chain recording it (11-01 real night: up to ~30 s late).
    if (L.G && L.S != null) {
      const now = nowSec(), r = M.roundAt(now, L.G), ago = now - M.roundStart(r, L.G);
      if (L.S < r - 1 && ago >= 25 && ago <= 180) L.soon.core = true;
    }
    // The device clock decides the round unless the chain is clearly ahead of it (a device clock running slow, or
    // a local test chain moved forward). A slow device would otherwise offer bulbs that are already too close.
    try {
      const b = await chain.latestBlock();
      const skew = b.timestamp - Date.now() / 1000;
      const was = L.offset;
      L.offset = config.clock === 'chain' ? skew : config.clock === 'device' ? 0 : skew > 30 ? skew : 0;
      // the clock jumped (a test chain moved on): the readings so far may sit in the wrong rounds
      if (Math.abs(L.offset - was) > 60) L.seen = [];
    } catch { /* keep the last offset */ }
  }

  // The wheel, with one-off zero readings held (M.holdWheel; config.wheelHoldMs, default 8 s, 0 = off) and a failed read
  // keeping the last good reading for up to 30 s. A held or kept reading asks for another read in a few seconds.
  async function refreshWheel() {
    let next = null;
    try { next = await chain.wheel(); } catch { next = null; }
    const at = Date.now();
    const h = M.holdWheel(L.wheel, next, { zeroSince: L.zeroSince, lastAt: L.wheelAt, at, holdMs: HOLD_MS, keepMs: KEEP_MS });
    L.zeroSince = h.zeroSince; if (h.again) L.soon.wheel = true;
    if (h.kept) return;
    const w = h.wheel;
    L.wheel = w; L.wheelAt = at;
    if (w && w.fresh) {
      L.seen.push({ t: nowSec() - (w.age || 0), work: w.work, running: w.running });
      if (L.seen.length > SEEN_MAX) L.seen.shift();
    }
  }

  async function refreshGame() {
    if (!hasGame) return;
    if (!L.consts) {
      L.consts = await chain.lights.constants();
      L.G = L.consts.genesis;
      if (L.consts.station !== L.station) { L.station = L.consts.station; if (L.view) L.view = M.walkNights(history, L.rounds, L.S, L.station); }
    }
    const snap = await chain.lights.snapshot();
    if (!L.snap || snap.nextSettle !== L.snap.nextSettle) L.startIdx = snap.nextSettle > 0 ? (await chain.lights.night(snap.nextSettle - 1)).betEnd : 0;
    // your bet from its receipt: once the node shows it, read it from the chain like every other bet (after
    // PENDING_MS it is dropped anyway, so a bet the network lost can't hold the button)
    const p = L.pending;
    if (p && (snap.betCount > p.id || Date.now() - p.at > PENDING_MS)) {
      if (L.bets.get(p.id)?.local) L.bets.delete(p.id);
      if (snap.betCount <= p.id && L.my.get(p.id)?.bet?.local) L.my.delete(p.id);
      L.pending = null;
    }
    // bets never change their owner, round, bulb or stake: read each one once
    for (const id of [...L.bets.keys()]) if (id < L.startIdx) L.bets.delete(id);
    let from = L.startIdx;
    while (L.bets.has(from)) from++;
    from = Math.max(from, snap.betCount - 400);
    if (from < snap.betCount) for (const b of await chain.lights.bets(from, snap.betCount)) L.bets.set(b.id, b);
    L.snap = snap;
    regroup();
  }

  function regroup() {
    if (!L.view || !L.snap) return;
    const list = [...L.bets.values()].filter((b) => b.id >= L.startIdx);
    L.groups = M.groupBets(list, L.view.rides);
    L.chained = M.chainPot(L.view.rides, L.groups.byRide, L.snap.bonusPot);
  }

  async function refreshMine() {
    if (!hasGame || !L.account || !L.chainOk) return;
    const me = L.account;
    const read = await chain.sqk.balanceOf(me);
    if (!same(me, L.account)) return;
    // test ETH for the network fees: a wallet without any can't send anything, so the page says where to get some
    const eth = await chain.ethBalance(me).catch(() => null);
    if (same(me, L.account) && eth != null) {
      const was = L.eth; L.eth = eth;
      if (was === 0n && eth > 0n && L.msg && L.msg.eth && !L.busy) { L.msg = null; L.lastDash = -1; } // he got some
    }
    if (!L.myLogs) {
      const logs = await chain.lights.betIdsOf(me).catch(() => null);
      if (!same(me, L.account)) return; // another account meanwhile: these were the old one's
      if (logs) for (const l of logs) if (!L.my.has(l.betId)) L.my.set(l.betId, { bet: { id: l.betId, owner: me, bulb: l.bulb, stake: l.stake, betRound: l.betRound } });
      // a failed look-up is tried again (an earlier win must not stay hidden until a reload): the first times a few
      // seconds later, then with the other reads; after 10 tries the page makes do with the bets it reads anyway
      L.logTries = (L.logTries || 0) + 1;
      if (logs || !Number(config.deployBlock) || L.logTries >= 10) L.myLogs = true;
      else if (L.logTries < 4) L.soon.mine = true;
    }
    for (const b of L.bets.values()) if (same(b.owner, me) && (!L.my.has(b.id) || (L.my.get(b.id).bet?.local && !b.local))) L.my.set(b.id, { bet: b });
    const last = await chain.lights.lastBet(me);
    if (last > 0 && !L.my.has(last - 1)) { const [b] = await chain.lights.betsById([last - 1]); if (same(b.owner, me)) L.my.set(b.id, { bet: b }); }
    // a bet only known from its receipt can't be read yet (the node doesn't have it)
    const open = [...L.my.entries()].filter(([, x]) => !x.final && !x.bet?.local).map(([id]) => id).sort((a, b) => a - b).slice(-40);
    if (open.length) {
      const [bets, outs] = [await chain.lights.betsById(open), await chain.lights.outcomes(open)];
      bets.forEach((b, i) => {
        const x = L.my.get(b.id);
        x.bet = b; x.outcome = outs[i];
        x.final = b.status === C.STATUS.CLAIMED || b.status === C.STATUS.REFUNDED;
        if (x.final) delete x.paid;
      });
    }
    // what the node doesn't show yet: your bet left your wallet, your collect arrived in it
    let bal = read;
    for (const x of L.my.values()) if (x.paid) bal += x.paid.amount;
    const p = L.pending;
    if (p && same(p.account, me) && p.balanceAfter != null && bal > p.balanceAfter) bal = p.balanceAfter;
    L.balance = bal;
  }

  async function checkChain() {
    if (!wallet || !L.account) { L.chainOk = null; return; }
    try { L.chainOk = (await wallet.chainId()) === Number(config.chainId); } catch { L.chainOk = false; }
  }

  // One scheduler for all reads: each kind runs when due, never twice at once, and not while the tab is hidden.
  function schedule(kind) { L.due[kind] = Date.now(); if (L.running[kind]) L.again[kind] = true; }
  async function run(kind, fn) {
    if (L.running[kind] || Date.now() < L.due[kind]) return;
    L.running[kind] = true;
    try {
      await fn();
      if (kind in L.err) L.err[kind] = null;
    } catch (e) {
      if (kind in L.err) L.err[kind] = e;
    } finally {
      L.running[kind] = false;
      L.due[kind] = L.again[kind] ? Date.now() : Date.now() + (L.soon[kind] ? 4000 : EVERY[kind]);
      L.again[kind] = false; L.soon[kind] = false;
    }
  }
  async function loop() {
    if (typeof document !== 'undefined' && document.hidden) return;
    await run('core', refreshCore);
    await Promise.all([run('wheel', refreshWheel), L.S != null ? run('game', refreshGame) : null]);
    if (L.snap) await run('mine', refreshMine);
  }
  const refreshAll = () => { for (const k of Object.keys(L.due)) schedule(k); loop(); };

  // ---------------------------------------------------------------- what to show

  // The bulb shown: your pick, raised to the lowest safe bulb while that is higher (it can drop back a minute later,
  // when the round's record arrives, and your pick shows again).
  const shown = (d) => Math.min(24, Math.max(d.win.floor, L.pick));

  function derive() {
    if (L.S == null || !L.view) return { loading: true };
    // with a game, its genesis time decides the rounds: wait for it (unless it can't be read)
    if (hasGame && !L.consts && !L.err.game) return { loading: true };
    const now = nowSec(), G = L.G, S = L.S;
    const cur = Math.max(M.roundAt(now, G), S + 1);
    const open = L.view.open, lit = M.litOf(open);
    const wheel = L.wheel && L.wheel.fresh ? L.wheel : null;
    const running = wheel ? wheel.running : null;
    const N = Math.max(M.betRoundSent(now, G), cur);
    // the rounds not recorded yet that already have his turns (the wheel turning in them, or its counter going up)
    const known = M.knownActive(L.seen, G, S, L.coreCum);
    const win = M.betWindow({ S, cur, N, open, wheel, active: known, station: L.station });
    // no ride recorded yet, but he got on the wheel (he runs now, or ran since the last record)
    const started = !open && (win.night === 'started' || win.night === 'startedEither');
    const late = cur - S - 1; // rounds that ended but aren't recorded yet
    const rides = L.view.rides, last = rides[rides.length - 1] || null;
    const lastEnd = last ? (last.end === 'blackout' ? last.C + 1 : last.start + L.station - 1) : null;
    const sinceOut = !open && last ? S - lastEnd : null;
    const voided = !!(L.snap && L.snap.voided);
    // after the game ended the bonus pot is paid back to the bets it came from: don't show it as a pot any more
    const potIn = hasGame && L.snap && !voided ? L.chained.potIn : 0n;
    const current = L.groups.current;
    const mine = L.account ? current.find((b) => same(b.owner, L.account)) : null;
    // what you can collect: bets the contract has settled, and bets in rides that are over but that the contract
    // hasn't counted yet (nobody has played since): collecting counts the ride first, and the page's numbers are the
    // contract's to the wei (test/anvil.test.mjs)
    const collect = [];
    for (const x of L.my.values()) {
      if (x.final || x.paid || !x.bet) continue; // x.paid: collected, the node doesn't show it yet
      if (x.outcome && x.outcome.ready) { if (x.outcome.payout > 0n) collect.push({ id: x.bet.id, amount: x.outcome.payout, bet: x.bet, refund: x.outcome.cls === C.CLS.REFUND }); continue; }
      const est = L.chained.results.get(x.bet.id);
      if (est && est.payout > 0n && !current.some((b) => b.id === x.bet.id)) collect.push({ id: x.bet.id, amount: est.payout, bet: x.bet, refund: est.cls === 'refund' });
    }
    const collectIds = collect.map((x) => x.id), collectSum = collect.reduce((a, x) => a + x.amount, 0n);
    const result = voided || !L.account ? null : lastResult(collect, collectSum, current, last);
    return { now, cur, S, N, open, lit, wheel, running, win, started, late, last, sinceOut, potIn, current, mine: voided ? null : mine, collectIds, collectSum, result, voided };
  }

  // How your last bet went, for the dashboard (until you start picking a new bet) and the sentence under the button:
  // what is waiting to be collected (one bet, or the total of several), else your latest bet if it stayed dark on
  // his last ride. { key, id, bet, amount, stake, many, refund, lost, rolled, ride, isLast }
  function lastResult(collect, collectSum, current, last) {
    const rideFor = (b) => { const n = L.chained.results.get(b.id)?.ride; return (n != null && L.view.rides.find((r) => r.n === n)) || rideOf(b); };
    const at = (r, x) => { r.ride = rideFor(x.bet); r.isLast = !!(r.ride && last && r.ride.n === last.n); return r; };
    if (collect.length) {
      const top = collect.reduce((a, x) => (x.id > a.id ? x : a));
      const stake = collect.reduce((a, x) => a + (x.bet.stake ?? 0n), 0n);
      return at({ key: `${L.account}|${collect.map((x) => x.id).sort((a, b) => a - b).join(',')}`, id: top.id, bet: top.bet, bets: collect.map((x) => x.bet),
        amount: collectSum, stake, many: collect.length, refund: collect.length === 1 && top.refund, lost: false, rolled: false }, top);
    }
    // your latest bet that is over (not one for the ride now or the next): a loss is shown only for his last ride
    let latest = null;
    for (const x of L.my.values()) if (x.bet && !current.some((b) => b.id === x.bet.id) && (!latest || x.bet.id > latest.bet.id)) latest = x;
    if (!latest || latest.final || latest.paid || !last) return null;
    const o = latest.outcome, est = L.chained.results.get(latest.bet.id);
    const lost = o && o.ready ? o.payout === 0n : est ? est.cls === 'lose' : false;
    if (!lost) return null;
    const rolled = o && o.ready ? o.result === C.RESULT.ROLLED : est.result === 'rolled';
    const r = at({ key: `${L.account}|${latest.bet.id}`, id: latest.bet.id, bet: latest.bet, bets: [latest.bet], amount: 0n, stake: latest.bet.stake, many: 1, refund: false, lost: true, rolled }, latest);
    return r.isLast ? r : null;
  }

  // tonight's estimate for a bet (placed or not) if the lights go out right after bulb `upTo`
  function estimateFor(d, bet, upTo, extra) {
    const s = M.estimate({ open: d.open, S: d.S, cur: d.cur, running: !!d.running, bets: d.current, potIn: d.potIn, lit: upTo, extra });
    const list = extra ? [...d.current, extra] : d.current;
    const i = list.indexOf(bet);
    return i < 0 ? null : { payout: s.payouts[i], cls: s.classes[i] };
  }

  // what limits a bet right now: the lowest bulb still open, none left, or Squeekchain's records late / paused
  const limits = (d) => ({ floor: d.win.floor, noBulb: d.win.floor > 24, recordsLate: d.late > 4 || L.paused });
  // your last ride's result fills the dashboard until you pick a bulb or an amount for a new bet (or bet)
  const resultShown = (d) => !!d.result && !d.mine && !d.voided && L.ack !== d.result.key;
  // what the main button does once a wallet is connected on the right network: collect what is waiting while its
  // result is shown (or while no bet can be placed), else the bet
  function mainAction(d) {
    const { noBulb, recordsLate } = limits(d);
    if (d.collectIds.length && (d.voided || d.mine || resultShown(d) || noBulb || recordsLate)) return 'collect';
    if (d.voided) return 'ended';
    if (d.mine) return 'placed';
    if (noBulb || recordsLate) return 'none';
    return amountWei() ? 'bet' : 'amount';
  }
  // he moves on from the last ride's result: the dashboard shows the bet he is choosing
  const moveOn = (d) => { if (d.result && L.ack !== d.result.key) { L.ack = d.result.key; L.lastDash = -1; } };

  function updateDash(d) {
    const btn = $('act');
    if (d.loading) {
      setText('youState', '–'); setText('money', '–'); setText('moneySub', ' ');
      setStatus(L.err.core ? 'Can\'t reach Squeekchain right now. Trying again…' : 'Reading Squeektoshi\'s rounds from Squeekchain…');
      btn.disabled = true; setText('act', 'Loading…');
      return;
    }
    const odds = M.odds(L.view.rides), oddsFor = (k) => odds[k - 1];
    const { floor, noBulb, recordsLate } = limits(d);
    const pick = shown(d), showing = resultShown(d);
    $('bPick').textContent = pick;
    const o = oddsFor(pick);
    // the line above the button: the bulb you're choosing, or the one you bet on (blank once it is lit). Before he
    // starts: how long he must run to light it; while he runs: how much longer from now.
    const oddsK = d.voided ? 0 : d.mine ? (d.open && d.mine.bulb <= d.lit ? 0 : d.mine.bulb) : pick;
    const ok = oddsK ? oddsFor(oddsK) : null, toGo = oddsK && d.open ? oddsK - d.lit : 0;
    setText('pickOdds', !hasGame || !oddsK ? '' : `Bulb ${oddsK} · ${d.open && toGo > 0 ? `about ${M.runTime(toGo)} more` : M.runTime(oddsK)} · ${ok.total ? `lit on ${ok.pct}% of his nights` : 'no nights to count yet'}`);
    $('pickOdds').title = ok ? `${ok.lit} of his ${ok.total} nights` : '';
    // the picker stays while your last ride's result is shown: a win waiting to be collected never blocks a new bet
    $('pickRow').hidden = !!d.mine || d.voided;

    // your bulb and the one number (in SQK: the unit in small print after it)
    const money = $('money');
    const showMoney = (wei) => {
      const v = signedSqk(wei);
      if (money.textContent !== `${v} SQK` || money.childElementCount !== 1) {
        money.textContent = v;
        const unit = document.createElement('small'); unit.textContent = ' SQK'; money.append(unit);
      }
      tone(wei > W / 2n ? 'win' : wei < -W / 2n ? 'lose' : '');
    };
    // (only the win / lose classes: the 'tick' that settles a changed number is the page's, and stays)
    const tone = (c) => { for (const k of ['win', 'lose']) if (money.classList.contains(k) !== (c === k)) money.classList.toggle(k, c === k); };
    const plain = (text) => { setText('money', text); tone(''); };
    // the best case for a bet on bulb k (estimate(n) = what it gets if the lights go out right after bulb n): it
    // holds while he lights k up to `hi` bulbs; a higher bet that lights too takes a slice
    const bestLabel = (k, estimate, best) => {
      let hi = k;
      while (hi < 24) { const e = estimate(hi + 1); if (!e || e.payout !== best) break; hi++; }
      return M.bestCase(k, hi);
    };
    if (d.voided) {
      // the game has ended: no more bets, only what comes back
      setText('pickOdds', '');
      setText('youState', 'Game ended'); setText('youSub', 'no more bets');
      setText('moneyLabel', 'You can collect');
      plain(d.collectIds.length ? `${sqkText(d.collectSum)} SQK` : '–');
      setText('moneySub', d.collectIds.length ? 'your bets come back' : ' ');
    } else if (d.mine) {
      const b = d.mine, before = d.open ? b.bulb <= d.lit : false;
      setText('youState', before ? `Bulb ${b.bulb} lit` : `Bulb ${b.bulb}`);
      const which = { started: 'this ride · ', startedEither: 'this ride or the next · ', next: 'next ride · ' }[d.win.nightAt(b.betRound)] || '';
      setText('youSub', `${d.open && !before ? `${b.bulb - d.lit} to go · ` : !d.open ? which : ''}bet ${sqkText(b.stake)}`);
      if (!before) {
        const e = estimateFor(d, b, b.bulb);
        setText('moneyLabel', e ? bestLabel(b.bulb, (n) => estimateFor(d, b, n), e.payout) : M.bestCase(b.bulb, b.bulb));
        if (e) showMoney(e.payout - b.stake); else plain('–');
        setText('moneySub', 'with the bets so far');
      } else {
        const e = estimateFor(d, b, d.lit);
        setText('moneyLabel', 'If the lights go out now');
        if (e) showMoney(e.payout - b.stake); else plain('–');
        setText('moneySub', e ? `you would get back ${sqkText(e.payout)} SQK` : ' ');
      }
    } else if (showing) {
      // your last bet is over: how it went (a lit bulb can get back less than its bet; several wins: their total), until
      // you collect it, or (a loss) until you pick a bulb or an amount for a new bet
      const r = d.result, b = r.bet, gain = r.amount - r.stake;
      const at = r.ride ? new Date(M.roundStart(r.ride.start, L.G) * 1000) : null;
      const when = r.isLast ? 'last ride' : at ? `ride of ${day(at)}` : 'an earlier ride';
      if (r.many > 1) {
        const nums = [...new Set(r.bets.map((x) => x.bulb))].sort((a, c) => a - c);
        // (short enough for one line on a phone, like "Bulb 20 lit")
        setText('youState', nums.length === 1 ? `Bulb ${nums[0]} lit` : nums.length === 2 ? `Bulbs ${nums.join(', ')}` : `${nums.length} bulbs`);
        setText('youSub', `${nums.length === 1 ? '' : 'lit · '}${r.many} bets, ${sqkText(r.stake)} SQK in all`);
        setText('moneyLabel', `${r.many} bets to collect`);
      } else {
        setText('youState', r.lost || r.refund ? `Bulb ${b.bulb}` : `Bulb ${b.bulb} lit`);
        setText('youSub', r.refund ? 'lit too soon after your bet' : r.lost ? `stayed dark · bet ${sqkText(b.stake)}` : `${when} · bet ${sqkText(b.stake)}`);
        setText('moneyLabel', r.isLast ? 'Last ride' : at ? `Ride of ${day(at)}` : 'Your last bet');
      }
      showMoney(gain);
      setText('moneySub', r.refund ? `you get your ${sqkText(b.stake)} SQK back` : r.rolled ? 'it rolls into the bonus pot' : r.lost ? 'you lost your bet' : `you get back ${sqkText(r.amount)} SQK`);
    } else {
      setText('youState', noBulb ? 'No bulb left' : `Bulb ${pick}?`);
      setText('youSub', hasGame ? (noBulb ? 'bets open again for his next ride' : FOR_TEXT[d.win.night]) : 'Tap a bulb on the board, or use − and +');
      if (hasGame) {
        const amt = amountWei() || 100n * W;
        const extra = { stake: amt, bulb: pick, betRound: d.N, owner: L.account || '0x0', id: -1 };
        const e = noBulb ? null : estimateFor(d, extra, pick, extra);
        setText('moneyLabel', noBulb ? 'No bet right now' : e ? bestLabel(pick, (n) => estimateFor(d, extra, n, extra), e.payout) : M.bestCase(pick, pick));
        if (e) showMoney(e.payout - amt); else plain('–');
        // right above the bet buttons: what the bets are
        setText('moneySub', PLAY);
      } else {
        setText('moneyLabel', `How often bulb ${pick} lit`);
        plain(o.total ? `${o.pct}%` : '–');
        setText('moneySub', o.total ? `${o.lit} of his ${o.total} nights` : 'no nights to count yet');
      }
    }

    // the one button
    let label = 'Bet', off = false;
    if (!hasGame) { /* no button: betting opens soon */ }
    else if (L.busy) { label = L.busy; off = true; }
    else if (!L.snap) { label = 'Loading…'; off = !L.err.game; if (L.err.game) label = 'Try again'; }
    // no wallet in this browser (often a phone that opened the page from X): the button says what it does
    else if (!wallet) label = onPhone() ? 'How to bet on a phone' : 'Connect wallet';
    else if (!L.account) label = 'Connect wallet';
    else if (!L.chainOk) label = `Switch to ${netName}`;
    else {
      const a = mainAction(d);
      if (a === 'collect') label = `Collect ${sqkText(d.collectSum)} SQK`;
      else if (a === 'ended') { label = 'Game ended'; off = true; }
      else if (a === 'placed') { label = 'Bet placed'; off = true; }
      else if (a === 'none') { label = 'No bets right now'; off = true; }
      else if (a === 'amount') { label = 'Pick a bet'; off = true; }
      // a new player says first what is missing (the sentence under the button says where to get it); on the
      // rehearsal the button gets the practice SQK itself
      else if (L.eth === 0n) label = 'Get test ETH first';
      else if (lacksSqk()) label = config.practice ? 'Get practice SQK first' : 'Not enough SQK';
      else label = `Bet ${sqkText(amountWei())} SQK on bulb ${pick}`;
    }
    if (btn.disabled !== off) btn.disabled = off;
    setText('act', label);

    // wallet line
    const wl = $('walletLine');
    wl.hidden = !(hasGame && L.account);
    if (!wl.hidden) setText('walletLine', L.chainOk === false ? `${short(L.account)} · your wallet is on another network` : `${short(L.account)} · you have ${L.balance == null ? '…' : sqkText(L.balance)} ${config.practice ? 'practice ' : ''}SQK`);
    // share your bet, or your win, on X (a ready-made post with the page's link)
    shareLink(d);
    // the rehearsal's practice token has an open tap: offer it while the wallet holds less than 1,000
    const fb = $('faucet'), tap = !wl.hidden && practiceTap();
    if (fb.hidden === tap) fb.hidden = !tap;
    if (fb.disabled !== !!L.busy) fb.disabled = !!L.busy;
    // the sentence under the dashboard
    if (L.msg && Date.now() < L.msg.until) return showMessage(L.msg);
    L.msg = null;
    // a wallet without test ETH can't send anything (not even for practice SQK): first, where to get some
    if (hasGame && L.account && L.chainOk && L.eth === 0n && !d.mine && !d.voided) return showMessage(ethMessage());
    // the real game and a wallet with no SQK at all: where SQK comes from, and the practice page meanwhile
    if (practiceUrl && hasGame && L.account && L.chainOk && L.balance === 0n && !d.mine && !d.voided && !d.collectIds.length) return showMessage(noSqkMessage());
    const line = statusLine(d, { floor, noBulb, recordsLate, pick });
    if (typeof line === 'string') setStatus(line); else showMessage(line, false);
  }

  // The "Share on X" link: your bet while it waits or runs, or your win until it is collected. Nothing else.
  const pageUrl = () => (typeof location !== 'undefined' && location.origin ? `${location.origin}${location.pathname}${location.search}` : 'https://rooaraak.github.io/keep-the-lights-on/');
  function shareLink(d) {
    const el = $('share'), unit = config.practice ? 'practice SQK' : 'SQK';
    let text = null, label = null;
    if (hasGame && L.account && d.mine && !d.voided) {
      const b = d.mine, when = d.open ? 'tonight' : 'on his next ride';
      text = `I bet ${sqkText(b.stake)} ${unit} that Squeektoshi the hamster lights bulb ${b.bulb} ${when} 🐹💡 Keep the lights on:`;
      label = 'Share my bet on X';
    } else if (hasGame && L.account && resultShown(d) && d.result && !d.result.lost && !d.result.refund && d.result.amount > d.result.stake) {
      const r = d.result;
      text = `Squeektoshi the hamster lit bulb ${r.bet.bulb} and my ${sqkText(r.stake)} ${unit} came back as ${sqkText(r.amount)} 🐹💡 Keep the lights on:`;
      label = 'Share my win on X';
    }
    if (!text) { if (!el.hidden) el.hidden = true; return; }
    const href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl())}`;
    if (el.href !== href) el.href = href;
    setText('share', label);
    if (el.hidden) el.hidden = false;
  }

  // No test ETH for the network fees: what it is for, that it's free, and a link to a faucet if the settings name one.
  function ethMessage() {
    const sep = netName === 'Sepolia';
    const text = `Your wallet needs a little test ETH${sep ? ' on Sepolia' : ''} to pay the network fee. Test ETH is free from a ${sep ? 'Sepolia ' : ''}faucet.${practiceTap() ? ' Then tap Get 1,000 practice SQK below.' : ''}`;
    return { text, links: ethFaucet ? [{ href: ethFaucet, text: 'Get free test ETH', blank: true }] : [] };
  }
  function noSqkMessage() {
    return { text: 'Your wallet has no SQK yet. SQK comes from staking Squeeks on Squeekchain. Meanwhile you can play the same game with free practice SQK.', links: practiceLink };
  }
  // (eth: it goes away as soon as the wallet has some)
  const sayEth = () => { const m = ethMessage(); say(m.text, null, 60_000, { links: m.links, eth: true }); };
  // test ETH right now: the wallet's own node first (it is often ahead of the page's), else the page's node
  async function ethNow() {
    let v = null;
    if (L.chainOk) { try { v = await wallet.ethBalance(L.account); } catch { /* the wallet doesn't say */ } }
    if (v == null || v === 0n) { try { const p = await chain.ethBalance(L.account); v = v == null || p > v ? p : v; } catch { /* keep what we have */ } }
    if (v != null) L.eth = v;
    return v;
  }

  function statusLine(d, { floor, noBulb, recordsLate, pick }) {
    if (L.err.core) return 'Can\'t reach Squeekchain right now. Trying again…';
    if (L.paused) return 'Squeekchain has paused its records. The lights wait until it starts again.';
    if (recordsLate) return `Squeekchain's records are running late (the last one is ${d.late} rounds old), so the page waits before offering bulbs.`;
    if (d.voided) return d.collectIds.length ? 'This game has ended. Collect your refunds.' : 'This game has ended.';
    const out = d.sinceOut != null && d.sinceOut <= 6 && d.last ? `Blackout after ${bulbs(d.last.lit)}. ` : '';
    // winnings waiting while the button is about your bet on this ride, or the bet you are choosing
    const r = d.result, waiting = d.collectIds.length ? `${sqkText(d.collectSum)} SQK from ${r && r.many > 1 ? 'earlier rides' : r && r.isLast ? 'your last ride' : 'an earlier ride'} is waiting for you.` : '';
    if (d.mine) {
      const also = waiting ? ` ${waiting} Press Collect to take it.` : '';
      if (!d.open) {
        const n = d.win.nightAt(d.mine.betRound);
        if (n === 'started') return `${out}Your bet is on the ride he just started.${also}`;
        if (n === 'startedEither') return `${out}Your bet is on the ride he just started, or on his next ride if the lights go out first.${also}`;
        return `${out}Your bet waits for his next ride. He is asleep now.${also}`;
      }
      const left = d.mine.bulb - d.lit;
      if (left <= 0) return `Your bulb is lit. Each new bulb shifts more of the pot to higher bulbs.${also}`;
      return (left === 1 ? 'One more bulb! He needs to keep running about 10 more minutes.' : `He needs to light ${left} more bulbs, about ${left * 10} minutes of running.`) + also;
    }
    // your last ride's result, while the dashboard shows it; then how to bet again (the picker stays)
    if (resultShown(d)) {
      const b = r.bet, ago = out ? '' : r.isLast ? ' on his last ride' : r.ride ? ` on the ride of ${day(new Date(M.roundStart(r.ride.start, L.G) * 1000))}` : ' on an earlier ride';
      let said;
      if (r.many > 1) said = `${out}You have ${r.many} bets to collect, ${sqkText(r.amount)} SQK in all. Press Collect to take it.`;
      else if (r.lost) said = `${out}Your bulb ${b.bulb} stayed dark${ago}${r.rolled ? ': nobody won, so your bet rolls into the bonus pot' : `: you lost your ${sqkText(b.stake)} SQK`}.`;
      else if (r.refund) said = `${out}Your bulb lit too soon after your bet, so you get it back. Press Collect to count the ride and take your ${sqkText(r.amount)} SQK.`;
      // a lit bulb can get back less than its bet (the lit bulbs share the pot, higher bulbs and early bets get more)
      else if (r.amount < b.stake) said = `${out}Your bulb ${b.bulb} lit${ago}, but higher bulbs and earlier bets got bigger slices of the pot, so you get back ${sqkText(r.amount)} of your ${sqkText(b.stake)} SQK. Press Collect to count the ride and take it.`;
      else said = `${out}Your bulb ${b.bulb} lit${ago}. Press Collect to count the ride and take your ${sqkText(r.amount)} SQK.`;
      if (noBulb) return said;
      return `${said} ${d.open ? `To bet on this ride, pick a bulb (${floor} or higher).` : d.started ? `To bet on the ride he just started, pick a bulb (${floor} or higher).` : 'To bet on his next ride, pick a bulb.'}`;
    }
    const line = betLine(d, { floor, noBulb, pick, out });
    // the button is for the bet: the winnings get their own link
    if (waiting && L.chainOk && mainAction(d) !== 'collect') {
      return { text: `${line} ${waiting}`, links: [{ href: '#', text: `Collect ${sqkText(d.collectSum)} SQK`, onClick: (ev) => { ev.preventDefault(); act('collect'); } }] };
    }
    return line;
  }

  // the sentence while you choose a bet (or, with no game yet, what he is doing)
  function betLine(d, { floor, noBulb, pick, out }) {
    const badAmount = hasGame && !d.mine && !d.voided && !amountWei();
    if (!hasGame) {
      if (d.open) return d.running === false ? 'He stopped for a moment. The bulbs flicker; 20 quiet minutes are a blackout.' : `He is running: bulb ${d.lit + 1} lights next.`;
      return d.running ? `${out}He just got on the wheel. The lights come on in about 10 minutes.` : `${out}He is asleep. The lights come on when he starts running.`;
    }
    if (noBulb && d.win.closing) return `He has run almost ${Math.round(L.station / 6)} hours, the longest a ride can last, so no new bulb could still win on this ride. Bets open again for his next ride.`;
    if (noBulb) return 'He has lit so many bulbs that none is left to bet on for this ride. Bets open again for his next ride.';
    if (badAmount) return 'A bet must be a whole number from 10 to 10,000 SQK.';
    if (!d.open) {
      if (d.started && d.running) return `${out}He just got on the wheel. You can bet on bulb ${floor} or higher.`;
      // he ran since the last record, then stopped: the ride he just started (a bet now stays on it unless the
      // lights go out before its round)
      if (d.started) {
        return d.win.night === 'started'
          ? `${out}He got on the wheel and stopped for a moment. A bet now counts for the ride he just started: if he stays asleep, the lights go out and your bulb stays dark. Bulb ${floor} or higher.`
          : `${out}He got on the wheel and stopped for a moment. A bet now counts for the ride he just started, or for his next ride if the lights go out. Bulb ${floor} or higher.`;
      }
      return `${out}He is asleep. A bet now counts for his next ride.` + (d.win.bulb1Risk && pick === 1 ? ' Bulb 1 only counts if he starts at least 10 minutes after your bet; if he starts sooner, you get the bet back.' : '');
    }
    if (d.running === false) {
      // he already ran in this round: a bet now stays on this ride, even if he sleeps on (it only moves to his next
      // ride when it is sent in a round he hasn't run in yet)
      if (d.win.night === 'tonight') return `He stopped for a moment. A bet now counts for this ride: if he stays asleep, the lights go out and your bulb stays dark. Bulb ${floor} or higher.`;
      return `He stopped for a moment. A bet now counts for this ride, or for his next ride if the lights go out. Bulb ${floor} or higher.`;
    }
    // a quiet round recorded and the next one not yet: his break may have put the lights out already
    if (d.running && d.win.mayBeOut) return `He is back on the wheel. A bet now counts for this ride, or for his next ride if the lights went out in his break. Bulb ${floor} or higher.`;
    return `He is running. You can bet on bulb ${floor} or higher.`;
  }

  // (scroll: an answer to a tap is scrolled into view; the line that follows the ride is not)
  function showMessage(m, scroll = true) {
    const el = $('status');
    const links = [...(m.links || [])];
    if (m.hash && config.explorer) links.push({ href: `${config.explorer.replace(/\/$/, '')}/tx/${m.hash}`, text: 'See it on Etherscan', blank: true });
    const key = `${m.text}|${links.map((l) => l.href).join(' ')}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.textContent = m.text;
    links.forEach((l, i) => {
      const a = document.createElement('a');
      a.href = l.href; a.textContent = l.text;
      if (l.blank) { a.target = '_blank'; a.rel = 'noopener'; }
      if (l.onClick) a.addEventListener('click', l.onClick);
      el.append(i ? ' · ' : ' ', a);
    });
    if (scroll) showAnswer(el);
  }
  // An answer to a tap sits under the button, which on a phone can be below the screen: while the button is on
  // screen, scroll just enough to show the answer. If he has scrolled away from the button, the page stays put.
  function showAnswer(el) {
    if (typeof el.scrollIntoView !== 'function' || typeof window === 'undefined' || !window.innerHeight) return;
    const vh = window.innerHeight, b = $('act').getBoundingClientRect(), r = el.getBoundingClientRect();
    if (b.bottom <= 0 || b.top >= vh || (r.top >= 0 && r.bottom <= vh)) return;
    el.scrollIntoView({ block: 'nearest', behavior: Board.reducedMotion() ? 'auto' : 'smooth' });
  }
  // extra: { links: [{ href, text, blank, onClick }], sticky } (sticky: news from the ride doesn't replace it)
  const say = (text, hash = null, ms = 20_000, extra = {}) => { L.msg = { text, hash, until: Date.now() + ms, ...extra }; $('status').dataset.key = ''; L.lastDash = -1; };
  const onPhone = () => typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches));

  // No wallet in this browser (often a phone opening the page from X): say what to do, with a way to get there.
  function noWallet() {
    const net = netName === 'Sepolia' ? 'the Sepolia test network' : netName;
    const phone = onPhone();
    const page = typeof location !== 'undefined' ? location.href.replace(/#.*$/, '') : '';
    if (!phone || !page) return say(`No wallet found in this browser. To bet, add a wallet such as MetaMask or Rabby to your browser, set it to ${net}, and open this page again.`, null, 120_000, { sticky: true });
    const copy = (ev) => {
      const a = ev.currentTarget;
      if (!navigator.clipboard || !navigator.clipboard.writeText) return; // the link is this page: a long press copies it
      ev.preventDefault();
      navigator.clipboard.writeText(page).then(() => { a.textContent = 'Link copied'; }, () => { a.textContent = page; });
    };
    say(`No wallet in this browser. To bet, open this page in a wallet app's own browser (MetaMask, Rabby, Coinbase Wallet…), set to ${net}.`, null, 300_000, {
      sticky: true,
      links: [
        { href: `https://metamask.app.link/dapp/${page.replace(/^https?:\/\//, '')}`, text: 'Open in MetaMask' },
        { href: page, text: 'Copy the link', onClick: copy },
      ],
    });
  }

  function renderLists(d) {
    // tonight's bets
    const box = $('riders');
    const key = JSON.stringify([d.lit, !!d.open, d.started, L.account, d.voided, d.current.map((b) => b.id)]);
    setText('playersTitle', d.voided ? 'Bets waiting when the game ended' : d.open ? "Tonight's bets" : d.started ? "This ride's bets" : 'Bets for his next ride');
    if (box.dataset.key !== key) {
      box.dataset.key = key; box.textContent = '';
      const list = d.current.slice().sort((a, b) => (same(b.owner, L.account) ? 1 : 0) - (same(a.owner, L.account) ? 1 : 0) || a.bulb - b.bulb || a.id - b.id);
      if (!list.length) {
        const p = document.createElement('p'); p.className = 'empty'; p.textContent = d.open || d.started ? 'No bets on this ride yet.' : 'No bets for his next ride yet.'; box.append(p);
      }
      for (const b of list) {
        const lit = d.open && b.bulb <= d.lit;
        box.append(row({ me: same(b.owner, L.account), name: same(b.owner, L.account) ? 'You' : short(b.owner), sub: lit ? `bulb ${b.bulb} lit` : d.open ? `bulb ${b.bulb} · ${b.bulb - d.lit} to go` : `bulb ${b.bulb}`, amt: sqkText(b.stake), st: lit ? 'lit' : 'riding' }));
      }
    }
    // your bets
    const mp = $('minePanel'), mineBox = $('mine');
    const mine = [...L.my.values()].filter((x) => x.bet).sort((a, b) => b.bet.id - a.bet.id).slice(0, 8);
    mp.hidden = !(hasGame && L.account && mine.length);
    if (mp.hidden) return;
    const mkey = JSON.stringify(mine.map((x) => [x.bet.id, x.bet.status, x.outcome && String(x.outcome.payout), x.outcome && x.outcome.ready, x.paid && String(x.paid.amount), d.lit, !!d.open, d.started && d.win.nightAt(x.bet.betRound), L.chained.results.get(x.bet.id)?.payout?.toString()]));
    if (mineBox.dataset.key === mkey) return;
    mineBox.dataset.key = mkey; mineBox.textContent = '';
    for (const x of mine) mineBox.append(row({ me: false, ...describeMine(x, d) }));
  }

  // One of your bets in plain words.
  function describeMine(x, d) {
    const b = x.bet, o = x.outcome, name = `Bulb ${b.bulb} · ${sqkText(b.stake)} SQK`;
    const ride = L.view.rides.find((r) => r.n === L.chained.results.get(b.id)?.ride) || rideOf(b);
    const when = ride ? ` · ride of ${day(new Date(M.roundStart(ride.start, L.G) * 1000))} ${hhmm(new Date(M.roundStart(ride.start, L.G) * 1000))}` : '';
    if (x.paid) {
      // collected from this page; its node doesn't show it yet
      const got = x.paid.amount;
      if (x.paid.refunded) return { name, sub: `the game ended · given back ${sqkText(got)} SQK${when}`, amt: '±0', st: 'won' };
      return { name, sub: `collected ${sqkText(got)} SQK${when}`, amt: got ? signedSqk(got - b.stake) : `−${sqkText(b.stake)}`, st: got >= b.stake ? 'won' : got ? 'short' : 'caught' };
    }
    if (d.voided && o && o.ready && o.payout > 0n && (b.status === C.STATUS.WAITING || b.status === C.STATUS.REFUNDED || (o.cls === C.CLS.LOSE && o.result === C.RESULT.ROLLED))) {
      // the game ended: bets that never got a ride, and stakes riding in a bonus pot, come back
      if (b.status === C.STATUS.REFUNDED || b.status === C.STATUS.CLAIMED) return { name, sub: `the game ended · given back ${sqkText(o.payout)} SQK${when}`, amt: '±0', st: 'won' };
      return { name, sub: `the game ended · ${sqkText(o.payout)} SQK to collect${when}`, amt: '±0', st: 'won' };
    }
    if (!d.voided && d.current.some((c) => c.id === b.id)) {
      const n = d.open ? 'tonight' : d.win.nightAt(b.betRound);
      const sub = d.open ? `on tonight's ride${b.bulb <= d.lit ? ' · lit' : ` · ${b.bulb - d.lit} to go`}`
        : n === 'started' ? 'on the ride he just started' : n === 'startedEither' ? 'on the ride he just started, or his next' : 'waits for his next ride';
      return { name, sub, amt: '…', st: 'riding' };
    }
    if (o && o.ready) {
      const gain = o.payout - b.stake;
      if (b.status === C.STATUS.CLAIMED || b.status === C.STATUS.REFUNDED) return { name, sub: `collected ${sqkText(o.payout)} SQK${when}`, amt: o.payout ? signedSqk(gain) : `−${sqkText(b.stake)}`, st: o.payout >= b.stake ? 'won' : o.payout ? 'short' : 'caught' };
      if (o.payout > 0n) return { name, sub: `${o.cls === C.CLS.REFUND ? 'bulb lit too soon · bet back' : 'lit'} · ready to collect ${sqkText(o.payout)} SQK${when}`, amt: signedSqk(gain), st: gain >= 0n ? 'won' : 'short' };
      return { name, sub: `stayed dark${when}`, amt: `−${sqkText(b.stake)}`, st: 'caught' };
    }
    if (o && o.cls === C.CLS.LOSE && o.result === C.RESULT.ROLLED) return { name, sub: `stayed dark · rolled into the bonus pot${when}`, amt: `−${sqkText(b.stake)}`, st: 'pot' };
    const est = L.chained.results.get(b.id);
    if (est) {
      if (est.cls === 'lose') return { name, sub: `stayed dark${est.result === 'rolled' ? ' · rolls into the bonus pot' : ''}${when}`, amt: `−${sqkText(b.stake)}`, st: est.result === 'rolled' ? 'pot' : 'caught' };
      return { name, sub: `${est.cls === 'refund' ? 'lit too soon · bet back' : 'lit'} · ${sqkText(est.payout)} SQK to collect${when}`, amt: signedSqk(est.payout - b.stake), st: est.payout >= b.stake ? 'won' : 'short' };
    }
    return { name, sub: `being counted${when}`, amt: '…', st: 'riding' };
  }
  const rideOf = (b) => L.view.rides.find((r) => r.lastBetRound >= b.betRound && (L.view.rides[L.view.rides.indexOf(r) - 1]?.lastBetRound ?? -1) < b.betRound) || null;

  function row({ me, name, sub, amt, st }) {
    const r = document.createElement('div'), who = document.createElement('div'), n = document.createElement('b'), s = document.createElement('small'), a = document.createElement('div');
    r.className = `rider${me ? ' me' : ''}`; r.dataset.st = st; who.className = 'who'; a.className = 'amt';
    n.textContent = name; s.textContent = sub; a.textContent = amt;
    if (/^\+/.test(amt)) a.classList.add('win'); else if (/^−/.test(amt)) a.classList.add('lose');
    who.append(n, s); r.append(document.createElement('i'), who, a);
    return r;
  }

  // The countdown under the board: how long the round has left, and what its end decides (a bulb, a break, the
  // blackout). Shown while a ride is on (or he just got on); hidden while he sleeps, when the records run late or the
  // game has ended. { frac 0..1 into the round (or the warm-up's two rounds), text, tone: run | wait | danger }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function meterFor(d) {
    if (!d || d.loading || d.voided || L.paused || d.late > 4 || !L.G) return null;
    const G = L.G, now = d.now, cur = d.cur, left = Math.max(0, M.roundStart(cur + 1, G) - now);
    const frac = Math.min(1, Math.max(0, 1 - left / M.ROUND_SECONDS));
    const known = M.knownActive(L.seen, G, d.S, L.coreCum);
    const activeNow = d.running === true || known.has(cur);
    if (d.open) {
      if (cur - d.open.start + 1 > L.station) return null;   // the night ends at its 6-hour limit
      if (d.win.mayBeOut && !activeNow) return { frac, text: 'Two quiet rounds: the lights may be out. Waiting for Squeekchain\'s record.', tone: 'danger' };
      // bulbs on their way: rounds that ended with his turns but aren't on the chain yet
      let pending = 0;
      for (let r = d.S + 1; r < cur; r++) if (known.has(r)) pending++;
      const next = d.lit + pending + 1;
      if (next > 24) return null;
      if (cur - d.open.start + 1 === L.station) return { frac, text: `Last round of the night (6 hours): ${activeNow ? `bulb ${next} lights in ${mmss(left)}` : `${mmss(left)} left`}`, tone: activeNow ? 'run' : 'wait' };
      if (activeNow) return { frac, text: `Bulb ${next} lights in ${mmss(left)}`, tone: 'run' };
      // he stopped in this round: it is a break unless he runs again before it ends; after a quiet round, the blackout
      const prev = cur - 1, quietBefore = prev <= d.S ? prev === d.S && d.open.idleRun > 0 : !known.has(prev);
      if (quietBefore) return { frac, text: `Lights out in ${mmss(left)} unless he runs again`, tone: 'danger' };
      return { frac, text: `He stopped: bulb ${next} still lights if he runs again in the next ${mmss(left)}`, tone: 'wait' };
    }
    if (d.started || d.running) {
      // no ride recorded yet: the first round with his turns is the warm-up, bulb 1 lights at the end of the next one
      let dep = null;
      for (const r of known) if (r > d.S && r <= cur && (dep == null || r < dep)) dep = r;
      if (dep == null) dep = cur;
      const end = M.roundStart(dep + 2, G), t = Math.max(0, end - now);
      return { frac: Math.min(1, Math.max(0, 1 - t / (2 * M.ROUND_SECONDS))), text: `Bulb 1 lights in ${mmss(t)} if he keeps running`, tone: activeNow ? 'run' : 'wait' };
    }
    return null;
  }
  function showMeter(m) {
    const el = $('meter');
    if (el.hidden !== !m) el.hidden = !m;
    if (!m) return;
    setText('meterText', m.text);
    if (el.dataset.tone !== m.tone) el.dataset.tone = m.tone;
    const fill = $('meterFill'), v = m.frac.toFixed(3);
    if (fill.dataset.p !== v) { fill.dataset.p = v; if (fill.style) fill.style.transform = `scaleX(${v})`; }
  }

  function caption(d) {
    if (d.loading) return L.err.core ? 'Can\'t reach Squeekchain right now. Trying again…' : 'Connecting to Squeekchain…';
    const clock = hhmm(new Date(d.now * 1000));
    const pot = d.potIn > 0n ? ` Bonus pot: ${sqkText(d.potIn)} SQK.` : '';
    const rec = d.wheel ? '' : ' Following Squeekchain\'s 10-minute records.';
    if (d.open) {
      const since = hhmm(new Date(M.roundStart(d.open.start, L.G) * 1000));
      const state = d.running ? 'Squeektoshi is running' : d.running === false ? 'Squeektoshi stopped for a moment' : 'Squeektoshi is out on his ride';
      return `Live · ${clock} · ${state}. ${d.lit ? `${bulbs(d.lit)} lit` : 'Warming up'} since ${since} your time.${pot}${rec}`;
    }
    if (d.running) return `Live · ${clock} · He just got on the wheel.${pot}`;
    if (d.started) return `Live · ${clock} · He got on the wheel and stopped for a moment.${pot}${rec}`;
    const last = d.last ? ` His last ride lit ${bulbs(d.last.lit)} (blackout at ${hhmm(new Date(M.roundStart(d.last.end === 'blackout' ? d.last.C : d.last.start + L.station, L.G) * 1000))} your time).` : '';
    return `Live · ${clock} · He is asleep.${last}${pot}${rec}`;
  }

  // ---------------------------------------------------------------- the board

  function view(time) {
    const d = derive();
    if (time - L.lastDash >= .25 || L.lastDash < 0) {
      L.lastDash = time;
      updateDash(d);
      setText('caption', caption(d));
      showMeter(meterFor(d));
      if (!d.loading) renderLists(d);
      $('liveDot').dataset.on = String(!d.loading && !L.err.core);
    }
    if (d.loading) {
      // the chain can't be read (yet), but a fresh wheel reading says whether he runs: the LIVE cam follows it
      const w = L.wheel && L.wheel.fresh ? L.wheel : null;
      // (a short word that fits a phone's sign: it stands still, and the first news replaces it at once)
      return { lit: 0, resting: !(w && w.running), msg: 'CONNECTING...', pace: w && w.running ? Math.max(120, w.rpm * 10) : 0 };
    }
    // a new bulb lit while you watch: a spark runs to it; the lights went out: they pop off
    const openStart = d.open ? d.open.start : null;
    if (L.lastLit != null && openStart != null && openStart === L.lastOpen && d.lit > L.lastLit) {
      for (let k = L.lastLit + 1; k <= d.lit; k++) Board.spark(k, time);
      Board.sfx.zap();
      // your bulb lit: coins, unless the lights going out now would give back less than your bet
      if (d.mine && d.mine.bulb > L.lastLit && d.mine.bulb <= d.lit) { const e = estimateFor(d, d.mine, d.lit); if (e && e.payout >= d.mine.stake) setTimeout(() => Board.sfx.coin(), 700); }
    }
    if (L.lastOpen != null && openStart == null && d.last && d.last.start === L.lastOpen) { L.outAt = time; Board.sfx.out(); }
    // news from the ride (a new bulb, a start, a blackout) replaces an old message, unless the wallet is busy
    const nights = L.view.rides.length, sit = `${d.late > 4}|${L.paused}|${d.voided}`;
    if (L.lastLit != null && (openStart !== L.lastOpen || d.lit !== L.lastLit || nights !== L.lastNights || sit !== L.lastSit) && !L.busy && L.msg && !L.msg.sticky) { L.msg = null; L.lastDash = -1; }
    L.lastNights = nights; L.lastSit = sit;
    if (openStart != null) L.outAt = null;
    L.lastOpen = openStart; L.lastLit = d.lit;

    // After a blackout the lights go out on the board (1.6 s, longer over several pages, the last bulb first; at once if the page opened after
    // it), then the board shows his next ride: no bulb lit, scrolled to bulb 1, with the bets for it and your pick.
    // Only the sign still says how far he got.
    const justOut = !d.open && d.sinceOut != null && d.sinceOut <= 6 && d.last;
    const outP = justOut && L.outAt != null ? (time - L.outAt) / Board.outSeconds(d.last.lit) : null;
    const goingOut = outP != null && outP < 1;
    const lit = d.open ? d.lit : goingOut ? d.last.lit : 0;
    L.boardLit = lit; // a tap on the board is read for the same view as this frame
    const per = M.perBulb(d.current, L.account);
    const markers = goingOut || d.voided ? [] : [...per].map(([bulb, x]) => ({ bulb, me: x.mine, others: x.count - (x.mine ? 1 : 0) }));
    const potN = d.potIn > 0n ? Math.round(Number(d.potIn / (W / 100n)) / 100) : 0;
    const resting = d.running === null ? !(d.open && d.open.idleRun === 0 && d.late <= 1) : !d.running;
    // a quiet round is recorded, but the wheel turns again right now: what the cam shows wins (no flicker). Unless
    // the next round has ended unrecorded: the break may have put the lights out, so no "NEXT: BULB" promise yet
    // and the bulbs still flicker.
    const maybeOut = !!d.open && d.win.mayBeOut;
    const back = !!d.open && d.open.idleRun > 0 && d.running === true;
    // (no ride recorded yet, but he got on the wheel and stopped: a short break too, so the cam shows him awake)
    const flicker = (!!d.open && (!back || maybeOut) && (d.open.idleRun > 0 || d.running === false || maybeOut)) || (!d.open && d.started && d.running === false);
    const pace = d.wheel && d.wheel.running ? Math.max(120, d.wheel.rpm * 10) : !resting && d.open ? d.open.w[d.open.w.length - 1] || 300 : 0;
    // Someone else's new bet (not one there when the page opened, not yours): news on the sign for a few seconds, but
    // only while nothing happens on the ride. News from the ride (a bulb, a stop, a start, a blackout) wins at once.
    const rideSig = `${openStart}|${d.lit}|${d.running}|${d.open ? d.open.idleRun : ''}|${d.started}|${justOut}`;
    if (rideSig !== L.rideSig) { L.rideSig = rideSig; L.betNews = null; }
    if (L.snap) {
      const ids = [...L.bets.keys()];
      if (L.betsSeen == null) L.betsSeen = new Set(ids);
      else for (const id of ids) if (!L.betsSeen.has(id)) {
        L.betsSeen.add(id);
        const b = L.bets.get(id);
        if (b && !b.local && !(L.account && same(b.owner, L.account))) L.betNews = { text: `NEW BET * BULB ${b.bulb} * ${sqkText(b.stake)} SQK`, until: time + 8 };
      }
    }
    const calm = !justOut && !flicker && !maybeOut && !(d.open && d.lit === 0);
    const news = calm && L.betNews && time < L.betNews.until ? L.betNews.text : null;
    let msg;
    if (d.voided) msg = 'THIS GAME HAS ENDED * COLLECT YOUR BETS BELOW';
    else if (news) msg = news;
    else if (justOut) msg = `BLACKOUT ${d.last.lit ? `AFTER ${bulbs(d.last.lit).toUpperCase()}` : 'BEFORE BULB 1'} * ${d.running ? 'HE IS BACK ON THE WHEEL * LIGHTS ON SOON' : d.started ? 'SHORT BREAK * LIGHTS ON SOON' : 'SWEET DREAMS'}${potN ? ` * BONUS POT ${potN} ROLLS ON` : ''}`;
    else if (d.open && d.lit === 0 && !flicker) msg = 'HE IS ON THE WHEEL * WARMING UP';
    else if (maybeOut && d.running) msg = back ? 'HE IS BACK ON THE WHEEL' : 'HE IS RUNNING';
    else if (back) msg = `HE IS BACK ON THE WHEEL * NEXT: BULB ${d.lit + 1}`;
    else if (d.open && d.open.idleRun > 0) msg = 'LIGHTS FLICKER ... IS HE ASLEEP?';
    else if (d.open && d.running === false) msg = 'SHORT BREAK * LIGHTS FLICKER';
    else if (d.open) msg = `HE IS RUNNING * NEXT: BULB ${d.lit + 1}`;
    else if (d.running) msg = 'HE IS ON THE WHEEL * LIGHTS ON SOON';
    else if (d.started) msg = 'SHORT BREAK * LIGHTS ON SOON';
    else msg = hasGame ? 'HE IS ASLEEP * BETS NOW COUNT FOR HIS NEXT RIDE' : 'HE IS ASLEEP * SWEET DREAMS';
    // the bulb marked as picked: your bet's, or the one the picker shows (none while the lights go out)
    return { lit, flicker, resting, pace, speedMul: 1, pot: potN, markers, pick: d.voided || goingOut ? 0 : d.mine ? d.mine.bulb : shown(d), outP: goingOut ? outP : null, msg };
  }

  // ---------------------------------------------------------------- the player's moves

  // the main button; want = 'collect': the Collect link in the sentence under it
  async function act(want) {
    if (!hasGame || L.busy) return;
    if (!L.snap) { refreshAll(); return; }
    if (!wallet) return noWallet();
    try {
      if (!L.account) {
        L.busy = 'Connecting…';
        L.account = await wallet.connect();
        L.my = new Map(); L.myLogs = false; L.logTries = 0; L.eth = null;
        await checkChain();
        if (L.chainOk) await refreshMine();
        return;
      }
      if (!L.chainOk) {
        L.busy = 'Switching…';
        await wallet.switchChain();
        await checkChain();
        await refreshMine();
        return;
      }
      // busy at once: a second tap while the page looks at the wallet's test ETH must not start a second bet
      L.busy = 'Checking…'; L.lastDash = -1;
      const d = derive();
      if (d.loading) return;
      const a = want === 'collect' ? (d.collectIds.length ? 'collect' : null) : mainAction(d);
      if (a === 'collect') return await doCollect(d);
      if (a !== 'bet' && a !== 'amount') return;
      // "Get practice SQK first": the button does what it says (the practice tap needs the page free)
      if (a === 'bet' && config.practice && L.eth !== 0n && lacksSqk()) { L.busy = null; return await getPractice(); }
      await doBet(d);
    } catch (e) {
      const x = C.explain(e);
      if (x.kind === 'already') schedule('game');
      if (x.kind === 'gas') sayEth(); else say(x.text, e.hash || null, x.kind === 'timeout' ? 60_000 : 20_000);
    } finally {
      L.busy = null; L.lastDash = -1;
    }
  }

  // the bulb about to be bet on must still be at or above the lowest safe bulb right now
  function tooClose(bulb) {
    const d = derive();
    if (bulb < d.win.floor) {
      L.pick = d.win.floor;
      throw Object.assign(new Error('too close'), { tooClose: true, was: bulb, floor: d.win.floor });
    }
    return d;
  }

  async function doBet() {
    const amount = amountWei();
    if (!amount) return say('A bet must be a whole number from 10 to 10,000 SQK.');
    // no test ETH: the wallet couldn't pay the fee (looked at again first: he may just have got some)
    if (L.eth === 0n && (await ethNow()) === 0n) return sayEth();
    if (L.balance != null && L.balance < amount) return say(`Not enough SQK: you have ${sqkText(L.balance)}, this bet needs ${sqkText(amount)}.${practiceTap() ? ' Tap Get 1,000 practice SQK below.' : ''}`, null, 20_000, { links: practiceLink });
    const d0 = derive();
    if (d0.mine || (L.pending && same(L.pending.account, L.account))) return; // your bet is in (maybe not on the page's node yet)
    const bulb = shown(d0);
    if (bulb > 24) return;
    // an allow this page saw go through on an earlier press: the wallet isn't asked for it again
    const memo = L.allowMemo && same(L.allowMemo.account, L.account) && Date.now() - L.allowMemo.at < ALLOW_MEMO_MS ? L.allowMemo : null;
    let twoSteps = false;
    try {
      const res = await C.placeBet({
        // the round the lowest bulb is worked out for right now: the bet fails if it lands later
        chain, wallet, account: L.account, bulb, amount, lastRound: () => { const d = derive(); return d.loading ? d0.N : d.N; },
        priorAllow: memo,
        onStep: (s, info) => {
          if (s === 'allow') twoSteps = true;
          if (s === 'allowed') L.allowMemo = { account: L.account, amount: info.amount, at: Date.now() };
          L.busy = STEP_LABEL[s] || L.busy;
          if (s === 'catchup') say('The game is still reading his latest rounds. Your wallet asks once to let it catch up, then for your bet.', null, 600_000);
          if (s === 'catching') say('The game is catching up…', null, 600_000);
          if (s === 'allow') say(`Step 1 of 2: allow the game to take exactly ${sqkText(amount)} SQK. Your wallet will ask.`, null, 600_000);
          if (s === 'allowing') say('Step 1 of 2: waiting for the network…', null, 600_000);
          if (s === 'allowWait') say(`${twoSteps ? 'Step 1 of 2 done: your' : 'Your'} allow went through. The network is slow to show it; waiting a moment before your bet…`, null, 600_000);
          if (s === 'bet') say(`${twoSteps ? 'Step 2 of 2: place' : 'Place'} your bet of ${sqkText(amount)} SQK on bulb ${bulb}. Your wallet will ask.`, null, 600_000);
          if (s === 'betting') say('Placing your bet…', null, 600_000);
          L.lastDash = -1;
        },
        // the other steps can take a while: check the bulb again right before the bet goes out
        beforeBet: async () => { tooClose(bulb); },
      });
      L.allowMemo = null; // the bet used it
      keepPlaced(res);
      Board.sfx.bet();
      // (which ride: from the round the bet landed in, as its receipt says)
      const dn = derive(), round = res && res.bet && res.bet.betRound != null ? res.bet.betRound : null;
      const night = dn.loading ? null : round != null ? dn.win.nightAt(round) : dn.win.night;
      say(`Bet placed: ${sqkText(amount)} SQK on bulb ${bulb}, ${FOR_TEXT[night] || 'for this ride'}.`, null, 30_000);
    } catch (e) {
      if (e.tooClose) return say(`Bulb ${e.was} got too close while you were confirming, so the bet wasn't sent. The game is still allowed to take exactly ${sqkText(amount)} SQK; press the button again for bulb ${e.floor} or higher.`, null, 30_000);
      // a bet that failed with no reason given, while your earlier bet is on this ride: that one is why
      const prev = L.lastPlaced;
      if (e.code === 'FAILED' && prev && same(prev.account, L.account) && derive().current?.some((b) => b.id === prev.id)) {
        return say(`Your bet is already placed: ${sqkText(prev.stake)} SQK on bulb ${prev.bulb}. It's one bet per ride, so this second one didn't go through.`, e.hash || null, 30_000);
      }
      throw e;
    } finally {
      for (const k of ['game', 'mine']) schedule(k);
      loop();
    }
  }

  // Your bet from its receipt (the BetPlaced log), kept until the page's node shows it: the dashboard, the board,
  // the button and the balance follow it at once, so a lagging node can't offer the same bet again.
  function keepPlaced(res) {
    const p = res && res.bet;
    if (!p || p.betId == null || !same(p.owner, L.account)) return;
    const bet = { id: p.betId, owner: L.account, betRound: p.betRound, bulb: p.bulb, stake: p.stake, status: C.STATUS.WAITING, cls: 0, litBefore: 0, night: 0, cumBefore: 0n, local: true };
    L.lastPlaced = { id: bet.id, account: L.account, bulb: bet.bulb, stake: bet.stake };
    if (!L.bets.has(bet.id)) L.bets.set(bet.id, bet);
    if (!L.my.has(bet.id)) L.my.set(bet.id, { bet: L.bets.get(bet.id) });
    const balanceAfter = res.balance != null ? res.balance - bet.stake : null;
    if (!(L.snap && L.snap.betCount > bet.id)) L.pending = { id: bet.id, account: L.account, balanceAfter, at: Date.now() };
    if (balanceAfter != null && L.balance != null && L.balance > balanceAfter) L.balance = balanceAfter;
    regroup();
  }

  async function doCollect(d) {
    try {
      const r = await C.collect({
        chain, wallet, account: L.account, ids: d.collectIds,
        onStep: (s, info) => {
          L.busy = STEP_LABEL[s] || L.busy;
          if (s === 'count') say(`The game hasn't counted this ride yet. Your wallet asks once to count it${info && info.step > 1 ? ' a little more' : ''}, then once to collect.`, null, 600_000);
          if (s === 'counting') say('Counting the ride…', null, 600_000);
          if (s === 'collect') say(`Collect ${sqkText(d.collectSum)} SQK. Your wallet will ask.`, null, 600_000);
          if (s === 'collecting') say('Collecting…', null, 600_000);
          L.lastDash = -1;
        },
      });
      // what each bet paid, from the receipt: those bets are done even while the page's node doesn't show it yet
      let stakes = 0n;
      for (const p of r.paid || []) {
        const x = L.my.get(p.id);
        if (!x || x.final) continue;
        x.paid = { amount: p.amount, refunded: p.refunded };
        if (x.bet && x.bet.stake != null) stakes += x.bet.stake;
        if (L.balance != null) L.balance += p.amount;
      }
      if (r.collected > 0n && r.collected >= stakes) Board.sfx.coin();
      say(`Collected ${sqkText(r.collected)} SQK.`, r.hash, 30_000);
    } finally {
      for (const k of ['game', 'mine']) schedule(k);
      loop();
    }
  }

  // Rehearsal only (config.practice): the practice token gives 1,000 to anyone who asks; one wallet confirmation.
  async function getPractice() {
    if (!wallet || !L.account || L.busy) return;
    L.busy = 'Getting practice SQK…'; L.lastDash = -1;
    try {
      // without test ETH the wallet can only warn and refuse: say where to get some instead of asking it
      if ((await ethNow()) === 0n) return sayEth();
      say('Confirm in your wallet: 1,000 practice SQK for you (only the network fee, in test ETH).');
      const hash = await wallet.send(L.account, config.sqk, '0xde5f72fd'); // faucet()
      say('Getting your practice SQK…', hash);
      const r = await wallet.waitReceipt(hash);
      say(r.ok ? 'You got 1,000 practice SQK.' : r.timeout ? 'Still waiting for the network. Your practice SQK will show up soon.' : 'That didn\'t work. Please try again.', hash);
    } catch (e) {
      // why nothing was sent, in plain words (no test ETH for the fee: where to get some)
      const x = C.explain(e);
      if (x.kind === 'gas') sayEth(); else say(x.text, e.hash || null, 30_000);
    } finally {
      L.busy = null; L.lastDash = -1;
      schedule('mine'); loop();
    }
  }

  // ---------------------------------------------------------------- wiring

  async function start() {
    if (wallet && config.practice) $('faucet').addEventListener('click', getPractice);
    if (wallet) {
      // another account or network: what the sentence under the button said was about the old one
      const forget = () => { if (!L.busy) { L.msg = null; $('status').dataset.key = ''; } L.lastDash = -1; };
      wallet.on('accountsChanged', (a) => { L.account = Array.isArray(a) && a[0] ? a[0] : null; L.my = new Map(); L.myLogs = false; L.logTries = 0; L.balance = null; L.eth = null; L.ack = null; forget(); checkChain().then(() => { schedule('mine'); loop(); }); });
      wallet.on('chainChanged', () => { forget(); checkChain().then(() => { schedule('mine'); loop(); }); });
      try { const a = await wallet.accounts(); if (a[0]) { L.account = a[0]; await checkChain(); } } catch { /* not connected yet */ }
    }
    refreshAll();
    L.timer = setInterval(loop, 5000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) loop(); });
  }

  return {
    start,
    enter() {
      L.active = true; L.lastDash = -1; $('status').setAttribute('aria-live', 'polite');
      $('replayControls').hidden = true; $('results').hidden = true;
      $('act').hidden = !hasGame; $('soon').hidden = hasGame; $('amountRow').hidden = !hasGame; $('amtLabel').hidden = !hasGame; $('amtOther').hidden = !hasGame;
      $('playersPanel').hidden = !hasGame;
      setText('eyebrow', hasGame ? (config.practice ? 'Squeekchain · live rehearsal · practice SQK, no real money' : 'Squeekchain · live on the test network · test SQK, no real money') : 'Squeekchain · live · betting opens soon');
      for (const id of ['b50', 'b100', 'b200']) $(id).setAttribute('aria-pressed', String($(id).dataset.bet === L.amountText));
      $('amtOther').value = ['50', '100', '200'].includes(L.amountText) ? '' : L.amountText;
      Board.resetAnimations();
      L.lastLit = null; L.lastOpen = null; L.betsSeen = null; L.betNews = null; L.rideSig = null;
      $('status').dataset.key = '';
      // the replay drew its pretend players into the same list: draw the live bets again
      $('riders').textContent = ''; $('riders').dataset.key = ''; $('mine').dataset.key = '';
      loop();
    },
    exit() { L.active = false; $('meter').hidden = true; },
    view,
    minus() { const d = derive(); if (!d.loading && !d.mine && !d.voided) { moveOn(d); L.pick = Math.max(d.win.floor, shown(d) - 1); Board.sfx.tick(); L.lastDash = -1; } },
    plus() { const d = derive(); if (!d.loading && !d.mine && !d.voided) { moveOn(d); L.pick = Math.min(24, shown(d) + 1); Board.sfx.tick(); L.lastDash = -1; } },
    amount(v, typed) {
      const d = derive(); if (!d.loading && !d.mine && !d.voided) moveOn(d);
      L.amountText = String(v);
      for (const id of ['b50', 'b100', 'b200']) $(id).setAttribute('aria-pressed', String(!typed && $(id).dataset.bet === L.amountText));
      if (!typed) $('amtOther').value = '';
      L.lastDash = -1;
    },
    act,
    board(clientX) {
      const d = derive();
      // no picking while the picker is hidden (your bet is in, or the game ended); a win still to collect doesn't stop it
      if (d.loading || d.mine || d.voided) return;
      // the bulb under the tap on the board as it is drawn right now (it scrolls with the lit bulbs)
      const k = Board.bulbAt(clientX, L.boardLit ?? (d.open ? d.lit : 0));
      if (k) { moveOn(d); L.pick = Math.max(d.win.floor, k); Board.sfx.tick(); L.lastDash = -1; }
    },
    // for tests and the console: what the page knows right now, and read everything again now
    debug: () => ({ derived: derive(), state: L }),
    refresh: refreshAll,
  };
}
