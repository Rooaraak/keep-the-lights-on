#!/usr/bin/env node
// The page's rules, offline:
//  1. site/engine.js is byte for byte the approved art/led-demo/lights-engine.js.
//  2. It settles every vector in data/lights-vectors.json (made by src/LightsMath.sol) to the wei.
//  3. The replay's lowest bulb is never refunded on any real night (copied from sim/check-lights-vectors.mjs §6, §8).
//  4. The live page's walk of SqueekCore rounds gives exactly the nights in data/rides.json, and the odds.
//  5. The live page's lowest bulb is never refunded, on every round of rounds 1-780, when SqueekCore is one or two
//     rounds behind and the bet lands in the round in progress or up to two rounds later; and it is never below
//     what the replay offers for the same moment.
// Usage: node site/test/engine.test.mjs   (exits 1 on any failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../engine.js';
import * as M from '../live-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const VECTORS = json('data/lights-vectors.json');
const RIDES_SRC = json('data/rides.json');
const ROUNDS = json('data/rounds.json');
const SITE_RIDES = json('site/data/rides.json');

let failures = 0;
const fail = (msg) => { failures++; if (failures < 40) console.log(`  FAIL ${msg}`); };
const ok = (cond, msg) => console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`) || (cond ? 0 : failures++);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 1 ----------
const mine = readFileSync(join(ROOT, 'site/engine.js'), 'utf8');
const approved = readFileSync(join(ROOT, 'art/led-demo/lights-engine.js'), 'utf8');
ok(mine === approved, 'site/engine.js is identical to art/led-demo/lights-engine.js');

// ---------- 2 ----------
{
  let good = 0;
  for (const v of VECTORS) {
    const bets = v.bets.map((b) => ({ stake: BigInt(b.stake), bulb: b.bulb, betRound: b.betRound, litRound: b.litRound, litBefore: b.litBefore }));
    const s = E.settle({ lit: v.lit, bonusIn: BigInt(v.bonusIn), burnBps: v.burnBps, bets });
    const bad = [];
    if (!same(s.payouts.map(String), v.expect.payouts)) bad.push('payouts');
    if (String(s.burned) !== v.expect.burned) bad.push('burned');
    if (String(s.bonusOut) !== v.expect.bonusOut) bad.push('bonusOut');
    if (s.result !== v.expect.result) bad.push('result');
    if (!same(s.classes, v.expect.classes)) bad.push('classes');
    if (bad.length) fail(`vector ${v.name}: ${bad.join(', ')}`); else good++;
  }
  ok(good === VECTORS.length && VECTORS.length >= 24, `${good}/${VECTORS.length} settlement vectors to the wei (payouts, burn, bonus pot out, result, classes)`);
}

// ---------- 3 ----------
{
  let cases = 0, refunded = 0, nextBad = 0;
  for (const c of SITE_RIDES.rides) {
    const L = c.w.length;
    for (let r = -3; r <= L + 1; r++) for (const N of [r, r + 1]) {
      if (E.forNextRide(c.w, N)) {
        if (E.minBulb(c.w, N, r) !== (N <= L + 1 ? 1 : 2)) nextBad++;
        continue;
      }
      const b = E.minBulb(c.w, N, r);
      if (b > E.MAX_BULB) continue;
      cases++;
      if (E.settleRide(c.w, [{ stake: 100n * E.WEI, bulb: b, betRound: N }]).classes[0] === 'refund') { refunded++; fail(`replay night ${c.n}: bulb ${b} in round ${r} (counts as ${N}) is refunded`); }
    }
  }
  ok(refunded === 0 && nextBad === 0, `replay: the lowest bulb offered is never refunded (${cases} cases) and a bet in the blackout rounds is offered bulb 1 for the next ride`);
}

// ---------- 4 ----------
const STATION = 36;
const active = ROUNDS.active.map((a) => ({ id: a.id, work: a.work }));
const full = M.walkNights({ rides: [], settledThrough: 0 }, active, ROUNDS.settledThrough, STATION);
{
  const want = RIDES_SRC.rides;
  const bad = [];
  if (full.rides.length !== want.length) bad.push(`${full.rides.length} nights, data/rides.json has ${want.length}`);
  full.rides.forEach((r, i) => {
    const d = want[i];
    if (!d) return;
    if (r.start !== d.start || r.C !== d.C || r.lit !== d.stopCount) bad.push(`night ${i + 1}: start/C/lit ${r.start}/${r.C}/${r.lit} vs ${d.start}/${d.C}/${d.stopCount}`);
    if (!same(r.w, d.rounds.map((x) => x.work))) bad.push(`night ${i + 1}: turns differ`);
    if (r.lastBetRound !== d.C - 1) bad.push(`night ${i + 1}: last bet round ${r.lastBetRound}`);
  });
  if (full.open) bad.push(`a night is still open at ${ROUNDS.settledThrough}`);
  ok(!bad.length, `walking SqueekCore rounds 1-${ROUNDS.settledThrough} gives the ${want.length} nights of data/rides.json (start, blackout, bulbs, turns)${bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''}`);
  const base = M.walkNights(SITE_RIDES, [], SITE_RIDES.settledThrough, STATION);
  ok(same(base.rides.map((r) => [r.start, r.C, r.lit, r.w]), full.rides.map((r) => [r.start, r.C, r.lit, r.w])) && !base.open, 'site/data/rides.json is the same history');
  const od = M.odds(full.rides);
  const shares = RIDES_SRC.summary.reachingNStops.map((x) => Math.round(x.share * 100));
  ok(same(od.slice(0, shares.length).map((o) => o.pct), shares) && od[5].pct === 37, `odds per bulb match data/rides.json (bulb 6: lit on ${od[5].pct}% of his nights, ${od[5].lit} of ${od[5].total})`);

  // a break, a blackout at the STATION edge, a STATION end and a false start, on made-up rounds
  const runs = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i, work: 100 }));
  const t = M.walkNights({ rides: [], settledThrough: 0 }, [...runs(10, 13), ...runs(15, 16), { id: 30, work: 9 }, ...runs(40, 80)], 100, STATION);
  const shape = t.rides.map((r) => [r.start, r.end, r.C, r.lit, r.w.length, r.lastBetRound]);
  ok(same(shape, [[10, 'blackout', 17, 5, 7, 16], [30, 'blackout', 31, 0, 1, 30], [40, 'station', null, 35, 36, 75], [76, 'blackout', 81, 4, 5, 80]]) && !t.open,
    `made-up nights: break, false start, STATION end then a new night at once (${JSON.stringify(shape)})`);
  const o = M.walkNights({ rides: [], settledThrough: 0 }, runs(10, 14), 15, STATION);
  ok(o.open && o.open.start === 10 && o.open.idleRun === 1 && M.litOf(o.open) === 4 && o.rides.length === 0, 'an open night with one quiet round is still open (a break, not yet a blackout)');
}

// ---------- 5 ----------
// The truth for a bet sent in round N on bulb b: the night it lands in (by the full history) and its class there.
{
  const work = new Map(active.map((a) => [a.id, a.work]));
  const classOf = (N, bulb) => {
    const { byRide } = M.groupBets([{ id: 0, betRound: N, bulb, stake: 100n * E.WEI, owner: '0x0' }], full.rides);
    const [n] = [...byRide.keys()];
    if (n == null) return null;
    const ride = full.rides.find((r) => r.n === n);
    return { ride, cls: E.settleRide(ride.w, [{ stake: 100n * E.WEI, bulb, betRound: N - ride.start }]).classes[0] };
  };
  let cases = 0, refunded = 0, belowReplay = 0, labelBad = 0, risky = 0, riskyRefunds = 0, riskyBad = 0, tonightMoved = 0, byFloor = new Map();
  const lastLB = full.rides[full.rides.length - 1].lastBetRound;
  for (let cur = 3; cur <= ROUNDS.settledThrough - 3; cur++) {
    for (const lag of [1, 2]) {
      const S = cur - lag;
      const view = M.walkNights({ rides: [], settledThrough: 0 }, active, S, STATION);
      const wheel = { fresh: true, running: work.has(cur) };
      for (const N of [cur, cur + 1, cur + 2]) {
        if (N > lastLB) continue;
        const win = M.betWindow({ S, cur, N, open: view.open, wheel });
        if (win.floor > E.MAX_BULB) continue;
        const truth = classOf(N, win.floor);
        if (!truth) continue;
        cases++;
        byFloor.set(win.floor - M.litOf(view.open), (byFloor.get(win.floor - M.litOf(view.open)) || 0) + 1);
        if (win.bulb1Risk) {
          risky++;
          if (truth.cls === 'refund') { riskyRefunds++; if (truth.ride.start !== N) { riskyBad++; fail(`bulb 1 in round ${N} refunded though he departed in ${truth.ride.start}`); } }
        } else if (truth.cls === 'refund') { refunded++; fail(`round ${cur}, core at ${S}, bet counts in ${N}: bulb ${win.floor} offered and refunded (night ${truth.ride.start})`); }
        // the label: 'next' means the bet lands in a night that departs after S
        if (win.night === 'next' && truth.ride.start <= S) { labelBad++; fail(`round ${N}: said next ride, landed in the night of ${truth.ride.start}`); }
        if (win.night !== 'next' && view.open && truth.ride.start !== view.open.start) tonightMoved++;
        // never below the replay's offer (which sees the round in progress) for the same moment
        if (view.open && lag === 1 && N <= cur + 1) {
          const ride = full.rides.find((r) => r.start === view.open.start);
          if (ride && !E.forNextRide(ride.w, N - ride.start)) {
            const proto = E.minBulb(ride.w, N - ride.start, cur - ride.start);
            if (win.floor < proto) { belowReplay++; fail(`round ${cur}: live floor ${win.floor} below the replay's ${proto}`); }
          }
        }
      }
    }
  }
  ok(refunded === 0, `live lowest bulb never refunded: ${cases} (round, core lag 1-2, bet lands 0-2 rounds later) cases on rounds 1-${ROUNDS.settledThrough}`);
  ok(belowReplay === 0, 'live lowest bulb is never below the replay\'s for the same moment');
  ok(labelBad === 0, '"counts for his next ride" is always true');
  ok(riskyBad === 0, `bulb 1 before he starts: offered in ${risky} cases, refunded in ${riskyRefunds}, each time because he started in the round the bet was sent`);
  console.log(`  a bet said to be for tonight moved to his next ride in ${tonightMoved} cases (he fell asleep right after it); floors above bulbs lit: ${[...byFloor].sort((a, b) => a[0] - b[0]).map(([k, v]) => `+${k}: ${v}`).join(', ')}`);
}

