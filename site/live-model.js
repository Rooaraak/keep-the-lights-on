// What the live page works out from what it reads: his nights, tonight so far, the lowest bulb a bet can safely
// pick, which night a bet counts for, the bets per bulb, the bonus pot and what each bet gets. Pure functions with
// no network or DOM, so tests can run them on recorded rounds. The settlement itself is engine.js, the same rules
// as contracts/src/LightsMath.sol (held to data/lights-vectors.json by test/engine.test.mjs).
import * as Lights from './engine.js';

export const ROUND_SECONDS = 600;
export const GUARD_SECONDS = 60; // LightsOn: a bet in the last 60 s of a round counts as sent in the next one
// The wallet takes a while to ask, sign and get the bet into a block. The lowest bulb is worked out for a bet that
// lands up to this long from now, so a slow wallet can't push it into a round where that bulb would be too close.
export const SEND_MARGIN_SECONDS = 45;

export const roundAt = (t, G) => (t < G ? 0 : Math.floor((t - G) / ROUND_SECONDS) + 1);
export const roundStart = (r, G) => G + (r - 1) * ROUND_SECONDS;

// ---------- his nights ----------
// A night departs on the first active round after a blackout (the departure lights nothing). Every later active
// round lights the next bulb, one quiet round is a break, two in a row are the blackout (C = the first). A night
// ends at its STATION round at the latest. The same walk as LightsOn's walker and sim/rides.mjs.
// base = { rides, settledThrough } with every ride closed; active = [{ id, work }] for rounds after
// base.settledThrough. Returns { rides, open, settledThrough } where open = { start, w, idleRun } or null; w[i] is
// his turns in round start + i, through `settledThrough`.
export function walkNights(base, active, settledThrough, station = 36) {
  const rides = base.rides.map((r) => withBetWindow(r, station));
  const work = new Map(active.filter((a) => a.id > base.settledThrough && a.id <= settledThrough && a.work > 0).map((a) => [a.id, a.work]));
  let open = null, n = rides.length ? rides[rides.length - 1].n : 0;
  const close = (end, C) => {
    const w = end === 'blackout' ? open.w.slice(0, C - open.start) : open.w.slice();
    rides.push(withBetWindow({ n: ++n, start: open.start, end, C: end === 'blackout' ? C : null, lit: Lights.litBy(w, w.length - 1), w }, station));
    open = null;
  };
  for (let r = base.settledThrough + 1; r <= settledThrough; r++) {
    const turns = work.get(r) || 0;
    if (!open) {
      if (turns > 0) open = { start: r, w: [turns], idleRun: 0 };
      continue;
    }
    open.w.push(turns);
    const last = open.start + station - 1;
    if (turns > 0) {
      open.idleRun = 0;
      if (r === last) close('station');
    } else {
      open.idleRun++;
      if (open.idleRun === 2) close('blackout', r - 1);
      else if (r === last) close('station');
    }
  }
  return { rides, open, settledThrough };
}

// A closed night takes bets sent up to its lastBetRound: C - 1 after a blackout (bets sent in C and C + 1 are for
// the next ride), its last round after a STATION end.
function withBetWindow(r, station) {
  const lastBetRound = r.end === 'blackout' ? r.C - 1 : r.start + station - 1;
  return { ...r, lit: r.lit ?? Lights.litBy(r.w, r.w.length - 1), lastBetRound };
}

export const litOf = (open) => (open ? Lights.litBy(open.w, open.w.length - 1) : 0);

// Share of his nights that lit each bulb (false starts count as nights that lit nothing).
// How long he has to run to light bulb k (one bulb per 10 minutes of running): 30 min, 1 hour, 1 h 20 min, 2 hours.
export function runTime(k) {
  if (k < 6) return `${k * 10} min`;
  const h = Math.floor(k / 6), m = (k % 6) * 10;
  return m ? `${h} h ${m} min` : `${h} hour${h > 1 ? 's' : ''}`;
}

export function odds(rides) {
  const total = rides.length, out = [];
  for (let k = 1; k <= Lights.MAX_BULB; k++) {
    const lit = rides.filter((r) => r.lit >= k).length;
    out.push({ bulb: k, lit, total, pct: total ? Math.round((lit / total) * 100) : 0 });
  }
  return out;
}

