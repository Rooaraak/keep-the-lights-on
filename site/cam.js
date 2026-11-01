import { createLed } from './led.js';

// The hamster cam: Squeektoshi big in his wheel, a cable to the big bulb, the bulb glowing with his live speed.
// A self-contained LED canvas (drawn by led.js). Feed it his state with stage.set({ rpm, running, pausing }); it animates on its own.
// pausing = a short break in a ride: he stands still, awake, and the bulb burns low and unsteady.
//   const stage = createStage(canvas, { sprites, dark: () => true });
//   stage.set({ rpm: 64, running: true });
export function createStage(canvas, { sprites, dark = () => matchMedia('(prefers-color-scheme: dark)').matches, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches } = {}) {
  const COLS = 72, ROWS = 42;
  const HEX = { ...sprites._palette };
  const KEYS = Object.keys(HEX), IDX = Object.fromEntries(KEYS.map((k, i) => [k, i]));
  const led = createLed(canvas);
  const B = { buf: new Int8Array(COLS * ROWS), lvl: new Uint8Array(COLS * ROWS), table: null, dark: true };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  function setup() {
    B.dark = dark(); S.dirty = true;
    const board = getComputedStyle(document.documentElement).getPropertyValue('--board').trim() || '#08080c';
    led.size(COLS, ROWS, { board, unlit: B.dark ? '#16161e' : '#e3e3e9', glow: B.dark && !reduced });
    // every colour at its four brightness levels, as pixels
    const f = [0, .32, .62, 1];
    B.table = new Uint32Array(KEYS.length * 4);
    KEYS.forEach((k, ci) => { const c = rgb(HEX[k]); for (let lv = 0; lv < 4; lv++) B.table[ci * 4 + lv] = led.rgb(...c.map((v) => Math.round(v * f[lv]))); });
  }
  const dot = (x, y, k, lv = 3) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= COLS || y >= ROWS || IDX[k] == null) return; const i = y * COLS + x; B.buf[i] = IDX[k]; B.lvl[i] = lv; };
  const stamp = (rows, x0, y0, lv = 3) => { for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) { const ch = rows[j][i]; if (ch !== '.') dot(x0 + i, y0 + j, ch, lv); } };
  function paint() {
    led.clear();
    for (let i = 0; i < B.buf.length; i++) { const ci = B.buf[i]; if (ci >= 0) { const lv = B.lvl[i]; led.set(i, B.table[ci * 4 + lv], lv === 3); } }
    led.paint();
  }

  // ---- what he is doing ----
  const S = { visible: true, painted: 0, born: 0, dirty: true, rpm: 0, running: false, pausing: false, shown: 0, wheelA: 0, frameT: 0, frame: 0, bright: 0, wakeAt: -9, sleepSince: 0, sparks: [], last: 0, flick: 0 };
  const WX = 19, WY = 20, WR = 18, BX = 49, BY = 9;                     // wheel centre and radius, big bulb top-left
  const STARS = Array.from({ length: 14 }, (_, i) => ({ x: 39 + (i * 11) % 32, y: 1 + (i * 5) % 6, ph: i * 1.9 })).filter((s) => s.x < 46 || s.x > 66 || s.y < 2);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!S.visible || document.hidden || now - S.painted < 32) return;   // off screen, or faster than 30 fps: skip
    if (reduced) { if (!S.dirty) return; S.dirty = false; }                // reduced motion: one still picture per change
    S.painted = now;
    const dt = Math.min(.1, (now - (S.last || now)) / 1000); S.last = now; const t = now / 1000;
    // ease the shown speed toward the real one: the wheel spins up and coasts down
    const target = S.running ? S.rpm : 0;
    if (reduced) S.shown = target; else S.shown += (target - S.shown) * (1 - Math.exp(-dt / (target > S.shown ? .8 : 1.1)));
    if (S.shown < 3 && !S.running) S.shown = 0;          // coasted to a stop: he curls up
    if (!reduced) S.wheelA += dt * (S.shown / 60) * 2 * Math.PI * .5;
    // bulb brightness follows the shown speed; a sudden drop makes it flicker
    // a break: the bulb burns low and unsteady; otherwise it follows his speed
    const want = S.pausing && !S.running ? .3 + (reduced ? 0 : .12 * (Math.sin(t * 7.3) + Math.sin(t * 17.9) * .6)) : Math.min(1, S.shown / 55);
    if (want < S.bright - .15) S.flick = t + .6;
    if (reduced) S.bright = want; else S.bright += (want - S.bright) * (1 - Math.exp(-dt / .6));
    // running frames: faster legs at higher speed
    if (!reduced) { S.frameT += dt * Math.max(0, S.shown) / 12; if (S.frameT > 1) { S.frameT = 0; S.frame ^= 1; } }
    if (!S.running && !S.pausing && S.shown === 0 && !S.sleepSince) S.sleepSince = t;
    if ((S.running || S.pausing) && S.sleepSince) { S.sleepSince = 0; S.wakeAt = t; }

    B.buf.fill(-1); B.lvl.fill(0);
    for (const s of STARS) dot(s.x, s.y, B.dark ? 'y' : 'o', reduced ? 2 : 1 + Math.round(Math.sin(t * .9 + s.ph) + 1));
    stamp(['..yyy.', '.yy...', 'yy....', 'yy....', '.yy...', '..yyy.'], 39, 2, 3);   // the moon, clear of the bulb's rays
    // the wheel: rim, rotating spokes, axle, stand
    for (let a = 0; a < 120; a++) { const th = a / 120 * 2 * Math.PI; dot(WX + Math.cos(th) * WR, WY + Math.sin(th) * WR, B.dark ? 'c' : 'g', 2); }
    for (let i = 0; i < 36; i++) { const th = S.wheelA * .5 + i / 36 * 2 * Math.PI; dot(WX + Math.cos(th) * (WR - 2), WY + Math.sin(th) * (WR - 2), 'g', 1); }   // rungs turn with the wheel
    for (let i = 0; i < 8; i++) { const th = S.wheelA + i * Math.PI / 4; for (let r = 3; r < WR - 1; r += 2) dot(WX + Math.cos(th) * r, WY + Math.sin(th) * r, 'g', 1); }
    dot(WX, WY, 'c', 3);
    for (let y = WY; y <= 41; y++) { dot(WX - Math.round((y - WY) * .45), y, 'g', 2); dot(WX + Math.round((y - WY) * .45), y, 'g', 2); }
    // Squeektoshi
    const asleep = !S.running && !S.pausing && S.shown < 2, waking = t - S.wakeAt < 1.2;
    if (asleep) {
      stamp(sprites.bigSleep, WX - 14, WY + WR - 24, 3);
      if (!reduced) for (let n = 0; n < 3; n++) {
        const z = ((t * .5 + n / 3) % 1), big = n === 2;                  // three Z's drift up and fade, the last one bigger
        const zx = Math.round(WX + 2 + z * 9 + n * 2), zy = Math.round(WY - 5 - z * 10);
        const glyph = big ? ['sssss', '...s.', '..s..', '.s...', 'sssss'] : ['ssss', '..s.', '.s..', 'ssss'];
        if (z < .9) stamp(glyph, zx, zy, z < .6 ? 3 : 2);
      }
    } else {
      const spr = waking && !reduced ? sprites.bigRunB : S.frame ? sprites.bigRunB : sprites.bigRunA;
      stamp(spr, WX - 17, WY + WR - 21, 3);
    }
    // the cable from the axle stand to the bulb, with sparks running along it
    for (let x = WX + 9; x <= BX + 8; x++) dot(x, 41, 'g', 2);
    for (let y = BY + 23; y <= 41; y++) dot(BX + 8, y, 'g', 2);
    if (S.shown > 3 && !reduced && Math.random() < dt * S.shown / 20) S.sparks.push({ t0: t });
    S.sparks = S.sparks.filter((s) => t - s.t0 < .9);
    for (const s of S.sparks) {
      const p = (t - s.t0) / .9, len = (BX + 8 - (WX + 9)) + (41 - (BY + 23)), d = p * len;
      const x = d < BX + 8 - (WX + 9) ? WX + 9 + d : BX + 8, y = d < BX + 8 - (WX + 9) ? 41 : 41 - (d - (BX + 8 - (WX + 9)));
      dot(x, y, 'y', 3); dot(x - 1, y, 'w', 2);
    }
    // the big bulb: four drawn levels, plus a flicker when he slows down
    let lvl = S.bright < .05 ? 0 : S.bright < .35 ? 1 : S.bright < .7 ? 2 : 3;
    if (t < S.flick && !reduced && Math.sin(t * 40) > 0) lvl = Math.max(0, lvl - 1);
    stamp(sprites[`bulb${lvl}`], BX, BY, lvl === 0 ? 2 : 3);
    if (lvl >= 2) {
      const cx = BX + 8, cy = BY + 7.5, pulse = reduced ? 0 : (Math.sin(t * 3) + 1) / 2;
      for (const deg of [-90, -55, -20, 15, 195, 160, 125]) {           // short rays around the glass, none toward the base
        const th = deg * Math.PI / 180, r0 = 10 + (lvl === 3 ? Math.round(pulse) : 0);
        for (let r = r0; r < r0 + (lvl === 3 ? 3 : 2); r++) dot(cx + Math.cos(th) * r, cy + Math.sin(th) * r, 'w', r === r0 ? 3 : 2);
      }
      for (let dx = -7; dx <= 7; dx++) if (Math.abs(dx) > 1) dot(cx + dx, 40, 'w', Math.abs(dx) < 4 ? 2 : 1);   // light on the ground
    }
    for (let x = 0; x < COLS; x++) { dot(x, 41, x >= WX + 9 && x <= BX + 8 ? 'g' : 'G', x % 3 === 0 ? 2 : 1); }
    // now and then a shooting star over the moon side
    if (!reduced) { const n = Math.floor(t / 23), a = t - n * 23; if (a < .7) { const p = a / .7, x = 40 + ((n * 7) % 12) + p * 18, y = 1 + p * 5; for (let i = 0; i < 4; i++) dot(x - i * 1.5, y - i * .4, i ? 'y' : 'W', i < 2 ? 3 : 1); } }
    // switching on: a bright edge sweeps across the picture the first time it shows
    if (!S.born) S.born = t;
    const boot = (t - S.born) / .9;
    if (!reduced && boot < 1.15) { const edge = boot * (COLS + 6); for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { const i = y * COLS + x; if (x > edge) B.buf[i] = -1; else if (x > edge - 3) { B.buf[i] = IDX.W ?? IDX.y; B.lvl[i] = x > edge - 1 ? 2 : 1; } } }
    paint();
  }

  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(setup, 100); }).observe(canvas.parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setup);
  new MutationObserver(setup).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new IntersectionObserver((e) => { S.visible = e[e.length - 1].isIntersecting; }).observe(canvas);
  setup(); requestAnimationFrame(frame);
  return { set({ rpm, running, pausing }) {
    const before = `${S.running}${S.pausing}${Math.round(S.rpm / 5)}`;
    if (rpm != null) S.rpm = rpm; if (running != null) S.running = running; if (pausing != null) S.pausing = pausing;
    if (`${S.running}${S.pausing}${Math.round(S.rpm / 5)}` !== before) S.dirty = true;
  } };
}