// ---------- the last two rounds of a 36-round night (audit M4): no bulb is offered there ----------
{
  // a 36-round night with a break every other round (bulbs 1-16 in rounds 2, 4, ... 32), then bulbs 17 and 18 in
  // its last two rounds: a bet sent in start + 33 can still win (bulb 18 lights in start + 35 = N + 2); one sent in
  // start + 34 or + 35 can only be given back or lose
  const all = Array.from({ length: 36 }, (_, i) => (i % 2 === 0 && i <= 32) || i >= 34 ? 500 : 0);
  const cls = (N) => [...Array(E.MAX_BULB).keys()].map((k) => E.settleRide(all, [{ stake: 100n * E.WEI, bulb: k + 1, betRound: N }]).classes[0]);
  ok(cls(33).includes('win') && !cls(34).includes('win') && !cls(35).includes('win'), 'a 36-round night: bets sent in its last two rounds can never win (only be given back or lose)');
  const w = Array.from({ length: 34 }, (_, i) => (i % 2 === 0 ? 400 : 0)); // breaks every other round: 16 bulbs by start + 33
  const open = { start: 100, w, idleRun: 1 };
  const wheel = { fresh: true, running: true };
  const a = M.betWindow({ S: 132, cur: 133, N: 133, open: { ...open, w: w.slice(0, 33), idleRun: 0 }, wheel, station: 36 });
  const b = M.betWindow({ S: 133, cur: 134, N: 134, open, wheel, station: 36 });
  const c = M.betWindow({ S: 133, cur: 134, N: 135, open, wheel, station: 36 });
  ok(a.floor <= E.MAX_BULB && !a.closing, `round start + 33: bulbs offered from ${a.floor}`);
  ok(b.floor > E.MAX_BULB && b.closing && c.floor > E.MAX_BULB && c.closing, 'rounds start + 34 and + 35: no bulb offered (closing)');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall engine checks passed');
process.exit(failures ? 1 : 0);