// ---------- the lowest bulb, and which night a bet counts for ----------
// S = last round SqueekCore has recorded, cur = the round in progress, N = the round a bet sent now would count
// in (time + guard band + the sending margin). Rounds S + 1 .. N + 1 are not known yet. A bet is refunded if its
// bulb lights in N + 1 or earlier, and each unknown round can light at most one bulb, so the worst case is every
// unknown round running:
//   a night is open:   floor = lit so far + unknown rounds + 1
//   no night is open:  floor = unknown rounds (the first running round is a departure and lights nothing)
// Then the bulb offered is never refunded, whatever he does. (A blackout could also send the bet to his next ride;
// its floor there is always lower, so this one covers both.)
// One exception, from the spec: before he starts, bulb 1 may be picked when the only way it could be refunded is
// him starting in the very round the bet is sent (the wheel's fresh reading must say he isn't running now).
// The last two rounds of a STATION night (departure + STATION - 2 and - 1, the 35th and 36th) take no bets: a bet
// there joins that night but at most one more bulb can light, so it could only be given back or lose (audit M4).
// Returns { floor, unknown, night, bulb1Risk, closing } with night = 'tonight' | 'either' | 'next'; floor 99 = none.
export function betWindow({ S, cur, N, open, wheel, station = 36 }) {
  const unknown = Math.max(1, N + 1 - S);
  const running = !!(wheel && wheel.fresh && wheel.running);
  const stopped = !!(wheel && wheel.fresh && !wheel.running);
  if (open && N - open.start >= station - 2) return { floor: 99, unknown, night: 'tonight', bulb1Risk: false, closing: true };
  if (open) {
    return { floor: litOf(open) + unknown + 1, unknown, night: running ? 'tonight' : 'either', bulb1Risk: false };
  }
  const floor = Math.max(1, unknown);
  if (floor === 2 && S === cur - 1 && N === cur && stopped) return { floor: 1, unknown, night: 'next', bulb1Risk: true };
  return { floor, unknown, night: 'next', bulb1Risk: false };
}

// The round a bet sent at chain time t counts in, and the latest it could count in once the wallet is done.
export const betRoundNow = (t, G) => roundAt(t + GUARD_SECONDS, G);
export const betRoundSent = (t, G) => roundAt(t + GUARD_SECONDS + SEND_MARGIN_SECONDS, G);

// ---------- bets ----------
// Bets (from LightsOn.getBet, sorted by betRound like the contract keeps them) go to the first closed night whose
// lastBetRound is at or after the bet's round; the rest are tonight's (the open night, or the next to depart).
// Returns { byRide: Map(ride n -> bets), current: bets }.
export function groupBets(bets, rides) {
  const byRide = new Map(), current = [];
  let i = 0;
  const sorted = rides.slice().sort((a, b) => a.start - b.start);
  for (const b of bets.slice().sort((x, y) => x.betRound - y.betRound || x.id - y.id)) {
    while (i < sorted.length && sorted[i].lastBetRound < b.betRound) i++;
    if (i < sorted.length) {
      const n = sorted[i].n;
      if (!byRide.has(n)) byRide.set(n, []);
      byRide.get(n).push(b);
    } else current.push(b);
  }
  for (const list of byRide.values()) list.sort((x, y) => x.id - y.id);
  current.sort((x, y) => x.id - y.id);
  return { byRide, current };
}

// Engine bets for one night: rounds relative to its departure.
const toEngine = (list, start) => list.map((b) => ({ stake: b.stake, bulb: b.bulb, betRound: b.betRound - start }));

// Settles, in order, every closed night that has bets the contract hasn't settled yet, starting from the bonus pot
// the contract carries into its first unsettled night. Nights without bets pass the pot on unchanged. Returns
// { potIn: the pot entering tonight, results: Map(bet id -> { cls, payout, ride, result }) }.
export function chainPot(rides, byRide, bonusPot) {
  let pot = bonusPot;
  const results = new Map();
  for (const ride of rides.slice().sort((a, b) => a.start - b.start)) {
    const list = byRide.get(ride.n);
    if (!list || !list.length) continue;
    const s = Lights.settleRide(ride.w, toEngine(list, ride.start), pot);
    list.forEach((b, i) => results.set(b.id, { cls: s.classes[i], payout: s.payouts[i], ride: ride.n, result: s.result }));
    pot = s.bonusOut;
  }
  return { potIn: pot, results };
}

// Stakes per bulb tonight: Map(bulb -> { count, stake, mine }).
export function perBulb(current, me) {
  const out = new Map();
  for (const b of current) {
    const x = out.get(b.bulb) || { count: 0, stake: 0n, mine: false };
    x.count++; x.stake += b.stake; if (me && b.owner.toLowerCase() === me.toLowerCase()) x.mine = true;
    out.set(b.bulb, x);
  }
  return out;
}

// What a bet gets if the lights go out right after bulb `lit`, as far as anyone can tell now. Tonight's night so
// far (open: { start, w }, or null before he starts), the round in progress `cur`, whether he is running in it,
// tonight's bets (with absolute betRound), the bonus pot coming in. `extra` is a bet not placed yet, which is
// returned last. Returns the engine's settlement.
export function estimate({ open, S, cur, running, bets, potIn, lit, extra }) {
  const list = extra ? [...bets, extra] : bets;
  if (!open) {
    // before he starts every bet so far was sent before his departure: bulbs 1..lit light one per round after it
    return Lights.settleIf([1], -1, lit, list.map((b) => ({ stake: b.stake, bulb: b.bulb, betRound: -1 })), potIn);
  }
  const pending = Math.max(0, cur - S - 1);
  const w = [...open.w, ...Array(pending).fill(0), running ? 1 : 0];
  return Lights.settleIf(w, cur - open.start, lit, toEngine(list, open.start), potIn);
}
