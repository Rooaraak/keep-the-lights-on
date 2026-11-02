// The LED board under the hamster cam: the sign, the cable of numbered bulbs, the bets on them, the town. The live
// game and the replay draw the same board. A controller hands draw() a plain description of what to show; the
// board keeps only its animations. Squeektoshi himself and the big bulb are on the hamster cam (art/stage.js).

import { createLed } from './led.js';

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const reducedMotion = () => REDUCED;

// ---------- palette: Squeekchain's own colours ----------
const HEX = {
  D: '#2f4499', b: '#4460cf', h: '#5b7cfa', s: '#a8b8fb', w: '#efbe45', l: '#f5dc7e', o: '#e3a21a', O: '#d98a12',
  n: '#6b2f0c', y: '#fdfbc8', r: '#c33346', g: '#6e6e7a', c: '#b6b6c2', F: '#d4a775', f: '#c99762', e: '#c07e72',
  k: '#17171b', m: '#35d07f', G: '#1b7849', p: '#f7a8c9', B: '#b84d00', W: '#ffffff',
};
const KEYS = Object.keys(HEX), IDX = Object.fromEntries(KEYS.map((k, i) => [k, i]));
export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

// ---------- 5x7 LED font ----------
const FONT = {
  A:[14,17,17,31,17,17,17],B:[30,17,17,30,17,17,30],C:[14,17,16,16,16,17,14],D:[30,17,17,17,17,17,30],E:[31,16,16,30,16,16,31],
  F:[31,16,16,30,16,16,16],G:[14,17,16,23,17,17,15],H:[17,17,17,31,17,17,17],I:[14,4,4,4,4,4,14],J:[7,2,2,2,2,18,12],
  K:[17,18,20,24,20,18,17],L:[16,16,16,16,16,16,31],M:[17,27,21,21,17,17,17],N:[17,17,25,21,19,17,17],O:[14,17,17,17,17,17,14],
  P:[30,17,17,30,16,16,16],Q:[14,17,17,17,21,18,13],R:[30,17,17,30,20,18,17],S:[15,16,16,14,1,1,30],T:[31,4,4,4,4,4,4],
  U:[17,17,17,17,17,17,14],V:[17,17,17,17,17,10,4],W:[17,17,17,21,21,21,10],X:[17,17,10,4,10,17,17],Y:[17,17,10,4,4,4,4],
  Z:[31,1,2,4,8,16,31],0:[14,17,19,21,25,17,14],1:[4,12,4,4,4,4,14],2:[14,17,1,2,4,8,31],3:[31,2,4,2,1,17,14],
  4:[2,6,10,18,31,2,2],5:[31,16,30,1,1,17,14],6:[6,8,16,30,17,17,14],7:[31,1,2,4,8,8,8],8:[14,17,17,14,17,17,14],
  9:[14,17,17,15,1,2,12],' ':[0,0,0,0,0,0,0],'.':[0,0,0,0,0,12,12],':':[0,12,12,0,12,12,0],'-':[0,0,0,31,0,0,0],
  '+':[0,4,4,31,4,4,0],'?':[14,17,1,2,4,0,4],'!':[4,4,4,4,4,0,4],'*':[0,0,0,4,0,0,0],'x':[0,17,10,4,10,17,0],"'":[4,4,8,0,0,0,0],
};
const textWidth = (s) => s.length * 6 - 1;


