// Keep the Lights On: the rules the page runs (docs/lights-on-spec.md, settlement v2), in BigInt wei, the same way
// contracts/src/LightsMath.sol settles a night. sim/check-lights-vectors.mjs holds it to data/lights-vectors.json.
// build-lights.mjs builds this file into the page with `export ` removed, so keep it to top-level consts and
// functions: no imports, no other module syntax.

export const WEI = 10n ** 18n;
export const BURN_BPS = 200n; // 2% of what the winners take from others (losing bets + bonus pot) is burned
export const AHEAD = 2; // a bet counts only if its bulb lights 2 or more rounds after the round it was sent in
export const MAX_BULB = 24;
export const GUARD = 60 / 600; // a bet in the last 60 s of a 600 s round counts as sent in the next round

// ---------- one night ----------
// w[r] = his turns in round r of the night. r = 0 is the departure round (it lights nothing, it starts the
// generator); w ends with the last round before the blackout, so w.length = C - departure. Every later round he
// runs lights the next bulb; a quiet round is a break.

// Bulbs lit by the end of round r.
export function litBy(w, r) {
  let n = 0;
  for (let i = 1; i <= Math.min(r, w.length - 1); i++) if (w[i] > 0) n++;
  return n;
}

// The round each bulb lit in: [null, round of bulb 1, round of bulb 2, ...].
export function bulbRounds(w) {
  const out = [null];
  for (let r = 1; r < w.length; r++) if (w[r] > 0) out.push(r);
  return out;
}

// The round a bet counts as sent in, from the time since the departure in rounds (negative before it).
export const betRoundAt = (roundsSinceStart) => Math.floor(roundsSinceStart + GUARD);

// Which night a bet is in: a night takes bets sent up to C - 1, its last round before the blackout (or its last
// round at a STATION end, where w runs to that round). A bet sent in C or C + 1, the two quiet rounds that end it,
// is for the next ride. With w = this night, N = the round the bet counts as sent in.
export const forNextRide = (w, N) => N >= w.length;

// The lowest bulb a bet can pick that is never refunded, whatever he does next. N = the round the bet counts as
// sent in; r = the round in progress, where anyone watching can see whether he runs. N is r, or r + 1 in the guard
// band. Bulbs that may light in N or N + 1 are refunded. The departure round lights nothing; a round that hasn't
// started yet might light one. A bet sent in C or C + 1 is for the next ride, which departs in C + 2 at the
// earliest, so its bulb 1 lights in C + 3 or later and counts; from C + 2 on, he may be departing in N.
export function minBulb(w, N, r) {
  if (N < 0) return 1;
  if (forNextRide(w, N)) return N <= w.length + 1 ? 1 : AHEAD;
  const mayLight = N >= 1 && (N > r || w[N] > 0);
  return litBy(w, N - 1) + (mayLight ? 1 : 0) + AHEAD;
}

// ---------- settlement ----------
// 'refund' if the bet's bulb lit in the round it was sent or the next one (the bet did not count), 'win' if it lit
// later, 'lose' if it stayed dark. litRound is null for a dark bulb.
export function classify(bet, lit) {
  if (bet.bulb > lit) return 'lose';
  if (bet.litRound == null) throw new Error(`bulb ${bet.bulb} is lit (${lit} lit) but has no round`);
  return bet.litRound < bet.betRound + AHEAD ? 'refund' : 'win';
}

// One night. bets in the order they were placed: [{ stake (wei), bulb, betRound, litRound, litBefore }], where
// litBefore = bulbs lit in rounds before betRound (0 before the departure or in it); lit = bulbs lit at the
// blackout; bonusIn = the pot carried into this night. Refunded bets get their stake back and play no part. Result:
//   'paid'    at least one winner. The pot is every counted stake (winners' and losers') + bonusIn. 2% of what the
//             winners take from others (losing stakes + bonusIn) burns; the winners share the rest by
//             stake x (bulb - litBefore), so a lit bulb can get back less than its stake; losers get 0. With no
//             losers and no pot nothing burns and the winners share their own stakes.
//   'rolled'  no winner: the losing stakes and the pot become the next night's pot (bonusOut); refunds still paid
// Shares are cumulative floors in bet order, as LightsMath does, so payouts + burned + bonusOut == stakes + bonusIn
// to the wei.
export function settle({ lit, bonusIn = 0n, bets, burnBps = BURN_BPS }) {
  const classes = bets.map((b) => classify(b, lit));
  const weight = bets.map((b, i) => {
    if (classes[i] !== 'win') return 0n;
    const before = b.litBefore ?? 0;
    if (before >= b.bulb) throw new Error(`bet ${i}: bulb ${b.bulb} won but ${before} bulbs were lit before it was sent`);
    return b.stake * BigInt(b.bulb - before);
  });
  const sum = (cls) => bets.reduce((a, b, i) => (classes[i] === cls ? a + b.stake : a), 0n);
  const sumW = weight.reduce((a, x) => a + x, 0n), winStake = sum('win'), lost = sum('lose');
  const prize = lost + bonusIn; // what the winners take from others
  const result = sumW === 0n ? 'rolled' : 'paid';
  const burned = result === 'paid' ? (prize * BigInt(burnBps)) / 10000n : 0n;
  const pool = result === 'paid' ? winStake + prize - burned : 0n;
  let cb = 0n;
  const payouts = bets.map((b, i) => {
    if (classes[i] === 'refund') return b.stake;
    if (classes[i] === 'lose') return 0n;
    const share = ((cb + weight[i]) * pool) / sumW - (cb * pool) / sumW;
    cb += weight[i];
    return share;
  });
  return { result, classes, payouts, burned, bonusOut: result === 'rolled' ? prize : 0n, pot: winStake + prize, pool, prize, lost, winStake, sumW };
}

// Settle a night of the replay as if the lights went out right after bulb `lit`, seen from round r: bulbs that
// lit before r keep their rounds, later ones light as early as they could, one a round: from r if he is running
// in it, else from the next round (the departure round and a quiet round in progress light nothing). A bet's
// litBefore counts the bulbs that light before its round in that same picture. With r past the blackout and
// lit = the night's real count, this is the real settlement.
export function settleIf(w, r, lit, bets, bonusIn = 0n) {
  const runningNow = r >= 1 && r < w.length && w[r] > 0;
  const rounds = bulbRounds(w), known = litBy(w, r - 1), first = runningNow ? r : Math.max(r + 1, 1);
  const litRound = (k) => (k > lit ? null : k <= known ? rounds[k] : first + (k - known - 1));
  const before = (N) => { let n = 0; for (let k = 1; k <= lit && litRound(k) < N; k++) n++; return n; };
  return settle({ lit, bonusIn, bets: bets.map((b) => ({ ...b, litRound: litRound(b.bulb), litBefore: before(b.betRound) })) });
}

export const settleRide = (w, bets, bonusIn = 0n) => settleIf(w, w.length + 2, litBy(w, w.length - 1), bets, bonusIn);

// The pot entering each night when only `crowd` plays the nights in order: a night nobody wins hands its stakes
// and its pot to the next one. Returns Map(ride n -> pot in wei).
export function potChain(rides, crowd) {
  const pots = new Map();
  let pot = 0n;
  for (const ride of [...rides].sort((a, b) => a.n - b.n)) {
    pots.set(ride.n, pot);
    pot = settleRide(ride.w, crowd, pot).bonusOut;
  }
  return pots;
}
