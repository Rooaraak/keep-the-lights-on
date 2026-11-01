import { createLed } from './led.js';

// "KEEP THE / LIGHTS ON" in Squeekchain-style LED lettering. On load the letters power up dot by dot from the left,
// like a sign being switched on; afterwards a soft glint runs across now and then.
//   createTitle(canvas, { sprites })   (drawn by led.js)
export function createTitle(canvas, { sprites, dark = () => matchMedia('(prefers-color-scheme: dark)').matches, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches } = {}) {
  const PAL = sprites._palette, led = createLed(canvas, { glowAlpha: .7 });
  const LIGHT = { y: '#f5c842', l: '#efbe45', '1': '#efbe45' };   // on a light page the palest yellows would vanish
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  let rows, cols, nrows, t0 = performance.now(), isDark = true, visible = true, painted = 0, still = false;

  function layout() {
    // one line on wide screens and on phones (where height is scarce); two lines in between
    const w = canvas.parentElement.clientWidth || 600, oneLine = w > 760 || w < 520;
    const a = sprites.title1, b = sprites.title2, gap = 4;
    rows = oneLine ? a.map((r, i) => r + '.'.repeat(gap) + b[i]) : [...a, '', ...b].map((r) => r.padEnd(Math.max(a[0].length, b[0].length), '.'));
    cols = rows.reduce((m, r) => Math.max(m, r.length), 0) + 2; nrows = rows.length + 2;
    rows = ['.'.repeat(cols), ...rows.map((r) => '.' + r.padEnd(cols - 1, '.')), '.'.repeat(cols)];
    isDark = dark();
    // the sign sits on the page itself: the page colour around the dots
    led.size(cols, nrows, { board: getComputedStyle(document.body).backgroundColor || (isDark ? '#0e0e12' : '#f5f5f7'), unlit: isDark ? '#16161e' : '#e3e3e9', glow: isDark && !reduced });
    painted = 0; still = false;
  }
  function draw(now) {
    requestAnimationFrame(draw);
    const t = (now - t0) / 1000;
    // 30 fps while the letters switch on, then 20 fps for the slow glint; nothing while off screen
    if (!visible || document.hidden || now - painted < 32) return;
    const glint = reduced ? -99 : ((t - 2.2) % 7) * (cols / 1.6);       // every 7 s a highlight sweeps left to right
    // repaint only while the letters switch on or the glint crosses, plus once after; with reduced motion once per layout
    const moving = !reduced && (t < cols * .018 + 1 || (glint > -3 && glint < cols + 3));
    if (!moving && still) return;
    still = !moving; painted = now;
    led.clear();
    for (let y = 0; y < nrows; y++) for (let x = 0; x < cols; x++) {
      const ch = rows[y][x];
      if (!ch || ch === '.' || !(reduced || t > x * .018 + (y % 3) * .01)) continue;   // switch on from the left
      let col = rgb((!isDark && LIGHT[ch]) || PAL[ch]);
      if (Math.abs(x - glint) < 2.5 && ch !== 'n') col = col.map((v) => Math.min(255, v + 45));
      if (!reduced && t - x * .018 < .25) col = col.map((v) => Math.min(255, v + 60));   // a little flash as each dot comes on
      led.set(y * cols + x, led.rgb(...col), ch !== 'n');
    }
    led.paint();
  }
  new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; }).observe(canvas);
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(layout, 100); }).observe(canvas.parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', layout);
  new MutationObserver(layout).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  layout(); requestAnimationFrame(draw);
  return { replay() { t0 = performance.now(); } };
}