// ---------- the dot grid ----------
let canvas = null, led = null;
const ROWS = 56;
const B = { cols: 96, rows: ROWS, buf: null, lvl: null, table: null, dark: true, boardColor: '#08080c' };
export function attach(el) {
  canvas = el;
  led = createLed(canvas);
  setup();
}
export function setup() {
  if (!canvas) return;
  const w = canvas.parentElement.clientWidth || 600;
  // The bulbs come in pages: 8 across on a wide board, 6 on a narrow one (24 bulbs = 3 or 4 whole pages). The grid is
  // exactly one page wide, so the dots grow with the board and a short night still fills a good part of the row.
  B.fit = w >= 760 ? 8 : 6;
  B.cols = B.fit * PITCH + 4; B.rows = ROWS;
  B.x0 = Math.floor((B.cols - ((B.fit - 1) * PITCH + BW)) / 2);
  canvas.style.aspectRatio = `${B.cols} / ${B.rows}`;   // round dots: the page's style already gives this ratio (no jump)
  B.buf = new Int8Array(B.cols * B.rows); B.lvl = new Uint8Array(B.cols * B.rows);
  B.dark = true;   // the board is a dark LED panel in both themes, like the hamster cam
  B.boardColor = getComputedStyle(document.documentElement).getPropertyValue('--board').trim() || '#08080c';
  led.size(B.cols, B.rows, { board: B.boardColor, unlit: '#16161e', glow: !REDUCED });
  // every colour at its four brightness levels, as pixels
  const f = [0, .32, .62, 1];
  B.table = new Uint32Array(KEYS.length * 4);
  KEYS.forEach((k, ci) => { const c = rgb(HEX[k]); for (let lv = 0; lv < 4; lv++) B.table[ci * 4 + lv] = led.rgb(...c.map((v) => Math.round(v * f[lv]))); });
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const clear = () => { B.buf.fill(-1); B.lvl.fill(0); };
function dot(x, y, k, lv = 3) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= B.cols || y >= B.rows) return;
  const i = y * B.cols + x; B.buf[i] = IDX[k]; B.lvl[i] = lv;
}
function stamp(rows, x0, y0, lv = 3) {
  for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) { const ch = rows[j][i]; if (ch !== '.') dot(x0 + i, y0 + j, ch, lv); }
}
function text(str, x0, y0, k = 'o', lv = 3) {
  let x = x0;
  for (const ch of str) {
    const g = FONT[ch] || FONT[ch.toUpperCase()] || FONT[' '];
    if (x > -6 && x < B.cols) for (let j = 0; j < 7; j++) for (let i = 0; i < 5; i++) if (g[j] & (16 >> i)) dot(x + i, y0 + j, k, lv);
    x += 6;
  }
}
function paint() {
  led.clear();
  for (let i = 0; i < B.buf.length; i++) { const ci = B.buf[i]; if (ci >= 0) { const lv = B.lvl[i]; led.set(i, B.table[ci * 4 + lv], lv === 3); } }
  led.paint();
}

