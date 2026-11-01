// Live mode (the default): follows Squeektoshi's ride right now. SqueekCore's records decide the bulbs, breaks and
// the blackout; the status API only says whether the wheel is turning this minute. With a LightsOn address in
// config.json it also shows the bonus pot, everyone's bets, your bet and what you can collect, and lets you bet
// through your wallet. Every read and write goes through chain.js; the rules are live-model.js + engine.js.
import * as C from './chain.js';
import * as M from './live-model.js';
import * as Board from './board.js';

const W = 10n ** 18n;
const EVERY = { core: 20_000, wheel: 15_000, game: 30_000, mine: 30_000 };
const STEP_LABEL = { check: 'Checking…', catchup: 'Confirm in your wallet', catching: 'Catching up…', allow: 'Allow in your wallet', allowing: 'Allowing…', bet: 'Confirm in your wallet', betting: 'Placing your bet…', count: 'Confirm in your wallet', counting: 'Counting the ride…', collect: 'Confirm in your wallet', collecting: 'Collecting…' };

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
const FOR_TEXT = { tonight: "for tonight's ride", either: 'for tonight, or his next ride if the lights go out', next: 'for his next ride' };

export function createLive({ $, setText, setStatus, config, base, onRides, provider }) {
  const hasGame = C.isAddress(config.lightsOn);
  const chain = C.createChain(config);
  const sameCore = !!(base && base.core && same(base.core, config.squeekCore));
  const history = sameCore ? { rides: base.rides, settledThrough: base.settledThrough } : { rides: [], settledThrough: Number(config.walkFrom) || 0 };
  const wallet = hasGame && provider ? C.createWallet(provider, config, chain) : null;
  const netName = config.chainName || (Number(config.chainId) === C.SEPOLIA_ID ? 'Sepolia' : 'the game network');

  const L = {
    active: false,
    G: Number(config.genesis) || (sameCore ? base.genesis : 1793022600),
    station: 36,
    consts: null,
    S: null, rounds: [], view: null, paused: false,
    wheel: null, offset: 0,
    snap: null, startIdx: 0, bets: new Map(), groups: { byRide: new Map(), current: [] }, chained: { potIn: 0n, results: new Map() },
    account: null, chainOk: null, balance: null, my: new Map(), myLogs: false,
    pick: 6, amountText: '100', busy: null, msg: null,
    lastLit: null, lastOpen: null, lastNights: null, outAt: null,
    err: { core: null, game: null }, due: { core: 0, wheel: 0, game: 0, mine: 0 }, running: { core: false, wheel: false, game: false, mine: false },
    again: { core: false, wheel: false, game: false, mine: false },
    lastDash: -1, timer: null,
  };

  const nowSec = () => Date.now() / 1000 + L.offset;
  const amountWei = () => {
    const t = String(L.amountText).trim();
    if (!/^\d{1,5}$/.test(t)) return null;
    const v = BigInt(t);
    return v >= 10n && v <= 10_000n ? v * W : null;
  };

  // ---------------------------------------------------------------- reading

  async function refreshCore() {
    const st = await chain.core.state();
    L.paused = st.paused;
    const from = L.S ?? history.settledThrough;
    if (st.settledThrough > from) L.rounds.push(...await chain.core.activeRounds(from, st.settledThrough));
    if (st.settledThrough > from || L.view == null) {
      L.S = Math.max(st.settledThrough, history.settledThrough);
      L.view = M.walkNights(history, L.rounds, L.S, L.station);
      onRides(L.view.rides, L.G);
      regroup();
    }
    // The device clock decides the round unless the chain is clearly ahead of it (a device clock running slow, or
    // a local test chain moved forward). A slow device would otherwise offer bulbs that are already too close.
    try {
      const b = await chain.latestBlock();
      const skew = b.timestamp - Date.now() / 1000;
      L.offset = config.clock === 'chain' ? skew : config.clock === 'device' ? 0 : skew > 30 ? skew : 0;
    } catch { /* keep the last offset */ }
  }

  async function refreshWheel() {
    try { L.wheel = await chain.wheel(); } catch { L.wheel = null; }
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
    L.balance = await chain.sqk.balanceOf(me);
    if (!L.myLogs) {
      const logs = await chain.lights.betIdsOf(me).catch(() => null);
      if (logs) for (const l of logs) if (!L.my.has(l.betId)) L.my.set(l.betId, { bet: { id: l.betId, owner: me, bulb: l.bulb, stake: l.stake, betRound: l.betRound } });
      L.myLogs = true;
    }
    for (const b of L.bets.values()) if (same(b.owner, me) && !L.my.has(b.id)) L.my.set(b.id, { bet: b });
    const last = await chain.lights.lastBet(me);
    if (last > 0 && !L.my.has(last - 1)) { const [b] = await chain.lights.betsById([last - 1]); if (same(b.owner, me)) L.my.set(b.id, { bet: b }); }
    const open = [...L.my.entries()].filter(([, x]) => !x.final).map(([id]) => id).sort((a, b) => a - b).slice(-40);
    if (!open.length) return;
    const [bets, outs] = [await chain.lights.betsById(open), await chain.lights.outcomes(open)];
    bets.forEach((b, i) => {
      const x = L.my.get(b.id);
      x.bet = b; x.outcome = outs[i];
      x.final = b.status === C.STATUS.CLAIMED || b.status === C.STATUS.REFUNDED;
    });
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
      L.due[kind] = L.again[kind] ? Date.now() : Date.now() + EVERY[kind];
      L.again[kind] = false;
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
    const win = M.betWindow({ S, cur, N, open, wheel, station: L.station });
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
      if (x.final || !x.bet) continue;
      if (x.outcome && x.outcome.ready) { if (x.outcome.payout > 0n) collect.push({ id: x.bet.id, amount: x.outcome.payout }); continue; }
      const est = L.chained.results.get(x.bet.id);
      if (est && est.payout > 0n && !current.some((b) => b.id === x.bet.id)) collect.push({ id: x.bet.id, amount: est.payout });
    }
    const collectIds = collect.map((x) => x.id), collectSum = collect.reduce((a, x) => a + x.amount, 0n);
    return { now, cur, S, N, open, lit, wheel, running, win, late, last, sinceOut, potIn, current, mine: voided ? null : mine, collectIds, collectSum, voided };
  }

  // tonight's estimate for a bet (placed or not) if the lights go out right after bulb `upTo`
  function estimateFor(d, bet, upTo, extra) {
    const s = M.estimate({ open: d.open, S: d.S, cur: d.cur, running: !!d.running, bets: d.current, potIn: d.potIn, lit: upTo, extra });
    const list = extra ? [...d.current, extra] : d.current;
    const i = list.indexOf(bet);
    return i < 0 ? null : { payout: s.payouts[i], cls: s.classes[i] };
  }

  function updateDash(d) {
    const btn = $('act');
    if (d.loading) {
      setText('youState', '–'); setText('money', '–'); setText('moneySub', ' ');
      setStatus(L.err.core ? 'Can\'t reach Squeekchain right now. Trying again…' : 'Reading Squeektoshi\'s rounds from Squeekchain…');
      btn.disabled = true; setText('act', 'Loading…');
      return;
    }
    const odds = M.odds(L.view.rides), oddsFor = (k) => odds[k - 1];
    const floor = d.win.floor, noBulb = floor > 24, recordsLate = d.late > 4 || L.paused;
    const pick = shown(d);
    $('bPick').textContent = pick;
    const o = oddsFor(pick);
    setText('pickOdds', !hasGame ? '' : `Bulb ${pick} · ${M.runTime(pick)} · ${o.total ? `lit on ${o.pct}% of his nights` : 'no nights to count yet'}`);
    $('pickOdds').title = `${o.lit} of his ${o.total} nights`;
    $('pickRow').hidden = !!d.mine || d.voided;

    // your bulb and the one number
    const money = $('money');
    const showMoney = (wei) => { setText('money', signedSqk(wei)); const c = wei > W / 2n ? 'win' : wei < -W / 2n ? 'lose' : ''; if (money.className !== c) money.className = c; };
    const plain = (text) => { setText('money', text); if (money.className) money.className = ''; };
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
      setText('youSub', `${d.open && !before ? `${b.bulb - d.lit} to go · ` : !d.open ? 'next ride · ' : ''}bet ${sqkText(b.stake)}`);
      if (!before) {
        const e = estimateFor(d, b, b.bulb);
        setText('moneyLabel', `If the lights go out right after bulb ${b.bulb}`);
        if (e) showMoney(e.payout - b.stake); else plain('–');
        setText('moneySub', 'with the bets so far');
      } else {
        const e = estimateFor(d, b, d.lit);
        setText('moneyLabel', 'If the lights go out now');
        if (e) showMoney(e.payout - b.stake); else plain('–');
        setText('moneySub', e ? `you would get back ${sqkText(e.payout)} SQK` : ' ');
      }
    } else {
      setText('youState', noBulb ? 'No bulb left' : `Bulb ${pick}?`);
      setText('youSub', hasGame ? (noBulb ? 'bets open again for his next ride' : FOR_TEXT[d.win.night]) : 'Tap a bulb on the board, or use − and +');
      if (hasGame) {
        const amt = amountWei() || 100n * W;
        const extra = { stake: amt, bulb: pick, betRound: d.N, owner: L.account || '0x0', id: -1 };
        const e = noBulb ? null : estimateFor(d, extra, pick, extra);
        setText('moneyLabel', `If the lights go out right after bulb ${pick}`);
        if (e) showMoney(e.payout - amt); else plain('–');
        setText('moneySub', 'with the bets so far');
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
    else if (!wallet || !L.account) label = 'Connect wallet';
    else if (!L.chainOk) label = `Switch to ${netName}`;
    else if (d.collectIds.length) label = `Collect ${sqkText(d.collectSum)} SQK`;
    else if (d.voided) { label = 'Game ended'; off = true; }
    else if (d.mine) { label = 'Bet placed'; off = true; }
    else if (noBulb || recordsLate) { label = 'No bets right now'; off = true; }
    else if (!amountWei()) { label = 'Pick a bet'; off = true; }
    else label = `Bet ${sqkText(amountWei())} on bulb ${pick}`;
    if (btn.disabled !== off) btn.disabled = off;
    setText('act', label);

    // wallet line
    const wl = $('walletLine');
    wl.hidden = !(hasGame && L.account);
    if (!wl.hidden) setText('walletLine', L.chainOk === false ? `${short(L.account)} · your wallet is on another network` : `${short(L.account)} · you have ${L.balance == null ? '…' : sqkText(L.balance)} ${config.practice ? 'practice ' : ''}SQK`);
    // the rehearsal's practice token has an open tap: offer it while the wallet holds less than 1,000
    const fb = $('faucet'), tap = !!(config.practice && !wl.hidden && L.chainOk !== false && L.balance != null && L.balance < 1000n * W);
    if (fb.hidden === tap) fb.hidden = !tap;
    if (fb.disabled !== !!L.busy) fb.disabled = !!L.busy;
    // the sentence under the dashboard
    if (L.msg && Date.now() < L.msg.until) return showMessage(L.msg);
    L.msg = null;
    setStatus(statusLine(d, { floor, noBulb, recordsLate, pick }));
  }

  function statusLine(d, { floor, noBulb, recordsLate, pick }) {
    const badAmount = hasGame && !d.mine && !d.voided && !amountWei();
    if (L.err.core) return 'Can\'t reach Squeekchain right now. Trying again…';
    if (L.paused) return 'Squeekchain has paused its records. The lights wait until it starts again.';
    if (recordsLate) return `Squeekchain's records are running late (the last one is ${d.late} rounds old), so the page waits before offering bulbs.`;
    if (d.voided) return d.collectIds.length ? 'This game has ended. Collect your refunds.' : 'This game has ended.';
    const out = d.sinceOut != null && d.sinceOut <= 6 && d.last ? `Blackout after ${bulbs(d.last.lit)}. ` : '';
    if (d.mine) {
      if (!d.open) return `${out}Your bet waits for his next ride. He is asleep now.`;
      const left = d.mine.bulb - d.lit;
      if (left <= 0) return 'Your bulb is lit. Each new bulb shifts more of the pot to higher bulbs.';
      return left === 1 ? 'One more bulb! He needs to keep running about 10 more minutes.' : `He needs to light ${left} more bulbs, about ${left * 10} minutes of running.`;
    }
    const mineDone = L.account && d.last ? [...L.my.values()].find((x) => x.bet && L.chained.results.get(x.bet.id)?.ride === d.last.n) : null;
    if (out && mineDone) {
      const r = L.chained.results.get(mineDone.bet.id);
      if (r.payout > 0n) return `${out}${r.cls === 'refund' ? 'Your bulb lit too soon after your bet, so you get it back.' : `Your bulb ${mineDone.bet.bulb} lit.`} Press Collect to count the ride and take your ${sqkText(r.payout)} SQK.`;
      return `${out}Your bulb ${mineDone.bet.bulb} stayed dark${r.result === 'rolled' ? ': nobody won, so your bet rolls into the bonus pot' : ''}.`;
    }
    if (!hasGame) {
      if (d.open) return d.running === false ? 'He stopped for a moment. The bulbs flicker; 20 quiet minutes are a blackout.' : `He is running: bulb ${d.lit + 1} lights next.`;
      return d.running ? `${out}He just got on the wheel. The lights come on in about 10 minutes.` : `${out}He is asleep. The lights come on when he starts running.`;
    }
    if (noBulb && d.win.closing) return `He has run almost ${Math.round(L.station / 6)} hours, the longest a ride can last, so no new bulb could still win on this ride. Bets open again for his next ride.`;
    if (noBulb) return 'He has lit so many bulbs that none is left to bet on for this ride. Bets open again for his next ride.';
    if (badAmount) return 'A bet must be a whole number from 10 to 10,000 SQK.';
    if (!d.open) {
      if (d.running) return `${out}He just got on the wheel. You can bet on bulb ${floor} or higher.`;
      return `${out}He is asleep. A bet now counts for his next ride.` + (d.win.bulb1Risk && pick === 1 ? ' Bulb 1 only counts if he starts at least 10 minutes after your bet; if he starts sooner, you get the bet back.' : '');
    }
    if (d.running === false) return `He stopped for a moment. A bet now counts for this ride, or for his next ride if the lights go out. Bulb ${floor} or higher.`;
    return `He is running. You can bet on bulb ${floor} or higher.`;
  }

  function showMessage(m) {
    const el = $('status');
    const key = `${m.text}|${m.hash || ''}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.textContent = m.text;
    if (m.hash && config.explorer) {
      const a = document.createElement('a');
      a.href = `${config.explorer.replace(/\/$/, '')}/tx/${m.hash}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'See it on Etherscan';
      el.append(' ', a);
    }
  }
  const say = (text, hash = null, ms = 20_000) => { L.msg = { text, hash, until: Date.now() + ms }; $('status').dataset.key = ''; L.lastDash = -1; };

  function renderLists(d) {
    // tonight's bets
    const box = $('riders');
    const key = JSON.stringify([d.lit, !!d.open, L.account, d.voided, d.current.map((b) => b.id)]);
    if (box.dataset.key !== key) {
      box.dataset.key = key; box.textContent = '';
      setText('playersTitle', d.voided ? 'Bets waiting when the game ended' : d.open ? "Tonight's bets" : 'Bets for his next ride');
      const list = d.current.slice().sort((a, b) => (same(b.owner, L.account) ? 1 : 0) - (same(a.owner, L.account) ? 1 : 0) || a.bulb - b.bulb || a.id - b.id);
      if (!list.length) {
        const p = document.createElement('p'); p.className = 'empty'; p.textContent = d.open ? 'No bets on this ride yet.' : 'No bets for his next ride yet.'; box.append(p);
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
    const mkey = JSON.stringify(mine.map((x) => [x.bet.id, x.bet.status, x.outcome && String(x.outcome.payout), x.outcome && x.outcome.ready, d.lit, !!d.open, L.chained.results.get(x.bet.id)?.payout?.toString()]));
    if (mineBox.dataset.key === mkey) return;
    mineBox.dataset.key = mkey; mineBox.textContent = '';
    for (const x of mine) mineBox.append(row({ me: false, ...describeMine(x, d) }));
  }

  // One of your bets in plain words.
  function describeMine(x, d) {
    const b = x.bet, o = x.outcome, name = `Bulb ${b.bulb} · ${sqkText(b.stake)} SQK`;
    const ride = L.view.rides.find((r) => r.n === L.chained.results.get(b.id)?.ride) || rideOf(b);
    const when = ride ? ` · ride of ${day(new Date(M.roundStart(ride.start, L.G) * 1000))} ${hhmm(new Date(M.roundStart(ride.start, L.G) * 1000))}` : '';
    if (d.voided && o && o.ready && o.payout > 0n && (b.status === C.STATUS.WAITING || b.status === C.STATUS.REFUNDED || (o.cls === C.CLS.LOSE && o.result === C.RESULT.ROLLED))) {
      // the game ended: bets that never got a ride, and stakes riding in a bonus pot, come back
      if (b.status === C.STATUS.REFUNDED || b.status === C.STATUS.CLAIMED) return { name, sub: `the game ended · given back ${sqkText(o.payout)} SQK${when}`, amt: '±0', st: 'won' };
      return { name, sub: `the game ended · ${sqkText(o.payout)} SQK to collect${when}`, amt: '±0', st: 'won' };
    }
    if (!d.voided && d.current.some((c) => c.id === b.id)) {
      return { name, sub: d.open ? `on tonight's ride${b.bulb <= d.lit ? ' · lit' : ` · ${b.bulb - d.lit} to go`}` : 'waits for his next ride', amt: '…', st: 'riding' };
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
      if (!d.loading) renderLists(d);
      $('liveDot').dataset.on = String(!d.loading && !L.err.core);
    }
    if (d.loading) return { lit: 0, resting: true, msg: 'CONNECTING TO SQUEEKCHAIN', pace: 0 };
    // a new bulb lit while you watch: a spark runs to it; the lights went out: they pop off
    const openStart = d.open ? d.open.start : null;
    if (L.lastLit != null && openStart != null && openStart === L.lastOpen && d.lit > L.lastLit) {
      for (let k = L.lastLit + 1; k <= d.lit; k++) Board.spark(k, time);
      Board.sfx.zap();
      if (d.mine && d.mine.bulb > L.lastLit && d.mine.bulb <= d.lit) setTimeout(() => Board.sfx.coin(), 700);
    }
    if (L.lastOpen != null && openStart == null && d.last && d.last.start === L.lastOpen) { L.outAt = time; Board.sfx.out(); }
    // news from the ride (a new bulb, a start, a blackout) replaces an old message, unless the wallet is busy
    const nights = L.view.rides.length, sit = `${d.late > 4}|${L.paused}|${d.voided}`;
    if (L.lastLit != null && (openStart !== L.lastOpen || d.lit !== L.lastLit || nights !== L.lastNights || sit !== L.lastSit) && !L.busy && L.msg) { L.msg = null; L.lastDash = -1; }
    L.lastNights = nights; L.lastSit = sit;
    if (openStart != null) L.outAt = null;
    L.lastOpen = openStart; L.lastLit = d.lit;

    const justOut = !d.open && d.sinceOut != null && d.sinceOut <= 6 && d.last;
    const lit = d.open ? d.lit : justOut ? d.last.lit : 0;
    const outP = justOut ? (L.outAt != null ? (time - L.outAt) / 1.6 : 1) : null;
    const per = M.perBulb(d.current, L.account);
    const markers = justOut || d.voided ? [] : [...per].map(([bulb, x]) => ({ bulb, me: x.mine, others: x.count - (x.mine ? 1 : 0) }));
    const potN = d.potIn > 0n ? Math.round(Number(d.potIn / (W / 100n)) / 100) : 0;
    const resting = d.running === null ? !(d.open && d.open.idleRun === 0 && d.late <= 1) : !d.running;
    const flicker = !!d.open && (d.open.idleRun > 0 || d.running === false);
    const pace = d.wheel && d.wheel.running ? Math.max(120, d.wheel.rpm * 10) : !resting && d.open ? d.open.w[d.open.w.length - 1] || 300 : 0;
    let msg;
    if (d.voided) msg = 'THIS GAME HAS ENDED * COLLECT YOUR BETS BELOW';
    else if (justOut) msg = `BLACKOUT ${d.last.lit ? `AFTER ${bulbs(d.last.lit).toUpperCase()}` : 'BEFORE BULB 1'} * SWEET DREAMS${potN ? ` * BONUS POT ${potN} ROLLS ON` : ''}`;
    else if (d.open && d.lit === 0 && !flicker) msg = 'HE IS ON THE WHEEL * WARMING UP';
    else if (d.open && d.open.idleRun > 0) msg = 'LIGHTS FLICKER ... IS HE ASLEEP?';
    else if (d.open && d.running === false) msg = 'SHORT BREAK * LIGHTS FLICKER';
    else if (d.open) msg = `HE IS RUNNING * NEXT: BULB ${d.lit + 1}`;
    else if (d.running) msg = 'HE IS ON THE WHEEL * LIGHTS ON SOON';
    else msg = hasGame ? 'HE IS ASLEEP * BETS NOW COUNT FOR HIS NEXT RIDE' : 'HE IS ASLEEP * SWEET DREAMS';
    return { lit, flicker, resting, pace, speedMul: 1, pot: potN, markers, pick: d.voided ? 0 : d.mine ? d.mine.bulb : justOut ? 0 : shown(d), outP, msg };
  }

  // ---------------------------------------------------------------- the player's moves

  async function act() {
    if (!hasGame || L.busy) return;
    if (!L.snap) { refreshAll(); return; }
    if (!wallet) return say('No wallet found in this browser. To bet, open this page in a browser with a wallet such as MetaMask or Rabby, set to the Sepolia test network.', null, 30_000);
    try {
      if (!L.account) {
        L.busy = 'Connecting…';
        L.account = await wallet.connect();
        L.my = new Map(); L.myLogs = false;
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
      const d = derive();
      if (d.collectIds.length) return await doCollect(d);
      if (d.voided || d.mine) return;
      await doBet(d);
    } catch (e) {
      const x = C.explain(e);
      if (x.kind === 'already') schedule('game');
      say(x.text, e.hash || null, x.kind === 'timeout' ? 60_000 : 20_000);
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
    if (L.balance != null && L.balance < amount) return say(`Not enough SQK: you have ${sqkText(L.balance)}, this bet needs ${sqkText(amount)}.`);
    const d0 = derive();
    const bulb = shown(d0);
    if (bulb > 24) return;
    let twoSteps = false;
    try {
      await C.placeBet({
        // the round the lowest bulb is worked out for right now: the bet fails if it lands later
        chain, wallet, account: L.account, bulb, amount, lastRound: () => { const d = derive(); return d.loading ? d0.N : d.N; },
        onStep: (s) => {
          if (s === 'allow') twoSteps = true;
          L.busy = STEP_LABEL[s] || L.busy;
          if (s === 'catchup') say('The game is still reading his latest rounds. Your wallet asks once to let it catch up, then for your bet.', null, 600_000);
          if (s === 'catching') say('The game is catching up…', null, 600_000);
          if (s === 'allow') say(`Step 1 of 2: allow the game to take exactly ${sqkText(amount)} SQK. Your wallet will ask.`, null, 600_000);
          if (s === 'allowing') say('Step 1 of 2: waiting for the network…', null, 600_000);
          if (s === 'bet') say(`${twoSteps ? 'Step 2 of 2: place' : 'Place'} your bet of ${sqkText(amount)} SQK on bulb ${bulb}. Your wallet will ask.`, null, 600_000);
          if (s === 'betting') say('Placing your bet…', null, 600_000);
          L.lastDash = -1;
        },
        // the other steps can take a while: check the bulb again right before the bet goes out
        beforeBet: async () => { tooClose(bulb); },
      });
      Board.sfx.bet();
      say(`Bet placed: ${sqkText(amount)} SQK on bulb ${bulb}, ${FOR_TEXT[derive().win.night] || 'for this ride'}.`, null, 30_000);
    } catch (e) {
      if (e.tooClose) return say(`Bulb ${e.was} got too close while you were confirming, so the bet wasn't sent. The game is still allowed to take exactly ${sqkText(amount)} SQK; press the button again for bulb ${e.floor} or higher.`, null, 30_000);
      throw e;
    } finally {
      for (const k of ['game', 'mine']) schedule(k);
      loop();
    }
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
      Board.sfx.coin();
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
      say('Confirm in your wallet: 1,000 practice SQK for you (only the network fee, in test ETH).');
      const hash = await wallet.send(L.account, config.sqk, '0xde5f72fd'); // faucet()
      say('Getting your practice SQK…', hash);
      const r = await wallet.waitReceipt(hash);
      say(r.ok ? 'You got 1,000 practice SQK.' : r.timeout ? 'Still waiting for the network. Your practice SQK will show up soon.' : 'That didn\'t work. Please try again.', hash);
    } catch {
      say('Nothing was sent.');
    } finally {
      L.busy = null; L.lastDash = -1;
      schedule('mine'); loop();
    }
  }

  // ---------------------------------------------------------------- wiring

  async function start() {
    if (wallet && config.practice) $('faucet').addEventListener('click', getPractice);
    if (wallet) {
      wallet.on('accountsChanged', (a) => { L.account = Array.isArray(a) && a[0] ? a[0] : null; L.my = new Map(); L.myLogs = false; L.balance = null; checkChain().then(() => { schedule('mine'); loop(); }); });
      wallet.on('chainChanged', () => { checkChain().then(() => { schedule('mine'); loop(); }); });
      try { const a = await wallet.accounts(); if (a[0]) { L.account = a[0]; await checkChain(); } } catch { /* not connected yet */ }
    }
    refreshAll();
    L.timer = setInterval(loop, 5000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) loop(); });
  }

  return {
    start,
    enter() {
      L.active = true; L.lastDash = -1;
      $('replayControls').hidden = true; $('results').hidden = true;
      $('act').hidden = !hasGame; $('soon').hidden = hasGame; $('amountRow').hidden = !hasGame; $('amtOther').hidden = !hasGame;
      $('playersPanel').hidden = !hasGame;
      setText('eyebrow', hasGame ? (config.practice ? 'Squeekchain · live rehearsal · practice SQK' : 'Squeekchain · live on the test network') : 'Squeekchain · live · betting opens soon');
      for (const id of ['b50', 'b100', 'b200']) $(id).setAttribute('aria-pressed', String($(id).dataset.bet === L.amountText));
      $('amtOther').value = ['50', '100', '200'].includes(L.amountText) ? '' : L.amountText;
      Board.resetAnimations();
      L.lastLit = null; L.lastOpen = null;
      $('status').dataset.key = '';
      loop();
    },
    exit() { L.active = false; },
    view,
    minus() { const d = derive(); if (!d.loading && !d.mine) { L.pick = Math.max(d.win.floor, shown(d) - 1); Board.sfx.tick(); L.lastDash = -1; } },
    plus() { const d = derive(); if (!d.loading && !d.mine) { L.pick = Math.min(24, shown(d) + 1); Board.sfx.tick(); L.lastDash = -1; } },
    amount(v, typed) {
      L.amountText = String(v);
      for (const id of ['b50', 'b100', 'b200']) $(id).setAttribute('aria-pressed', String(!typed && $(id).dataset.bet === L.amountText));
      if (!typed) $('amtOther').value = '';
      L.lastDash = -1;
    },
    act,
    board(clientX) {
      const d = derive();
      if (d.loading || d.mine) return;
      const lit = d.open ? d.lit : 0, k = Board.bulbAt(clientX, lit);
      if (k) { L.pick = Math.max(d.win.floor, k); Board.sfx.tick(); L.lastDash = -1; }
    },
    // for tests and the console: what the page knows right now, and read everything again now
    debug: () => ({ derived: derive(), state: L }),
    refresh: refreshAll,
  };
}
