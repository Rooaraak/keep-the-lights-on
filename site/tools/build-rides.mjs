#!/usr/bin/env node
// Writes site/data/rides.json, the ride history the page starts from, out of data/rides.json.
// Each night keeps only what the page needs: its departure round, how it ended, and his turns per round from the
// departure up to the last round before the blackout (w[0] is the departure, it lights nothing).
// The page reads the rounds after `settledThrough` from SqueekCore itself, so this file only has to be refreshed to
// make the first load lighter. Offline, no installs.
// Usage: node site/tools/build-rides.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'data', 'rides.json');
const ROUNDS = join(ROOT, 'data', 'rounds.json');
const OUT = join(HERE, '..', 'data', 'rides.json');

export function compact(src, rounds) {
  const open = src.rides.filter((r) => r.end === 'open');
  if (open.length) throw new Error('data/rides.json ends with a ride still open; the page must start after a blackout');
  const rides = src.rides.map((r) => ({
    n: r.n,
    start: r.start,
    end: r.end === 'lightsOut' ? 'blackout' : 'station',
    C: r.C,
    lit: r.stopCount,
    w: r.rounds.map((x) => x.work),
  }));
  for (const r of rides) {
    const want = r.end === 'blackout' ? r.C - r.start : 36;
    if (r.w.length !== want) throw new Error(`ride ${r.n}: ${r.w.length} rounds, expected ${want}`);
    if (r.w.slice(1).filter((x) => x > 0).length !== r.lit) throw new Error(`ride ${r.n}: bulbs do not match its turns`);
  }
  return {
    about: 'Squeektoshi\'s nights up to settledThrough, read from SqueekCore. w = turns per 10-minute round from the departure to the last round before the blackout.',
    core: rounds.core,
    genesis: rounds.genesis,
    roundSeconds: rounds.roundSeconds,
    station: 36,
    settledThrough: src.settledThrough,
    rides,
  };
}

const out = compact(JSON.parse(readFileSync(SRC, 'utf8')), JSON.parse(readFileSync(ROUNDS, 'utf8')));
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`wrote ${OUT}: ${out.rides.length} nights through round ${out.settledThrough}`);
