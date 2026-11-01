// An independent copy of the settlement rule (docs/lights-on-spec.md, settlement v2), written from the spec and
// contracts/src/LightsMath.sol, NOT from the page's engine.js, so the end-to-end test can hold the page and the
// contract to a third opinion. It is checked against data/lights-vectors.json before it is trusted.
//
// A night, from the rounds the core recorded: the departure is the first active round after a blackout (it lights
// nothing); every later active round lights the next bulb; two quiet rounds in a row are the blackout (C = the
// first); the night ends at its STATION round at the latest. Bets sent up to C - 1 belong to it (up to its last
// round after a STATION end); bets sent in C or C + 1 belong to the next night.

export const BURN_BPS = 200n;

// nights from a set of active rounds (absolute ids) between `after` (exclusive) and `through` (inclusive)
export function nights(active, after, through, station = 36) {
  const out = [];
  let open = null;
  for (let r = after + 1; r <= through; r++) {
    const on = active.has(r);
    if (!open) { if (on) open = { start: r, litRounds: [null], quiet: 0 }; continue; }
    if (on) { open.quiet = 0; open.litRounds.push(r); } else open.quiet++;
    const last = open.start + station - 1;
    if (!on && open.quiet === 2) { out.push(close(open, r - 1, station)); open = null; continue; }
    if (r === last) { out.push(close(open, null, station)); open = null; }
  }
  return { closed: out, open };
}
function close(o, C, station) {
  const spanEnd = C == null ? o.start + station - 1 : C + 1;
  return { start: o.start, C, lit: o.litRounds.length - 1, litRounds: o.litRounds, spanEnd, lastBetRound: C == null ? spanEnd : C - 1 };
}

// which closed night a bet (absolute betRound) belongs to: the first whose lastBetRound >= betRound
export function nightOf(closed, betRound) {
  return closed.findIndex((n) => n.lastBetRound >= betRound);
}

// bulbs lit in rounds strictly before the bet's round (0 before the departure)
export const litBefore = (night, betRound) => night.litRounds.filter((r) => r != null && r < betRound).length;

// The pure rule on one night: bets in the order they were placed, each { stake, bulb, betRound, litRound, litBefore }
// (litRound = the round its bulb lit, or null). Returns { payouts, classes, burned, bonusOut, result }.
export function settle({ lit, bonusIn, bets, burnBps = BURN_BPS }) {
  const classes = bets.map((b) => (b.bulb > lit ? 'lose' : b.litRound <= b.betRound + 1 ? 'refund' : 'win'));
  let sumW = 0n, winStake = 0n, loseStake = 0n;
  const w = [], cb = [];
  bets.forEach((b, i) => {
    w[i] = 0n; cb[i] = 0n;
    if (classes[i] === 'win') {
      if (b.litBefore >= b.bulb) throw new Error(`bet ${i}: a winner whose bulb was lit before it`);
      w[i] = BigInt(b.stake) * BigInt(b.bulb - b.litBefore);
      cb[i] = sumW; sumW += w[i]; winStake += BigInt(b.stake);
    } else if (classes[i] === 'lose') loseStake += BigInt(b.stake);
  });
  const taken = loseStake + BigInt(bonusIn);
  if (sumW === 0n) {
    return { payouts: bets.map((b, i) => (classes[i] === 'refund' ? BigInt(b.stake) : 0n)), classes, burned: 0n, bonusOut: taken, result: 'rolled' };
  }
  const burned = (taken * BigInt(burnBps)) / 10_000n;
  const pool = winStake + taken - burned;
  const payouts = bets.map((b, i) => (classes[i] === 'refund' ? BigInt(b.stake) : classes[i] === 'lose' ? 0n : ((cb[i] + w[i]) * pool) / sumW - (cb[i] * pool) / sumW));
  return { payouts, classes, burned, bonusOut: 0n, result: 'paid' };
}

// A whole history: active rounds, bets [{ id, stake, bulb, betRound }] (any order), the walker's start round.
// Returns { nights: [{ ...night, bonusIn, result, burned, bonusOut, bets: [ids] }], byBet: Map(id -> { night, cls,
// payout }), bonusPot (carried into the next night), waiting: [ids not in a closed night yet] }.
export function settleAll({ active, after, through, bets, station = 36 }) {
  const { closed, open } = nights(active, after, through, station);
  const sorted = bets.slice().sort((a, b) => a.id - b.id);
  const per = closed.map(() => []), waiting = [];
  for (const b of sorted) { const k = nightOf(closed, b.betRound); if (k < 0) waiting.push(b.id); else per[k].push(b); }
  let pot = 0n;
  const byBet = new Map(), out = [];
  closed.forEach((n, k) => {
    const list = per[k];
    if (!list.length) { out.push({ ...n, bonusIn: pot, result: 'empty', burned: 0n, bonusOut: pot, bets: [] }); return; }
    const s = settle({ lit: n.lit, bonusIn: pot, bets: list.map((b) => ({ stake: b.stake, bulb: b.bulb, betRound: b.betRound, litRound: n.litRounds[b.bulb] ?? null, litBefore: litBefore(n, b.betRound) })) });
    list.forEach((b, i) => byBet.set(b.id, { night: k, cls: s.classes[i], payout: s.payouts[i], litBefore: litBefore(n, b.betRound) }));
    out.push({ ...n, bonusIn: pot, result: s.result, burned: s.burned, bonusOut: s.bonusOut, bets: list.map((b) => b.id) });
    pot = s.bonusOut;
  });
  return { nights: out, byBet, bonusPot: pot, waiting, open };
}
