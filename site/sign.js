// "KEEP THE / LIGHTS ON" in Squeekchain-style LED lettering. On load the letters power up dot by dot from the left,
// like a sign being switched on; afterwards a soft glint runs across now and then.
//   createTitle(canvas, { sprites })
export function createTitle(canvas, { sprites, dark = () => matchMedia('(prefers-color-scheme: dark)').matches, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches } = {}) {
  const PAL = sprites._palette, ctx = canvas.getContext('2d');
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  let rows, cols, nrows, P, dpr, t0 = performance.now(), isDark = true, cache = null;

  function layout() {
    const w = canvas.parentElement.clientWidth || 600, oneLine = w > 760;
    const a = sprites.title1, b = sprites.title2, gap = 4;
    // wide screens: one line; phones: two lines
    rows = oneLine ? a.map((r, i) => r + '.'.repeat(gap) + b[i]) : [...a, '', ...b].map((r) => r.padEnd(Math.max(a[0].length, b[0].length), '.'));
    cols = rows.reduce((m, r) => Math.max(m, r.length), 0) + 2; nrows = rows.length + 2;
    rows = ['.'.repeat(cols), ...rows.map((r) => '.' + r.padEnd(cols - 1, '.')), '.'.repeat(cols)];
    dpr = Math.min(2, window.devicePixelRatio || 1); P = w / cols;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(P * nrows * dpr); canvas.style.height = `${P * nrows}px`;
    isDark = dark(); if (cache) cache.clear();
  }
  // each lit dot is drawn once per colour (with its glow in the dark theme) and then copied, so a frame stays cheap
  cache = new Map();
  function dotSprite(col) {
    const key = col.join(','); let c = cache.get(key); if (c) return c;
    const Pd = P * dpr, size = Math.ceil(Pd * 3), m = size / 2, r = Pd * .42;
    c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
    if (isDark) { const g = x.createRadialGradient(m, m, r * .5, m, m, r * 2.6); g.addColorStop(0, `rgba(${key},.28)`); g.addColorStop(1, `rgba(${key},0)`); x.fillStyle = g; x.fillRect(0, 0, size, size); }
    x.fillStyle = `rgb(${key})`; x.beginPath(); x.arc(m, m, r, 0, 6.2832); x.fill();
    cache.set(key, c); return c;
  }
  function draw(now) {
    requestAnimationFrame(draw);
    const t = (now - t0) / 1000, Pd = P * dpr, r = Pd * .42;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const glint = reduced ? -99 : ((t - 2.2) % 7) * (cols / 1.6);       // every 7 s a highlight sweeps left to right
    ctx.fillStyle = isDark ? '#16161e' : '#e3e3e9';
    for (let y = 0; y < nrows; y++) for (let x = 0; x < cols; x++) {
      const ch = rows[y][x], cx = (x + .5) * Pd, cy = (y + .5) * Pd;
      const on = ch && ch !== '.' && (reduced || t > x * .018 + (y % 3) * .01);   // switch on from the left
      if (!on) { ctx.beginPath(); ctx.arc(cx, cy, r * .95, 0, 6.2832); ctx.fill(); }
    }
    for (let y = 0; y < nrows; y++) for (let x = 0; x < cols; x++) {
      const ch = rows[y][x];
      if (!ch || ch === '.' || !(reduced || t > x * .018 + (y % 3) * .01)) continue;
      let col = rgb(PAL[ch]);
      if (Math.abs(x - glint) < 2.5 && ch !== 'n') col = col.map((v) => Math.min(255, v + 45));
      if (!reduced && t - x * .018 < .25) col = col.map((v) => Math.min(255, v + 60));   // a little flash as each dot comes on
      const sp = dotSprite(col), h = sp.width / 2;
      ctx.drawImage(sp, (x + .5) * Pd - h, (y + .5) * Pd - h);
    }
  }
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(layout, 100); }).observe(canvas.parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', layout);
  new MutationObserver(layout).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  layout(); requestAnimationFrame(draw);
  return { replay() { t0 = performance.now(); } };
}
