// The LED board under the hamster cam: the sign, the cable of numbered bulbs, the bets on them, the town. The live
// game and the replay draw the same board. A controller hands draw() a plain description of what to show; the
// board keeps only its animations. Squeektoshi himself and the big bulb are on the hamster cam (art/stage.js).

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const reducedMotion = () => REDUCED;

// ---------- palette: Squeekchain's own colours ----------
const HEX = {
  D: '#2f4499', b: '#4460cf', h: '#5b7cfa', s: '#a8b8fb', w: '#efbe45', l: '#f5dc7e', o: '#e3a21a', O: '#d98a12',
  n: '#6b2f0c', y: '#fdfbc8', r: '#c33346', g: '#6e6e7a', c: '#b6b6c2', F: '#d4a775', f: '#c99762', e: '#c07e72',
  k: '#17171b', m: '#35d07f', G: '#1b7849', p: '#f7a8c9', B: '#b84d00', W: '#ffffff',
};
const LIGHT_SWAP = { y: '#efbe45', l: '#efbe45', c: '#8a8a96', W: '#9a9aa6' }; // cream and pale tones vanish on a light board
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
let canvas = null, ctx = null;
const ROWS = 45;
const B = { cols: 96, rows: ROWS, p: 8, dpr: 1, buf: null, lvl: null, unlit: null, sprites: new Map(), dark: true, boardColor: '#050508' };
export function attach(el) {
  canvas = el;
  ctx = canvas.getContext('2d');
  setup();
}
export function setup() {
  if (!canvas) return;
  const w = canvas.parentElement.clientWidth || 600;
  // phones: 72 dots across, like the hamster cam above; wider screens keep the cam's dot size (640 px / 72)
  B.cols = w < 560 ? 72 : Math.max(96, Math.round(w / 8.9)); B.rows = ROWS;
  B.dpr = Math.min(2, window.devicePixelRatio || 1);
  B.p = w / B.cols;
  canvas.width = Math.round(w * B.dpr); canvas.height = Math.round(B.p * B.rows * B.dpr);
  canvas.style.height = `${B.p * B.rows}px`;
  B.buf = new Int8Array(B.cols * B.rows); B.lvl = new Uint8Array(B.cols * B.rows);
  B.dark = isDark(); B.sprites.clear();
  const css = getComputedStyle(document.documentElement);
  B.boardColor = css.getPropertyValue('--board').trim() || (B.dark ? '#050508' : '#f3f3f6');
  B.unlit = document.createElement('canvas'); B.unlit.width = canvas.width; B.unlit.height = canvas.height;
  const u = B.unlit.getContext('2d'), P = B.p * B.dpr;
  u.fillStyle = B.boardColor; u.fillRect(0, 0, B.unlit.width, B.unlit.height);
  u.fillStyle = B.dark ? '#16161e' : '#e3e3e9';
  for (let y = 0; y < B.rows; y++) for (let x = 0; x < B.cols; x++) { u.beginPath(); u.arc((x + .5) * P, (y + .5) * P, P * .40, 0, 6.2832); u.fill(); }
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function sprite(ci, lv) {
  const key = ci * 4 + lv; let s = B.sprites.get(key); if (s) return s;
  const P = B.p * B.dpr, size = Math.ceil(P * 3), c = size / 2;
  s = document.createElement('canvas'); s.width = s.height = size; const x = s.getContext('2d');
  const k = KEYS[ci]; let col = rgb((!B.dark && LIGHT_SWAP[k]) || HEX[k]);
  const f = [0, .32, .62, 1][lv];
  if (B.dark) col = col.map((v) => Math.round(v * f));
  else { const bg = rgb(B.boardColor.length === 7 ? B.boardColor : '#f3f3f6'); col = col.map((v, i) => Math.round(bg[i] + (v - bg[i]) * f)); }
  if (B.dark && lv === 3 && !REDUCED) {
    const g = x.createRadialGradient(c, c, P * .25, c, c, P * 1.2);
    g.addColorStop(0, `rgba(${col.join(',')},.2)`); g.addColorStop(1, `rgba(${col.join(',')},0)`);
    x.fillStyle = g; x.fillRect(0, 0, size, size);
  }
  x.fillStyle = `rgb(${col.join(',')})`; x.beginPath(); x.arc(c, c, P * .42, 0, 6.2832); x.fill();
  B.sprites.set(key, s); return s;
}
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
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(B.unlit, 0, 0);
  ctx.globalCompositeOperation = B.dark ? 'lighter' : 'source-over';
  const P = B.p * B.dpr, half = Math.ceil(P * 3) / 2;
  for (let y = 0; y < B.rows; y++) for (let x = 0; x < B.cols; x++) {
    const i = y * B.cols + x, ci = B.buf[i];
    if (ci < 0) continue;
    ctx.drawImage(sprite(ci, B.lvl[i]), (x + .5) * P - half, (y + .5) * P - half);
  }
  ctx.globalCompositeOperation = 'source-over';
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
const A = { marquee: '', mqX: 0, sparks: [], coins: [], litAt: [] };
export function resetAnimations() { Object.assign(A, { sparks: [], coins: [], litAt: [], mqX: B.cols, marquee: '' }); }
// a spark runs along the cable to bulb k, which lights when it arrives
export function spark(k, time) { A.sparks.push({ k, t0: time }); A.litAt[k] = time + .7; }
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
// the small bulbs (art/sprites: sbOff, sbLit, sbPop), 7 x 8 dots: cap, socket, glass
const SB = {
  off: ['..ccc..', '..ggg..', '.g...g.', 'g.....g', 'g.....g', 'g.....g', '.g...g.', '..ggg..'],
  lit: ['..ccc..', '..ggg..', '.owwwo.', 'owllywo', 'owlyylo', 'owllllo', '.owwwo.', '..ooo..'],
  pop: ['..ccc..', '..ggg..', '.c...c.', 'c..W..c', 'c.W.W.c', 'c..W..c', '.c...c.', '..ccc..'],
};
const GLASS = [[2, 2], [3, 2], [4, 2], [1, 3], [5, 3], [1, 4], [5, 4], [1, 5], [5, 5], [2, 6], [3, 6], [4, 6]];
// rows: the sign 1-7, sky and bonus pot 10-16, bulb numbers 18-22, cable 24, bulbs 25-32, bets 34-36, town to 44
const PITCH = 9, NUM_Y = 18, CABLE = 24, BULB_Y = 25, MARK_Y = 34, BASE = 43;
const X0 = 3;
const visibleBulbs = () => Math.floor((B.cols - X0) / PITCH);
// keep the last two lit bulbs and the next dark ones in view, and never scroll past bulb 24
const scrollFor = (lit) => Math.max(0, Math.min(24 - visibleBulbs(), lit - 2));
const bulbX = (k, off) => X0 + (k - 1 - off) * PITCH;     // left edge of bulb k's 7 dots
const STARS = Array.from({ length: 30 }, (_, i) => ({ x: (i * 37 + 23) % 211, y: 10 + (i * 5) % 7, ph: i * 1.7, rate: .7 + (i % 5) * .23 }));
function sky(time, dim, keepOut = 0) {
  for (const s of STARS) {
    if (s.x >= B.cols || (!B.dark && s.ph % 2 > 1)) continue;
    if (keepOut && s.x <= POT_X + keepOut && s.y >= POT_Y - 1 && s.y <= POT_Y + 5) continue; // no stars inside the bonus pot sign
    const tw = REDUCED ? 2 : 1 + Math.round(Math.sin(time * s.rate + s.ph) + 1);
    dot(s.x, s.y, B.dark ? 'y' : 'o', Math.max(1, Math.min(B.dark ? 3 : 2, tw - dim)));
  }
}
// the cable comes in from the hamster cam on the left and sags a little between the bulbs; it glows up to the last lit one
function cable(off, lit) {
  const litTo = lit > off ? bulbX(lit, off) + 3 : -1;
  for (let x = 0; x < B.cols; x++) {
    const rel = ((x - X0 - 3) % PITCH + PITCH) % PITCH, sag = x >= X0 && rel >= 3 && rel <= 6 ? 1 : 0;
    const on = x <= litTo;
    dot(x, CABLE + sag, on ? 'O' : 'g', on ? 2 : 1);
  }
}
function bulb(k, off, state, time, flicker, charging) {
  const x = bulbX(k, off); if (x < -7 || x >= B.cols) return;
  // dark numbers stay quiet, except every hour of running (bulbs 6, 12, 18, 24)
  digits(k, x + (k >= 10 ? 0 : 2), NUM_Y, state === 'lit' ? 'o' : B.dark ? 'g' : 'c', state === 'lit' ? 3 : k % 6 === 0 || charging ? 2 : 1);
  if (state === 'lit') {
    const lv = flicker && !REDUCED && Math.sin(time * 23 + k * 3) > .2 ? 2 : 3;
    stamp(SB.lit, x, BULB_Y, lv);
    if (B.dark && lv === 3) for (const [i, j] of [[-1, 4], [7, 4], [3, 9]]) dot(x + i, BULB_Y + j, 'w', 1);   // a little halo
  } else if (state === 'pop') stamp(SB.pop, x, BULB_Y, 2);
  else {
    stamp(SB.off, x, BULB_Y, 2);
    // the next bulb warms up while he runs: its glass pulses amber
    if (charging) { const lv = REDUCED ? 1 : 1 + Math.round((Math.sin(time * 3) + 1) / 2); for (const [i, j] of GLASS) dot(x + i, BULB_Y + j, 'o', lv); }
  }
}
// under the bulbs: a green arrow for your bet, up to three dots for everyone else's
function markers(list, off, lit) {
  for (const m of list) {
    const x = bulbX(m.bulb, off); if (x < -7 || x >= B.cols) continue;
    if (m.me) { dot(x + 3, MARK_Y, 'm', 3); dot(x + 2, MARK_Y + 1, 'm', 3); dot(x + 3, MARK_Y + 1, 'm', 3); dot(x + 4, MARK_Y + 1, 'm', 3); }
    for (let i = 0; i < Math.min(3, m.others || 0); i++) dot(x + 2 + i, MARK_Y + (m.me ? 3 : 1), m.bulb <= lit ? 'G' : 'c', 2);
  }
}
// the town along the bottom: more windows light as more bulbs do
function town(lit, time, out) {
  for (let x = 0; x < B.cols; x++) {
    const lot = Math.floor(x / 9), inLot = x % 9, seed = ((lot + 3) * 2654435761) >>> 0, h = 3 + (seed % 4), wide = 6 + (seed >> 5) % 2;
    if (inLot >= wide) continue;
    const roof = BASE - h;
    for (let y = roof; y <= BASE; y++) {
      const edge = y === roof || inLot === 0 || inLot === wide - 1;
      if (edge) { dot(x, y, B.dark ? 'D' : 's', 1); continue; }   // quiet outlines: the lit windows are the point
      if ((y - roof) % 2 === 0 && inLot % 2 === 1) {
        const want = ((seed >> (inLot + y)) % 20 + 20) % 20; // this window wants bulb `want` before it lights
        if (!out && want < lit * 1.4) dot(x, y, 'w', REDUCED || Math.sin(time * .4 + lot + y) > -.9 ? 2 : 1);
      }
    }
  }
  for (let x = 0; x < B.cols; x++) { dot(x, BASE + 1, 'G', 1); if (x % 3 === 0) dot(x, BASE, 'G', 1); }
}
function sparks(time, off) {
  A.sparks = A.sparks.filter((s) => time - s.t0 < .8);
  for (const s of A.sparks) {
    const p = Math.min(1, (time - s.t0) / .7), x = (bulbX(s.k, off) + 3) * p;
    dot(x, CABLE, 'y', 3); dot(x - 1, CABLE, 'w', 2);
  }
}
function coins(time) {
  A.coins = A.coins.filter((c) => time - c.t0 < 2.2);
  for (const c of A.coins) { const a = time - c.t0; if (a >= 0) dot(c.x + Math.sin(a * 5 + c.x) * 1.2, 10 + a * c.v, a % .4 < .2 ? 'w' : 'o', 3); }
}
function marquee(dt, msg) {
  if (msg !== A.marquee) { A.marquee = msg; A.mqX = REDUCED ? 2 : B.cols; }
  if (!REDUCED) { A.mqX -= dt * 16; if (A.mqX < -textWidth(msg)) A.mqX = B.cols; }
  text(msg, Math.round(A.mqX), 1, 'o', 3);
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
//   outP         null, or 0 -> 1 while the lights pop off after a blackout (>= 1: all dark)
//   msg          the scrolling sign
//   markerOff    true to hide the markers (after the lights went out)
// }
export function draw(v, time, dt) {
  if (!canvas || !B.buf) return;
  const lit = v.lit, off = scrollFor(lit), outP = v.outP;
  const label = `LED board: Squeektoshi's wheel powers a string of numbered bulbs. ${lit} lit${v.pot ? `. Bonus pot ${v.pot.toLocaleString('en-US')} SQK` : ''}`;
  if (canvas.getAttribute('aria-label') !== label) canvas.setAttribute('aria-label', label);
  clear();
  sky(time, outP != null ? 0 : Math.min(2, Math.floor(lit / 6)), v.pot ? potWidth(v.pot) : 0);
  if (v.pot) potSign(v.pot);
  town(lit, time, outP != null && outP > .6);
  cable(off, outP != null ? 0 : lit);
  for (let k = 1; k <= 24; k++) {
    let st = k <= lit && (A.litAt[k] == null || time >= A.litAt[k]) ? 'lit' : 'dark';
    if (outP != null && st === 'lit' && outP > 1 - (k - 1) / Math.max(1, lit) * .9) st = 'pop';
    if (outP != null && outP >= 1) st = 'dark';
    bulb(k, off, st, time, v.flicker, st === 'dark' && k === lit + 1 && !v.resting && outP == null);
  }
  if (!v.markerOff) markers(v.markers || [], off, lit);
  sparks(time, off);
  // your bulb is further along than the board shows: its number and a small arrow at the right edge
  const mine = v.pick || 0;
  if (mine > off + visibleBulbs() && !(outP != null && outP >= 1)) {
    const n = String(mine), x = B.cols - 4 * n.length - 3;
    digits(mine, x, MARK_Y, 'm', 3); for (const [i, j] of [[0, 0], [1, 1], [0, 2]]) dot(B.cols - 2 + i, MARK_Y + 1 + j - 1, 'm', 3);
  }
  marquee(dt * (v.speedMul || 1), v.msg || '');
  coins(time);
  paint();
}

// The bulb under a click on the board, for the same view as the frame (or 0).
export function bulbAt(clientX, lit) {
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect(), cx = (clientX - rect.left) / rect.width * B.cols;
  const k = Math.floor((cx - X0 + 1) / PITCH) + 1 + scrollFor(lit);
  return k >= 1 && k <= 24 ? k : 0;
}
// Where bulb k's glass is on the page right now (for tests), or null when it is scrolled out of view.
export function bulbPoint(k, lit) {
  if (!canvas) return null;
  const x = bulbX(k, scrollFor(lit));
  if (x < 0 || x + 7 > B.cols) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + (x + 3.5) / B.cols * rect.width, y: rect.top + (BULB_Y + 4.5) / B.rows * rect.height };
}
