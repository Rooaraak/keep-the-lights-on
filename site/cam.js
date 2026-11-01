// The hamster cam: Squeektoshi big in his wheel, a cable to the big bulb, the bulb glowing with his live speed.
// A self-contained LED canvas. Feed it his speed with stage.set({ rpm, running }); it animates on its own.
//   const stage = createStage(canvas, { sprites, dark: () => true });
//   stage.set({ rpm: 64, running: true });
export function createStage(canvas, { sprites, dark = () => matchMedia('(prefers-color-scheme: dark)').matches, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches } = {}) {
  const COLS = 72, ROWS = 42;
  const HEX = { ...sprites._palette };
  const LIGHT_SWAP = { y: '#efbe45', l: '#efbe45', c: '#8a8a96', W: '#9a9aa6' };
  const KEYS = Object.keys(HEX), IDX = Object.fromEntries(KEYS.map((k, i) => [k, i]));
  const ctx = canvas.getContext('2d');
  const B = { p: 8, dpr: 1, buf: new Int8Array(COLS * ROWS), lvl: new Uint8Array(COLS * ROWS), unlit: null, cache: new Map(), dark: true, board: '#050508' };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  function setup() {
    const w = canvas.parentElement.clientWidth || 600;
    B.dpr = Math.min(2, window.devicePixelRatio || 1); B.p = w / COLS;
    canvas.width = Math.round(w * B.dpr); canvas.height = Math.round(B.p * ROWS * B.dpr); canvas.style.height = `${B.p * ROWS}px`;
    B.dark = dark(); B.cache.clear(); B.board = B.dark ? '#050508' : '#f3f3f6';
    B.unlit = document.createElement('canvas'); B.unlit.width = canvas.width; B.unlit.height = canvas.height;
    const u = B.unlit.getContext('2d'), P = B.p * B.dpr;
    u.fillStyle = B.board; u.fillRect(0, 0, B.unlit.width, B.unlit.height); u.fillStyle = B.dark ? '#16161e' : '#e3e3e9';
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { u.beginPath(); u.arc((x + .5) * P, (y + .5) * P, P * .4, 0, 6.2832); u.fill(); }
  }
  function sprite(ci, lv) {
    const key = ci * 4 + lv; let s = B.cache.get(key); if (s) return s;
    const P = B.p * B.dpr, size = Math.ceil(P * 3), c = size / 2, k = KEYS[ci];
    s = document.createElement('canvas'); s.width = s.height = size; const x = s.getContext('2d');
    let col = rgb((!B.dark && LIGHT_SWAP[k]) || HEX[k]); const f = [0, .32, .62, 1][lv];
    if (B.dark) col = col.map((v) => Math.round(v * f)); else { const bg = rgb(B.board); col = col.map((v, i) => Math.round(bg[i] + (v - bg[i]) * f)); }
    if (B.dark && lv === 3 && !reduced) { const g = x.createRadialGradient(c, c, P * .25, c, c, P * 1.25); g.addColorStop(0, `rgba(${col},.22)`); g.addColorStop(1, `rgba(${col},0)`); x.fillStyle = g; x.fillRect(0, 0, size, size); }
    x.fillStyle = `rgb(${col})`; x.beginPath(); x.arc(c, c, P * .42, 0, 6.2832); x.fill();
    B.cache.set(key, s); return s;
  }
  const dot = (x, y, k, lv = 3) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= COLS || y >= ROWS || IDX[k] == null) return; const i = y * COLS + x; B.buf[i] = IDX[k]; B.lvl[i] = lv; };
  const stamp = (rows, x0, y0, lv = 3) => { for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) { const ch = rows[j][i]; if (ch !== '.') dot(x0 + i, y0 + j, ch, lv); } };
  function paint() {
    ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(B.unlit, 0, 0);
    ctx.globalCompositeOperation = B.dark ? 'lighter' : 'source-over';
    const P = B.p * B.dpr, half = Math.ceil(P * 3) / 2;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) { const i = y * COLS + x; if (B.buf[i] >= 0) ctx.drawImage(sprite(B.buf[i], B.lvl[i]), (x + .5) * P - half, (y + .5) * P - half); }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- what he is doing ----
  const S = { rpm: 0, running: false, shown: 0, wheelA: 0, frameT: 0, frame: 0, bright: 0, wakeAt: -9, sleepSince: 0, sparks: [], last: 0, flick: 0 };
  const WX = 19, WY = 20, WR = 18, BX = 49, BY = 9;                     // wheel centre and radius, big bulb top-left
  const STARS = Array.from({ length: 14 }, (_, i) => ({ x: 39 + (i * 11) % 32, y: 1 + (i * 5) % 6, ph: i * 1.9 })).filter((s) => s.x < 46 || s.x > 66 || s.y < 2);

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.1, (now - (S.last || now)) / 1000); S.last = now; const t = now / 1000;
    // ease the shown speed toward the real one: the wheel spins up and coasts down
    const target = S.running ? S.rpm : 0;
    S.shown += (target - S.shown) * (1 - Math.exp(-dt / (target > S.shown ? .8 : 1.1)));
    if (S.shown < 3 && !S.running) S.shown = 0;          // coasted to a stop: he curls up
    S.wheelA += dt * (S.shown / 60) * 2 * Math.PI * .5;
    // bulb brightness follows the shown speed; a sudden drop makes it flicker
    const want = Math.min(1, S.shown / 55);
    if (want < S.bright - .15) S.flick = t + .6;
    S.bright += (want - S.bright) * (1 - Math.exp(-dt / .6));
    // running frames: faster legs at higher speed
    S.frameT += dt * Math.max(0, S.shown) / 12; if (S.frameT > 1) { S.frameT = 0; S.frame ^= 1; }
    if (!S.running && S.shown === 0 && !S.sleepSince) S.sleepSince = t;
    if (S.running && S.sleepSince) { S.sleepSince = 0; S.wakeAt = t; }

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
    const asleep = !S.running && S.shown < 2, waking = t - S.wakeAt < 1.2;
    if (asleep) {
      stamp(sprites.bigSleep, WX - 14, WY + WR - 24, 3);
      if (!reduced) for (let n = 0; n < 3; n++) {
        const z = ((t * .5 + n / 3) % 1), big = n === 2;                  // three Z's drift up and fade, the last one bigger
        const zx = Math.round(WX + 2 + z * 9 + n * 2), zy = Math.round(WY - 5 - z * 10);
        const glyph = big ? ['ssss', '..s.', '.s..', 'ssss'] : ['sss', '.s.', 'sss'];
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
    paint();
  }

  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(setup, 100); }).observe(canvas.parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setup);
  new MutationObserver(setup).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setup(); requestAnimationFrame(frame);
  return { set({ rpm, running }) { if (rpm != null) S.rpm = rpm; if (running != null) S.running = running; } };
}
