// "Watch a past night": the approved prototype's replay of one of Squeektoshi's real nights with nine pretend
// players, moved onto the shared board. Nothing here touches a wallet or the chain; the settlement is engine.js.
import * as Lights from './engine.js';
import * as Board from './board.js';
import { odds as oddsOf, runTime, bestCase } from './live-model.js';

const PRE = 5, SPR_SECS = 3, MAX_BULB = Lights.MAX_BULB;
const PLAYERS = [
  { name: 'Pip', bet: 50, bulb: 1 }, { name: 'Hazel', bet: 100, bulb: 2 }, { name: 'Mochi', bet: 200, bulb: 3 },
  { name: 'Biscuit', bet: 100, bulb: 4 }, { name: 'Nutmeg', bet: 50, bulb: 5 }, { name: 'Clover', bet: 100, bulb: 7 },
  { name: 'Peanut', bet: 200, bulb: 10 }, { name: 'Truffle', bet: 100, bulb: 14 }, { name: 'Sleepy Sam', bet: 50, bulb: 19 },
];
// The pretend players bet before he starts, so their bets always count. Played night after night, a night nobody
// wins (a false start) hands their stakes on as the next night's bonus pot.
const PLAYERS_ROUND = -1;
const wei = (sqkAmount) => BigInt(sqkAmount) * Lights.WEI;
const sqk = (weiAmount) => Number(weiAmount) / 1e18; // for display only
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const signed = (v) => (v > .5 ? `+${fmt(v)}` : v < -.5 ? `−${fmt(-v)}` : '±0');
const bulbs = (n) => `${n} bulb${n === 1 ? '' : 's'}`;
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
// the last item (no Array.prototype.at: older phone browsers, iOS 15.0-15.3 and Chrome before 92, don't have it)
const lastOf = (list) => list[list.length - 1];
// only the win / lose classes of an amount change: the 'tick' that settles a changed number stays
const tone = (el, c) => { for (const k of ['win', 'lose']) if (el.classList.contains(k) !== (c === k)) el.classList.toggle(k, c === k); };