// ---------- sound (only after the viewer turns it on) ----------
const snd = { on: false, ctx: null };
function tone(freq, t0, dur, type = 'sine', vol = .18) {
  const a = snd.ctx, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(vol, a.currentTime + t0);
  g.gain.exponentialRampToValueAtTime(.0005, a.currentTime + t0 + dur);
  o.connect(g).connect(a.destination); o.start(a.currentTime + t0); o.stop(a.currentTime + t0 + dur + .05);
}
export const sfx = {
  out() { if (snd.on) [784, 659, 523, 392].forEach((f, i) => tone(f, i * .22, .5, 'triangle', .1)); },
  coin() { if (snd.on) [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, i * .07, .25, 'square', .03)); },
  bet() { if (snd.on) { tone(660, 0, .12, 'triangle', .08); tone(990, .1, .2, 'triangle', .07); } },
  zap() { if (snd.on) { tone(220, 0, .08, 'sawtooth', .05); tone(1760, .05, .35, 'sine', .07); } },
  tick() { if (snd.on) tone(1320, 0, .06, 'square', .03); },
};
export function toggleSound() {
  snd.on = !snd.on;
  if (snd.on && !snd.ctx) { try { snd.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { snd.on = false; } }
  if (snd.ctx && snd.ctx.state === 'suspended') snd.ctx.resume();
  return snd.on;
}

// ---------- animations the board keeps between frames ----------
const A = { marquee: '', mqX: 0, sparks: [], coins: [], litAt: [], bootT0: null, meBulb: null, meT0: -9, page: null, turn: null, off: 0 };
export function resetAnimations() { Object.assign(A, { sparks: [], coins: [], litAt: [], mqX: B.cols, marquee: '', meBulb: null, meT0: -9, page: null, turn: null, off: 0 }); }
// Switching a bulb on, in seconds after its spark sets off: the spark runs along the cable, the screw base flashes,
// the filament glows, the glass fills with light from the filament out (with one flicker), a white flash and a ring
// of light, and the number pops. Several bulbs at once (catching up) go one after another.
export const LIGHT = { travel: .6, base: .15, filament: .35, fill: .4, on: 1.35, flash: .15, ring: .65, pop: .35, gap: .45 };
export function spark(k, time) {
  const last = A.sparks.reduce((m, s) => Math.max(m, s.t0), -Infinity);
  const t0 = Math.max(time, last + LIGHT.gap);
  A.sparks.push({ k, t0 }); A.litAt[k] = t0 + LIGHT.on;
}
export function coinShower(time) {
  if (REDUCED) return;
  for (let i = 0; i < 26; i++) A.coins.push({ x: (i * 7 + 3) % B.cols, v: 9 + (i % 5) * 3, t0: time + 2.6 + (i % 9) * .12 });
}

// ---------- scene ----------
const DIG = { 0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7], 4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7] };
function digits(n, x0, y0, k, lv) { let x = x0; for (const ch of String(n)) { const g = DIG[ch]; for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j] & (4 >> i)) dot(x + i, y0 + j, k, lv); x += 4; } }
// "BONUS POT 950" in the same 3x5 dots, in the band of sky between the sign and the bulb numbers
const SMALL = { ...DIG, B: [6, 5, 6, 5, 6], O: [2, 5, 5, 5, 2], N: [5, 7, 7, 5, 5], U: [5, 5, 5, 5, 7], S: [3, 4, 2, 1, 6], P: [6, 5, 6, 4, 4], T: [7, 2, 2, 2, 2], ' ': [0, 0, 0, 0, 0] };
const POT_X = 2, POT_Y = 11;
const potText = (n) => `BONUS POT ${n}`;
const potWidth = (n) => potText(n).length * 4 - 1;
function potSign(n) {
  let x = POT_X;
  for (const ch of potText(n)) { const g = SMALL[ch]; for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j] & (4 >> i)) dot(x + i, POT_Y + j, 'o', 3); x += 4; }
}
// The string's bulbs: the hamster cam's big bulb, hanging upside down from the cable. 11 x 14 dots: the wire, the screw
// base, the glass with its filament. Lit: warm glass, white-hot middle, a glint.
const SB = {
  off: ['....nnn....', '...ccccc...', '...ggggg...', '...ccccc...', '...ggggg...', '...g...g...', '..g.....g..', '.g.......g.',
    'g.........g', 'g.........g', 'g.........g', '.g.......g.', '..g.....g..', '...ggggg...'],
  lit: ['....nnn....', '...ccccc...', '...ggggg...', '...ccccc...', '...ggggg...', '...cwwwc...', '..cwwlwwc..', '.cWlllllwc.',
    'cwllyyyllwc', 'cwlyyyyylwc', 'cwllyyyllwc', '.cwlllllwc.', '..cwwwwwc..', '...ccccc...'],
};
const cellsOf = (rows, test) => rows.flatMap((r, j) => [...r].map((ch, i) => (test(ch, i, j) ? [i, j, ch] : null)).filter(Boolean));
const GLASS = cellsOf(SB.lit, (ch, i, j) => j >= 5 && 'wlyW'.includes(ch));     // inside the glass
// the filament: two thin wires down from the base and a short coil, faint until it warms up
const WIRES = [[4, 6], [6, 6], [4, 7], [6, 7]], COIL = [[4, 8], [5, 8], [6, 8]], FIL = [...WIRES, ...COIL];
const BW = 11, BH = 14, MID = { x: 5, y: 8 };                                   // the filament's middle, where light starts
// rows: the sign 1-7, sky and bonus pot 10-16, bulb numbers 18-22, cable 25, bulbs 26-39, bets 42-45, town to 55
const PITCH = 14, NUM_Y = 18, CABLE = 25, BULB_Y = 26, MARK_Y = 42, BASE = 54;
const visibleBulbs = () => B.fit || 1;
const lastPage = () => Math.max(0, Math.ceil(24 / visibleBulbs()) - 1);
// The page the board shows: the one with the last lit bulb (a full row stays up). While he keeps running, a full row
// turns to the next page once its last bulb is fully on, so the next bulb can warm up there. During a blackout the
// row that goes dark stays in view.
const TURN_WAIT = 1.1, TURN_TIME = .75;
function pageFor(v, time) {
  const P = visibleBulbs(), lit = v.lit;
  let pg = lit === 0 ? 0 : Math.floor((lit - 1) / P);
  if (lit > 0 && lit % P === 0 && lit < 24 && v.outP == null && !v.resting) {
    const at = A.litAt[lit];
    if (at == null || time >= at + TURN_WAIT) pg++;   // litAt = when that bulb is fully on
  }
  return Math.min(lastPage(), pg);
}
// where the row is now, in bulbs (a page turn slides it: whole dots at a time, like a scrolling LED sign)
function viewOff(v, time) {
  const P = visibleBulbs(), pg = pageFor(v, time);
  if (A.page == null || REDUCED) { A.page = pg; A.turn = null; }
  else if (pg !== A.page) { A.turn = { from: (A.turn ? A.off : A.page * P), t0: time }; A.page = pg; }
  let off = A.page * P;
  if (A.turn) {
    const p = Math.min(1, (time - A.turn.t0) / TURN_TIME), e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    off = A.turn.from + (off - A.turn.from) * e;
    if (p >= 1) A.turn = null;
  }
  A.off = off;
  return off;
}
const bulbX = (k, off) => Math.round((B.x0 || 0) + (k - 1 - off) * PITCH);     // left edge of bulb k
const STARS = Array.from({ length: 44 }, (_, i) => ({ x: (i * 37 + 23) % 331, y: 10 + (i * 5) % 7, ph: i * 1.7, rate: .7 + (i % 5) * .23 }));
// now and then a shooting star crosses the sky band
function meteor(time) {
  if (REDUCED) return;
  const every = 19, n = Math.floor(time / every), a = time - n * every;
  if (a > .8) return;
  const p = a / .8, x0 = (n * 53 + 17) % Math.max(20, B.cols - 30), x = x0 + p * 26, y = 10.5 + p * 5;
  for (let i = 0; i < 5; i++) dot(x - i * 1.4, y - i * .27, i === 0 ? 'W' : 'y', i < 2 ? 3 : i < 4 ? 2 : 1);
}
function sky(time, dim, keepOut = 0) {
  for (const s of STARS) {
    if (s.x >= B.cols || (!B.dark && s.ph % 2 > 1)) continue;
    if (keepOut && s.x <= POT_X + keepOut && s.y >= POT_Y - 1 && s.y <= POT_Y + 5) continue; // no stars inside the bonus pot sign
    const tw = REDUCED ? 2 : 1 + Math.round(Math.sin(time * s.rate + s.ph) + 1);
    dot(s.x, s.y, B.dark ? 'y' : 'o', Math.max(1, Math.min(B.dark ? 3 : 2, tw - dim)));
  }
}
// the cable comes in from the hamster cam on the left and sags between the bulbs; it glows up to the last lit one
function cable(off, litTo) {
  const glowTo = litTo > off ? bulbX(litTo, off) + MID.x : -1, first = bulbX(1, off);
  for (let x = 0; x < B.cols; x++) {
    const rel = ((x - first - MID.x) % PITCH + PITCH) % PITCH, sag = x >= first && rel >= 4 && rel <= 10 ? (rel >= 6 && rel <= 8 ? 2 : 1) : 0;
    dot(x, CABLE + sag, x <= glowTo ? 'O' : 'g', x <= glowTo ? 2 : 1);
  }
}
// numbers: a light board needs them a step stronger to read
const num = (k, x, colour, lv) => digits(k, x + MID.x - (k >= 10 ? 3 : 1), NUM_Y, colour, B.dark ? lv : Math.min(3, lv + 1));
// the bulb you picked: green brackets at its four corners
function pickMark(x, time) {
  const lv = REDUCED ? 3 : 2 + Math.round((Math.sin(time * 4) + 1) / 2) % 2;
  const l = x - 2, r = x + BW + 1, t = NUM_Y - 2, b = BULB_Y + BH;
  for (const [cx, cy, dx, dy] of [[l, t, 1, 1], [r, t, -1, 1], [l, b, 1, -1], [r, b, -1, -1]]) {
    dot(cx, cy, 'm', lv); dot(cx + dx, cy, 'm', lv); dot(cx, cy + dy, 'm', lv);
  }
}
// One bulb, in one of: dark, charging (the next one while he runs), lighting (a = seconds into its switch-on), lit,
// going (q = 0..1 into its blackout).
function bulb(k, x, st, time, { a = 0, q = 0, flicker = false } = {}) {
  const y = BULB_Y, L = LIGHT;
  if (st === 'lit') {
    // a break: short, irregular dips, as a real bulb does on a weak supply (mostly bright, now and then nearly out)
    const n = Math.sin(time * 7.3 + k * 1.7) + Math.sin(time * 17.9 + k * 4.1) * .6;
    const lv = flicker && !REDUCED ? (n > 1.1 ? 1 : n > .75 ? 2 : 3) : 3;
    stamp(lv === 1 ? SB.off : SB.lit, x, y, lv === 1 ? 2 : lv);
    if (lv === 1) for (const [i, j] of FIL) dot(x + i, y + j, 'O', 2);
    if (B.dark && lv === 3) for (const [i, j] of [[-1, 9], [BW, 9], [-1, 8], [BW, 8], [MID.x, BH + 1]]) dot(x + i, y + j, 'w', 1);   // a soft halo
    num(k, x, 'o', 3);
    return;
  }
  if (st === 'lighting') {
    stamp(SB.off, x, y, 2);
    const t = a - L.travel - L.base;                                                                                  // the spark has run down the base
    if (t < 0) for (const [i, j] of WIRES) dot(x + i, y + j, 'g', 1);
    if (t >= 0) {                                                                                                     // the filament warms up
      const f = Math.min(1, t / L.filament);
      for (const [i, j] of FIL) dot(x + i, y + j, f < .5 ? 'O' : 'y', f < .3 ? 1 : f < .7 ? 2 : 3);
    }
    const tf = t - L.filament;
    if (tf >= 0) {                                                                                                    // light fills the glass outwards
      const r = Math.min(1, tf / L.fill) * 6.5, dip = tf > L.fill * .55 && tf < L.fill * .7 && !REDUCED;               // one flicker on the way
      for (const [i, j, ch] of GLASS) { const d = Math.hypot(i - MID.x, j - MID.y); if (d <= r) dot(x + i, y + j, ch, dip ? 1 : d > r - 1.2 ? 2 : 3); }
    }
    num(k, x, 'c', 2);
    return;
  }
  if (st === 'going') {
    if (q < .35) {                                                                                                    // it stutters...
      const on = REDUCED || Math.sin(q * 90) > 0;
      stamp(on ? SB.lit : SB.off, x, y, on ? 3 : 2);
      num(k, x, 'o', on ? 3 : 1);
    } else {                                                                                                          // ...and goes out, the filament glowing a moment longer
      stamp(SB.off, x, y, 2);
      const g = 1 - (q - .35) / .65;
      for (const [i, j] of FIL) dot(x + i, y + j, g > .5 ? 'O' : 'B', g > .66 ? 3 : g > .33 ? 2 : 1);
      num(k, x, 'c', 2);
    }
    return;
  }
  stamp(SB.off, x, y, 2);
  if (B.dark) { dot(x + 2, y + 8, 'c', 1); dot(x + 2, y + 9, 'c', 1); }   // a glint on the cold glass
  if (st !== 'charging') { for (const [i, j] of WIRES) dot(x + i, y + j, 'g', 1); for (const [i, j] of COIL) dot(x + i, y + j, 'n', 2); }
  if (st === 'charging') {                                                                                          // the next bulb warms up while he runs
    const lv = REDUCED ? 1 : 1 + Math.round((Math.sin(time * 2.6) + 1) / 2);
    for (const [i, j] of FIL) dot(x + i, y + j, 'O', lv);
    num(k, x, 'o', lv);
    return;
  }
  num(k, x, 'c', 2);
}
// what follows a bulb switching on: a white flash, then a ring of light spreading out and fading
function afterglow(x, a) {
  const t = a - LIGHT.on;
  if (t < 0 || t > LIGHT.ring || REDUCED) return;
  if (t < LIGHT.flash) for (const [i, j] of GLASS) dot(x + i, BULB_Y + j, 'y', 3);
  const r = 7.5 + t / LIGHT.ring * 4, lv = t < LIGHT.ring * .4 ? 2 : 1, cx = x + MID.x, cy = BULB_Y + MID.y + 1;
  for (let n = 0; n < 34; n++) { const th = n / 34 * 2 * Math.PI, py = cy + Math.sin(th) * r; if (py > CABLE + 2) dot(cx + Math.cos(th) * r, py, 'w', lv); }
}
// under the bulbs: a green arrow for your bet, up to three dots for everyone else's
function markers(list, off, lit) {
  for (const m of list) {
    const x = bulbX(m.bulb, off); if (x < -BW || x >= B.cols) continue;
    const c = x + MID.x;
    if (m.me) {
      // a new bet: the arrow drops in from the bulb and bounces, and a green ring goes round the bulb
      const a = A.time - A.meT0, drop = REDUCED || a > .5 ? 0 : Math.round(-6 * Math.abs(Math.cos(a / .5 * Math.PI * 1.5)) * (1 - a / .5));
      dot(c, MARK_Y + drop, 'm', 3); dot(c - 1, MARK_Y + 1 + drop, 'm', 3); dot(c, MARK_Y + 1 + drop, 'm', 3); dot(c + 1, MARK_Y + 1 + drop, 'm', 3);
      if (!REDUCED && a < .7) { const r = 7 + a * 6, cy = BULB_Y + MID.y + 1; for (let n = 0; n < 30; n++) { const th = n / 30 * 2 * Math.PI; dot(c + Math.cos(th) * r, cy + Math.sin(th) * r, 'm', a < .35 ? 2 : 1); } }
    }
    for (let i = 0; i < Math.min(3, m.others || 0); i++) dot(c - 2 + i * 2, MARK_Y + (m.me ? 3 : 1), m.bulb <= lit ? 'G' : 'c', 2);
  }
}
// the town along the bottom: more windows light as more bulbs do
function town(lit, time, out) {
  for (let x = 0; x < B.cols; x++) {
    const lot = Math.floor(x / 11), inLot = x % 11, seed = ((lot + 3) * 2654435761) >>> 0, h = 4 + (seed % 5), wide = 7 + (seed >> 5) % 3;
    if (inLot >= wide) continue;
    const roof = BASE - h;
    for (let y = roof; y <= BASE; y++) {
      const edge = y === roof || inLot === 0 || inLot === wide - 1;
      if (edge) { dot(x, y, B.dark ? 'D' : 's', 1); continue; }   // quiet outlines: the lit windows are the point
      if ((y - roof) % 2 === 0 && inLot % 2 === 1 && y < BASE) {
        const want = ((seed >> (inLot + y)) % 20 + 20) % 20; // this window wants bulb `want` before it lights
        if (!out && want < lit * 1.4) dot(x, y, 'w', REDUCED || Math.sin(time * .4 + lot + y) > -.9 ? 2 : 1);
      }
    }
  }
  for (let x = 0; x < B.cols; x++) { dot(x, BASE + 1, 'G', 1); if (x % 3 === 0) dot(x, BASE, 'G', 1); }
}
// the spark: a bright head with a fading tail, and a few sparks flying off it
function sparks(time, off) {
  A.sparks = A.sparks.filter((s) => time - s.t0 < LIGHT.on + LIGHT.ring + .1);
  for (const s of A.sparks) {
    const a = time - s.t0; if (a < 0 || a > LIGHT.travel + LIGHT.base) continue;
    const tx = bulbX(s.k, off) + MID.x;
    if (a > LIGHT.travel) {                                     // down through the screw base into the bulb
      const d = (a - LIGHT.travel) / LIGHT.base, y = CABLE + 1 + Math.round(d * 5);
      dot(tx, y, 'W', 3); dot(tx - 1, y, 'y', 2); dot(tx + 1, y, 'y', 2); if (y > CABLE + 1) dot(tx, y - 1, 'w', 2);
      continue;
    }
    const p = a / LIGHT.travel, e = p * p * (3 - 2 * p), x = Math.round(tx * e);
    for (let i = 0; i < 6; i++) dot(x - i, CABLE, i === 0 ? 'W' : i < 2 ? 'y' : i < 4 ? 'w' : 'o', i < 2 ? 3 : i < 4 ? 2 : 1);
    if (!REDUCED) for (let i = 0; i < 3; i++) { const ph = (time * 37 + i * 2.3) % 1; dot(x - 1 - i, CABLE - 1 - Math.round(ph * 2), 'y', ph < .5 ? 2 : 1); }
  }
}
function coins(time) {
  A.coins = A.coins.filter((c) => time - c.t0 < 2.2);
  for (const c of A.coins) { const a = time - c.t0; if (a >= 0) dot(c.x + Math.sin(a * 5 + c.x) * 1.2, 10 + a * c.v, a % .4 < .2 ? 'w' : 'o', 3); }
}
// The sign: a message that fits stands still in the middle; a longer one scrolls. When news comes now and then (live),
// it replaces the old message at once: stale news is wrong news. When it comes faster than every 6 s (a replay), a
// longer message scrolls through whole before the newest waiting one starts, else none would ever be read; a blackout
// or the game's end still cuts in.
function marquee(dt, msg) {
  const fits = (m) => textWidth(m) <= B.cols - 4, urgent = (m) => /BLACKOUT|ENDED/.test(m) && !/BLACKOUT|ENDED/.test(A.marquee);
  if (msg !== A.lastIn) { A.busy = A.time - (A.lastInAt ?? -99) < 6; A.lastIn = msg; A.lastInAt = A.time; }
  if (msg !== A.marquee) {
    const done = !A.busy || !A.marquee || fits(A.marquee) || REDUCED || A.mqX < -textWidth(A.marquee) || urgent(msg);
    if (done) { A.marquee = msg; A.mqX = fits(msg) || REDUCED ? Math.max(2, Math.floor((B.cols - textWidth(msg)) / 2)) : B.cols; }
  }
  const m = A.marquee;
  if (!REDUCED && !fits(m)) { A.mqX -= dt * 16; if (A.mqX < -textWidth(m) && m === msg) A.mqX = B.cols; }
  text(m, Math.round(A.mqX), 1, 'o', 3);
  for (let x = 0; x < B.cols; x += 2) dot(x, 9, B.dark ? 'D' : 's', 1);
}