export function createReplay({ $, setText, setStatus }) {
  let DATA = { rides: [], odds: [] }, POT_IN = new Map();
  const S = { ride: null, t: -PRE, speed: 2, bet: 100, pick: 6, prevR: -99, players: [], you: null, over: false, outAt: null,
    result: null, potIn: 0n, carry: null, nextBet: null, timeNow: 0, active: false };

  const len = () => S.ride.w.length;
  const active = (r) => r >= 0 && r < len() && S.ride.w[r] > 0;
  const litBy = (r) => Lights.litBy(S.ride.w, r);
  const clockAt = (r) => new Date(Date.parse(S.ride.utc) + r * 600e3);
  const bets = () => [...S.players, ...(S.you ? [S.you] : [])];
  const nowRound = () => Math.floor(S.t / SPR_SECS);
  const betRound = () => Lights.betRoundAt(S.t / SPR_SECS);
  const forNext = () => Lights.forNextRide(S.ride.w, betRound());
  const nextRide = () => DATA.rides.find((x) => x.n === S.ride.n + 1);
  const minBulb = () => Lights.minBulb(S.ride.w, Math.min(betRound(), len() + 1), nowRound());
  const toBets = (list) => list.map((p) => ({ stake: wei(p.bet), bulb: p.bulb, betRound: p.betRound }));
  const handsOn = () => { const s = Lights.settleRide(S.ride.w, toBets(bets()), S.potIn); return s.result === 'rolled' ? s.bonusOut : 0n; };
  const oddsFor = (k) => DATA.odds.find((o) => o.bulb === k);
  // the best case for a bet on bulb k (payoutAt(n) = what it gets if the lights go out right after bulb n): it holds
  // while he lights k up to some bulb; a higher bet that lights too takes a slice
  // (worked out again only when what it depends on changes: the dashboard is drawn every frame)
  const memo = { key: null, label: '' };
  const bestLabel = (k, payoutAt, key) => {
    if (memo.key === key) return memo.label;
    const best = payoutAt(k);
    let hi = k;
    while (hi < MAX_BULB && payoutAt(hi + 1) === best) hi++;
    return Object.assign(memo, { key, label: bestCase(k, hi) }).label;
  };

  // rides: [{ n, start, utc, C, lit, w }], every one closed
  function setRides(rides) {
    const list = rides.map((r) => ({ n: r.n, start: r.start, utc: r.utc, C: r.C, stops: r.lit, w: r.w }));
    if (DATA.rides.length === list.length && DATA.rides.every((r, i) => r.start === list[i].start)) return;
    DATA = { rides: list, odds: oddsOf(rides) };
    POT_IN = Lights.potChain(DATA.rides, PLAYERS.map((p) => ({ stake: wei(p.bet), bulb: p.bulb, betRound: PLAYERS_ROUND })));
    // a night being replayed keeps playing; it is the same night in the new list
    if (S.ride) S.ride = DATA.rides.find((r) => r.n === S.ride.n && r.start === S.ride.start) || S.ride;
    fillRides();
    fillOdds();
  }

  function startRide(n) {
    S.ride = DATA.rides.find((r) => r.n === n) || DATA.rides[DATA.rides.length - 1];
    if (!S.ride) return;
    // a night after one you just played to a rollover starts with that night's pot (your bet included), and a bet
    // you placed while the lights went out on the night before is yours here, placed before he started
    const carry = S.carry && S.carry.n === S.ride.n ? S.carry : null;
    const potIn = carry ? carry.pot : POT_IN.get(S.ride.n) || 0n;
    const you = carry && carry.bet ? { ...carry.bet } : null;
    if (carry) carry.bet = null; // used once: playing it again starts fresh
    Object.assign(S, { t: -PRE, prevR: -99, you, nextBet: null, over: false, outAt: null, result: null, potIn });
    S.players = PLAYERS.map((p) => ({ ...p, betRound: PLAYERS_ROUND }));
    Board.resetAnimations();
    $('results').hidden = true; $('pickRow').hidden = !!you; $('status').textContent = '';
    setPick(you ? you.bulb : 6); updateButton(); renderPlayers(); updateDash(0);
  }

  // What everyone gets if the lights go out right after bulb `lit`, as far as anyone can tell now; at the blackout
  // this is the real settlement. Amounts in SQK for display; the engine works in wei.
  function split(lit, list, ride = S.ride, r = nowRound(), potIn = S.potIn) {
    const s = Lights.settleIf(ride.w, r, lit, toBets(list), potIn);
    const out = list.map((p, i) => ({ p, cls: s.classes[i], won: s.classes[i] === 'win', payout: sqk(s.payouts[i]) }));
    return { out, lit, result: s.result, lost: sqk(s.lost), staked: sqk(s.winStake + s.lost), burned: sqk(s.burned), bonusOut: s.bonusOut };
  }

  function setPick(b) {
    S.pick = Math.max(minBulb(), Math.min(MAX_BULB, b));
    $('bPick').textContent = S.pick;
    const o = oddsFor(S.pick);
    setText('pickOdds', o ? `Bulb ${S.pick} · ${runTime(S.pick)} · lit on ${o.pct}% of his nights` : '');
    $('pickOdds').title = o ? `${o.lit} of his ${o.total} nights` : '';
    updateButton();
  }
  // the last 60 s of the blackout count as the next ride's first round, which may be its departure: no bets then
  const lastMoment = () => betRound() > len() + 1;
  function act() {
    if (S.over || S.you || S.nextBet || lastMoment()) return;
    if (S.pick < minBulb()) setPick(minBulb());
    if (S.pick > MAX_BULB) return;
    if (forNext()) {
      const next = nextRide(); if (!next) return;
      S.nextBet = { name: 'You', me: true, bet: S.bet, bulb: S.pick, betRound: S.ride.start + betRound() - next.start };
      S.carry = { n: next.n, pot: handsOn(), bet: S.nextBet };
    } else S.you = { name: 'You', me: true, bet: S.bet, bulb: S.pick, betRound: betRound() };
    $('pickRow').hidden = true; Board.sfx.bet();
    updateButton(); renderPlayers(); updateDash(Math.max(0, nowRound()));
  }
  function updateButton() {
    if (!S.ride) return;
    const b = $('act'), none = !S.over && !S.you && !S.nextBet && forNext() && !nextRide();
    const off = S.over || !!S.you || !!S.nextBet || none || lastMoment();
    if (b.disabled !== off) b.disabled = off;
    setText('act', S.over ? 'Lights out' : S.you || S.nextBet ? 'Bet placed' : none ? 'No next ride' : `Bet on bulb ${S.pick}`);
  }

  function renderPlayers() {
    const r = Math.max(0, nowRound()), lit = S.t < 0 ? 0 : litBy(r - 1), box = $('riders'); box.textContent = '';
    box.dataset.key = ''; // (live mode keys its own list; this one is the replay's)
    const note = document.createElement('p'); note.className = 'empty';
    note.textContent = `His run is real. These ${PLAYERS.length} players are made up, so you can see how the pot is shared.`;
    box.append(note);
    const list = bets().slice().sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0) || a.bulb - b.bulb);
    for (const p of list) {
      const row = document.createElement('div'), who = document.createElement('div'), name = document.createElement('b'), small = document.createElement('small'), amt = document.createElement('div');
      row.className = `rider${p.me ? ' me' : ''}`; who.className = 'who'; amt.className = 'amt';
      name.textContent = p.me ? 'You' : p.name;
      if (S.over) {
        const o = S.result.out.find((x) => x.p === p), d = o.payout - p.bet;
        row.dataset.st = o.cls === 'win' ? (d < -.5 ? 'short' : 'won') : o.cls === 'lose' ? 'caught' : 'refund';
        small.textContent = o.cls === 'win' ? `bulb ${p.bulb} lit${d < -.5 ? ` · got back ${fmt(o.payout)}` : ''}` : o.cls === 'refund' ? `bulb ${p.bulb} lit too soon · bet back`
          : S.result.result === 'rolled' ? `bulb ${p.bulb} stayed dark · rolls over` : `bulb ${p.bulb} stayed dark`;
        amt.textContent = d > .5 ? `+${fmt(d)}` : d < -.5 ? `−${fmt(-d)}` : '±0'; amt.className = `amt ${d > .5 ? 'win' : d < -.5 ? 'lose' : ''}`;
      } else {
        row.dataset.st = p.bulb <= lit ? 'lit' : 'riding';
        small.textContent = p.bulb <= lit ? `bulb ${p.bulb} lit` : `bulb ${p.bulb} · ${p.bulb - lit} to go`;
        amt.textContent = fmt(p.bet);
      }
      who.append(name, small); row.append(document.createElement('i'), who, amt); box.append(row);
    }
  }

  function updateDash(r) {
    const L = len(), w = r >= 0 && r < L ? S.ride.w[r] : 0, clock = hhmm(clockAt(Math.max(0, S.t / SPR_SECS)));
    const potNote = S.potIn > 0n ? ` Bonus pot from the night before: ${fmt(sqk(S.potIn))} SQK.` : '';
    setText('caption', S.t < 0 ? `Replaying one of his real nights (${day(new Date(S.ride.utc))}). He starts running at ${hhmm(clockAt(0))} your time.${potNote}`
      : S.over ? `Blackout at ${hhmm(clockAt(L))} your time, ${S.result.lit ? `after ${bulbs(S.result.lit)}` : 'before the first bulb'}.`
        + (S.result.result === 'rolled' ? ` Bonus pot for the next night: ${fmt(sqk(S.result.bonusOut))} SQK.` : '')
      : w > 0 ? `${clock} · Squeektoshi is running: ${w} turns in these 10 minutes.` : `${clock} · Squeektoshi is resting: no turns in these 10 minutes.`);
    updateButton();
    if (S.over) return;
    const lit = S.t < 0 ? 0 : litBy(r - 1), y = S.you, money = $('money');
    const showMoney = (v) => { setText('money', signed(v)); tone(money, v > .5 ? 'win' : v < -.5 ? 'lose' : ''); };
    if (S.nextBet || (!y && forNext())) {
      const next = nextRide(), b = S.nextBet;
      setText('youState', b ? `Bulb ${b.bulb}` : `Bulb ${S.pick}?`);
      setText('youSub', b ? `next ride · bet ${b.bet}` : 'Tap a bulb on the board, or use − and +');
      if (!next) {
        setText('moneyLabel', 'Next ride'); setText('money', '–'); tone(money, ''); setText('moneySub', 'not in this replay');
        setStatus('The lights are going out. This is the last night in the replay, so there is no next ride to bet on.');
        return;
      }
      if (!b && S.pick < minBulb()) setPick(minBulb());
      const me = b || { bet: S.bet, bulb: S.pick, me: true, betRound: S.ride.start + Math.min(betRound(), len() + 1) - next.start };
      const crowd = PLAYERS.map((p) => ({ ...p, betRound: PLAYERS_ROUND }));
      const pot = b && S.carry ? S.carry.pot : handsOn(), atAll = (n) => split(n, [...crowd, me], next, me.betRound, pot).out;
      const at = (n) => lastOf(atAll(n)).payout;
      setText('moneyLabel', bestLabel(me.bulb, at, `next|${next.n}|${me.bulb}|${me.bet}|${me.betRound}|${pot}`)); showMoney(at(me.bulb) - me.bet);
      setText('moneySub', 'on the next ride, with the bets so far');
      setStatus('This bet is for the next ride.');
      return;
    }
    if (!y) {
      if (S.pick < minBulb()) setPick(minBulb());
      setText('youState', `Bulb ${S.pick}?`); setText('youSub', 'Tap a bulb on the board, or use − and +');
      const list = [...S.players, { bet: S.bet, bulb: S.pick, me: true, betRound: betRound() }], at = (n) => lastOf(split(n, list).out).payout;
      setText('moneyLabel', bestLabel(S.pick, at, `pick|${S.ride.n}|${S.pick}|${S.bet}|${betRound()}|${nowRound()}|${S.potIn}`)); showMoney(at(S.pick) - S.bet);
      setText('moneySub', 'with the bets so far');
      setStatus(S.t < 0 ? 'Pick a bulb and a bet before the lights come on.' : `The lights are on. You can still bet on bulb ${minBulb()} or higher.`);
      return;
    }
    if (y.bulb > lit) {
      const left = y.bulb - lit, list = bets(), at = (n) => split(n, list).out.find((o) => o.p === y).payout;
      setText('youState', `Bulb ${y.bulb}`); setText('youSub', `${left} bulb${left === 1 ? '' : 's'} to go · bet ${y.bet}`);
      setText('moneyLabel', bestLabel(y.bulb, at, `you|${S.ride.n}|${y.bulb}|${y.bet}|${y.betRound}|${nowRound()}|${S.potIn}`)); showMoney(at(y.bulb) - y.bet);
      setText('moneySub', 'with the bets so far');
      setStatus(left === 1 ? 'One more bulb! He needs to keep running about 10 more minutes.' : `He needs to light ${left} more bulbs, about ${left * 10} minutes of running.`);
    } else {
      const nowO = split(lit, bets()).out.find((o) => o.p === y);
      setText('youState', `Bulb ${y.bulb} lit`); setText('youSub', `bet ${y.bet}`);
      setText('moneyLabel', 'If the lights go out now'); showMoney(nowO.payout - y.bet);
      setText('moneySub', `you would get back ${fmt(nowO.payout)} SQK`);
      setStatus('Your bulb is lit. Each new bulb shifts more of the pot to higher bulbs.');
    }
  }

  function blackout(time) {
    const L = len();
    S.over = true; S.outAt = time; S.result = split(litBy(L - 1), bets()); Board.sfx.out(); updateButton(); renderPlayers(); updateDash(nowRound());
    const res = S.result, me = res.out.find((o) => o.p.me), lit = res.lit, count = (c) => res.out.filter((o) => o.cls === c).length;
    const winners = count('win'), losers = count('lose'), refunds = count('refund'), pot = sqk(S.potIn), rolled = res.result === 'rolled';
    const gain = me ? me.payout - me.p.bet : 0, next = nextRide();
    // the next night starts with what this one hands on, and with your bet if you placed one for it
    const waiting = S.nextBet || (next && S.carry && S.carry.n === next.n ? S.carry.bet : null);
    if (rolled || S.nextBet) S.carry = next ? { n: next.n, pot: res.bonusOut, bet: waiting } : null;
    const b = me && me.p.bulb, staked = me && me.p.bet;
    $('resYou').textContent = !me ? (lit ? `Blackout after ${bulbs(lit)}` : 'Blackout before the first bulb')
      : me.cls === 'refund' ? `Bulb ${b} lit too soon after your bet, so you get your bet back`
      : me.cls === 'lose' ? (rolled ? `Bulb ${b} stayed dark: your ${fmt(staked)} SQK rolls into the next night's pot` : `Bulb ${b} stayed dark: you lost ${fmt(staked)} SQK`)
      : gain > .5 ? `Bulb ${b} lit: you won +${fmt(gain)} SQK`
      : gain < -.5 ? `Bulb ${b} lit, but higher bulbs took most of the pot: −${fmt(-gain)} SQK`
      : `Bulb ${b} lit: you get about your ${fmt(staked)} SQK back`;
    $('resYou').className = `result ${me ? (gain > .5 ? 'win' : gain < -.5 ? 'lose' : '') : ''}`;
    const head = lit ? `He lit ${bulbs(lit)} before falling asleep.` : 'He fell asleep before the first bulb.';
    const late = refunds ? ` ${refunds} bet${refunds === 1 ? ' was' : 's were'} sent too late for ${refunds === 1 ? 'its' : 'their'} bulb and got the bet back.` : '';
    const when = next ? `${day(new Date(next.utc))} ${hhmm(new Date(next.utc))}, pick it above` : '';
    const where = next ? `the next night (${when})` : 'the next night';
    const yours = S.nextBet ? ` Your ${fmt(S.nextBet.bet)} SQK bet on bulb ${S.nextBet.bulb} is for the next ride${rolled ? '' : ` (${when})`}.` : '';
    $('resNote').textContent = rolled
      ? `${head} No bulb won, so the whole pot rolls over to the next night as a bonus pot. ${fmt(sqk(res.bonusOut))} SQK now waits for ${where}.${late}${yours}`
      : `${head} The ${winners} bet${winners === 1 ? '' : 's'} on lit bulbs shared the pot: ${fmt(res.staked)} SQK of bets${pot ? ` plus the ${fmt(pot)} SQK bonus pot` : ''}${res.burned >= .5 ? `, less ${fmt(res.burned)} SQK burned` : ''}. ${losers ? `${losers} bet${losers === 1 ? ' was on a higher bulb' : 's were on higher bulbs'} and lost.` : 'No bet lost.'}${late}${yours}`;
    if (me && gain > .5) Board.coinShower(time);
    const reduced = Board.reducedMotion();
    setTimeout(() => { if (S.active && S.over) $('results').hidden = false; }, reduced ? 0 : 2600);
    setStatus('Blackout. See how it went below, or pick another night.');
  }

  // One frame: move the replay clock, then describe the board.
  function view(time, step) {
    if (!S.ride) return { lit: 0, resting: true, msg: 'NO NIGHTS TO REPLAY YET' };
    if (!S.over) S.t += step * S.speed;
    const L = len(), r = nowRound();
    if (r !== S.prevR && S.t >= 0) {
      for (let q = Math.max(0, S.prevR); q < r; q++) {
        if (q >= 1 && q < L && active(q)) { const k = litBy(q); Board.spark(k, time); Board.sfx.zap(); if (S.you && S.you.bulb === k) setTimeout(() => Board.sfx.coin(), Board.LIGHT.on * 1000); }
      }
      S.prevR = r;
      if (!S.over) renderPlayers();
    }
    if (!S.over && r >= L + 2) blackout(time);
    if (!S.over) updateDash(Math.max(0, r));
    const lit = S.t < 0 ? 0 : S.over ? S.result.lit : litBy(r - 1);
    const resting = S.t < 0 || (r >= 1 && !active(r)) || S.over, work = r >= 0 && r < L ? S.ride.w[r] : 0;
    const outP = S.over ? (time - S.outAt) / Board.outSeconds(S.result.lit) : null; // 0 -> 1: bulbs pop off from the last one down
    const pot = S.over ? (S.result.result === 'rolled' ? S.result.bonusOut : 0n) : S.potIn, potN = pot > 0n ? Math.round(sqk(pot)) : 0;
    const at = new Map();
    for (const p of bets()) { const a = at.get(p.bulb) || { bulb: p.bulb, me: false, others: 0 }; if (p.me) a.me = true; else a.others++; at.set(p.bulb, a); }
    // The sign: short words that stay while the night does the same thing. On a phone the sign is 99 dots across: up to
    // 16 letters stand still and change at once; a longer message scrolls, and the next one waits until it has passed
    // (a replay at 2x lights a bulb every 1.5 s). Only the blackout, the last word of the night, is long.
    const msg = S.t < 0 ? 'PLACE YOUR BETS'
      : S.over && S.result.result === 'rolled' ? `BLACKOUT ${lit ? `AFTER ${bulbs(lit)}` : 'BEFORE BULB 1'} * NOBODY WON * BONUS POT ${potN} ROLLS ON`
      : S.over ? `BLACKOUT AFTER ${bulbs(lit)} * SWEET DREAMS`
      : r === 0 ? 'WARMING UP' : !active(r) ? (r >= L ? 'IS HE ASLEEP?' : 'SHORT BREAK')
      : `NEXT: BULB ${lit + 1}`;
    // (waitSign: a replay's news comes fast, so the sign may let a long message finish before the next; live mode never
    // sets it, its news replaces the old message at once)
    return { lit, resting, pace: work, speedMul: S.speed, pot: potN, markers: [...at.values()], pick: S.you ? S.you.bulb : S.over ? 0 : S.pick,
      outP, msg, flicker: r >= 1 && !active(r) && !S.over, waitSign: true };
  }

  function fillRides() {
    const sel = $('ride'), keep = sel.value;
    sel.textContent = '';
    // every night, false starts too: that is where a bonus pot comes from
    for (const r of DATA.rides.slice().sort((a, b) => b.n - a.n)) {
      const o = document.createElement('option'), d = new Date(r.utc); o.value = r.n;
      o.textContent = `${day(d)} ${hhmm(d)} · ${bulbs(r.stops)}${POT_IN.get(r.n) ? ' · bonus pot' : ''}`;
      sel.append(o);
    }
    // the latest night that lit a few bulbs, so a first look shows the lights coming on
    const pick = keep && DATA.rides.some((r) => String(r.n) === keep) ? keep : String((DATA.rides.slice().reverse().find((r) => r.stops >= 3) || DATA.rides[DATA.rides.length - 1] || {}).n || '');
    sel.value = pick;
  }
  function fillOdds() {
    const box = $('odds'), byN = new Map(DATA.odds.map((o) => [o.bulb, o.pct]));
    box.textContent = '';
    for (let n = 1; n <= 21; n++) { const d = document.createElement('div'), v = byN.get(n) || 0; d.style.height = `${Math.max(4, v)}%`; d.title = `bulb ${n}: ${v}% of nights`; box.append(d); }
    const first = DATA.rides[0];
    const since = first ? day(new Date(first.utc)) : '';
    setText('oddsNote', `From his ${DATA.rides.length} real runs since ${since}: ${byN.get(3)}% lit bulb 3, ${byN.get(10)}% lit bulb 10. Evening runs go furthest.`);
  }

  return {
    setRides,
    odds: () => DATA.odds,
    enter() {
      S.active = true;
      $('replayControls').hidden = false; $('amtOther').hidden = true; $('soon').hidden = true; $('act').hidden = false; $('amountRow').hidden = false; $('amtLabel').hidden = false;
      $('walletLine').hidden = true; $('minePanel').hidden = true; $('playersPanel').hidden = false;
      setText('playersTitle', 'Pretend players');
      for (const id of ['b50', 'b100', 'b200']) $(id).setAttribute('aria-pressed', String(+$(id).dataset.bet === S.bet));
      setText('eyebrow', 'Squeekchain · a replay of a real night'); $('liveDot').dataset.on = 'false';
      startRide(+$('ride').value);
    },
    exit() { S.active = false; $('results').hidden = true; $('replayControls').hidden = true; },
    view,
    minus() { if (!S.you && !S.nextBet) { setPick(S.pick - 1); updateDash(Math.max(0, nowRound())); } },
    plus() { if (!S.you && !S.nextBet) { setPick(S.pick + 1); updateDash(Math.max(0, nowRound())); } },
    amount(v) {
      if (S.you || S.nextBet || ![50, 100, 200].includes(v)) return;
      S.bet = v; for (const id of ['b50', 'b100', 'b200']) $(id).setAttribute('aria-pressed', String(+$(id).dataset.bet === v));
      updateDash(Math.max(0, nowRound()));
    },
    act,
    board(clientX) {
      if (S.you || S.nextBet || S.over || !S.ride) return;
      const lit = S.t < 0 ? 0 : litBy(nowRound() - 1), k = Board.bulbAt(clientX, lit);
      if (k) { setPick(k); Board.sfx.tick(); updateDash(Math.max(0, nowRound())); }
    },
    again() { startRide(+$('ride').value); },
    ride() { startRide(+$('ride').value); },
    speed(x) { S.speed = x; for (const j of ['sp1', 'sp2', 'sp4']) $(j).setAttribute('aria-pressed', String(+$(j).dataset.sp === x)); },
  };
}