// The whole board for one frame. v = {
//   lit          bulbs lit (0..24)
//   flicker      lit bulbs flicker (a break: he stopped for a round)
//   resting      he is curled up in the wheel (the next bulb only warms up while he runs)
//   pace         turns per 10 minutes (the hamster cam shows it)
//   speedMul     replay speed (1 live)
//   pot          bonus pot in whole SQK to show on the sign, 0 = none
//   markers      [{ bulb, me, others }]
//   pick         a bulb further along than the view, shown as an arrow at the right edge (0 = none)
//   outP         null, or 0 -> 1 while the lights go out after a blackout, the last one first (>= 1: all dark)
//   msg          the scrolling sign
//   markerOff    true to hide the markers (after the lights went out)
// }
export function draw(v, time, dt) {
  if (!canvas || !B.buf) return;
  const lit = v.lit, outP = v.outP;
  const off = viewOff(v, time);
  describe(v);
  clear();
  A.time = time;
  const me = (v.markers || []).find((m) => m.me);
  if (!me) A.meBulb = null; else if (me.bulb !== A.meBulb) { A.meBulb = me.bulb; A.meT0 = time; }
  sky(time, outP != null ? 0 : Math.min(2, Math.floor(lit / 6)), v.pot ? potWidth(v.pot) : 0);
  if (!v.pot) meteor(time);
  if (v.pot) potSign(v.pot);
  town(lit, time, outP != null && outP > .6);
  // the cable glows up to the last bulb that is fully on (a bulb still switching on doesn't count yet)
  let glow = outP != null ? 0 : lit;
  while (glow > 0 && A.litAt[glow] != null && time < A.litAt[glow] - LIGHT.on + LIGHT.travel) glow--;
  cable(off, glow);
  const after = [];
  for (let k = 1; k <= 24; k++) {
    const x = bulbX(k, off); if (x < -BW || x >= B.cols) continue;
    if (!A.turn && (x < 0 || x + BW > B.cols)) continue;   // the next page's first bulb shows only while the row turns
    const sp = A.sparks.find((s) => s.k === k), a = sp ? time - sp.t0 : null;
    let st = 'dark', opts = { flicker: v.flicker };
    if (outP != null) {
      if (k <= lit && outP < 1) {
        const p = .05 + (lit - k) / Math.max(1, lit - 1) * .65, q = (outP - p) / .3;   // the last bulb goes first
        st = q < 0 ? 'lit' : q < 1 ? 'going' : 'dark'; opts.q = q;
      }
    } else if (k <= lit) {
      if (a != null && a < LIGHT.on) { st = a < 0 ? 'dark' : 'lighting'; opts.a = a; } else st = 'lit';
      if (a != null && a >= LIGHT.on) after.push([x, a]);
    } else if (k === lit + 1 && !v.resting) st = 'charging';
    bulb(k, x, st, time, opts);
  }
  for (const [x, a] of after) afterglow(x, a);
  if (!v.markerOff) markers(v.markers || [], off, lit);
  sparks(time, off);
  // your bulb is further along than the board shows: its number and a small arrow at the right edge
  const mine = v.pick || 0;
  if (mine && !(outP != null && outP >= 1)) { const px = bulbX(mine, off); if (px >= 0 && px + BW <= B.cols) pickMark(px, time); }
  if (mine > off + visibleBulbs() && !(outP != null && outP >= 1)) {
    const n = String(mine), x = B.cols - 4 * n.length - 3;
    digits(mine, x, MARK_Y, 'm', 3); for (const [i, j] of [[0, 0], [1, 1], [0, 2]]) dot(B.cols - 2 + i, MARK_Y + 1 + j - 1, 'm', 3);
  }
  marquee(dt * (v.speedMul || 1), v.msg || '');
  coins(time);
  // the first second: the board switches on with a bright edge sweeping from the left
  if (A.bootT0 == null) A.bootT0 = time;
  const boot = (time - A.bootT0) / .9;
  if (!REDUCED && boot < 1.15) {
    const edge = boot * (B.cols + 6);
    for (let y = 0; y < B.rows; y++) for (let x = 0; x < B.cols; x++) {
      const i = y * B.cols + x;
      if (x > edge) B.buf[i] = -1; else if (x > edge - 3) { B.buf[i] = IDX.W; B.lvl[i] = x > edge - 1 ? 2 : 1; }
    }
  }
  paint();
}

// The board's text for screen readers (kept up to date even while the board is off screen and not drawn).
export function describe(v) {
  if (!canvas) return;
  const label = `LED board: Squeektoshi's wheel powers a string of numbered bulbs. ${v.lit} lit${v.pot ? `. Bonus pot ${v.pot.toLocaleString('en-US')} SQK` : ''}`;
  if (canvas.getAttribute('aria-label') !== label) canvas.setAttribute('aria-label', label);
}

// The bulb under a click on the board, for the same view as the frame (or 0).
export function bulbAt(clientX, lit) {
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect(), cx = (clientX - rect.left) / rect.width * B.cols;
  const k = Math.floor((cx - (B.x0 || 0) + (PITCH - BW) / 2) / PITCH + (A.off || 0)) + 1;
  void lit;
  return k >= 1 && k <= 24 ? k : 0;
}
// Where bulb k's glass is on the page right now (for tests), or null when it is scrolled out of view.
export function bulbPoint(k, lit) {
  if (!canvas) return null;
  void lit;
  const x = bulbX(k, A.off || 0);
  if (x < 0 || x + BW > B.cols) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + (x + MID.x + .5) / B.cols * rect.width, y: rect.top + (BULB_Y + MID.y + .5) / B.rows * rect.height };
}
