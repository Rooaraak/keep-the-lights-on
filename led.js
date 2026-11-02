// One renderer for the three LED panels (the title, the hamster cam, the bulb string). Each frame the lit dots go into
// a tiny image, one pixel per dot. That image is scaled up without smoothing (one square per dot), cut into round dots
// by a mask drawn once per size, and given a soft glow by the same tiny image scaled up with smoothing. A frame is a few
// full-size copies instead of one small drawing per lit dot, which keeps phones and slow machines smooth.
//   const led = createLed(canvas);
//   led.size(cols, rows, { board: '#08080c', unlit: '#16161e', glow: true });   // after every layout change
//   led.clear(); led.set(i, led.rgb(r, g, b), withGlow); led.paint();
export function createLed(canvas, { glowAlpha = .55 } = {}) {
  const ctx = canvas.getContext('2d');
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const L = { cols: 0, rows: 0, img: null, px32: null, gimg: null, glow32: null, low: null, lowG: null, wide: null, mask: null, unlit: null, glow: true, runsX: [], runsY: [] };
  // n cells over `size` device pixels, as even as whole pixels allow: their edges, and the runs of neighbouring cells
  // of the same width ({ from, count, at, w }), so each run is one whole-pixel scale-up (crisp, no dot ever smeared)
  const edges = (n, size) => Array.from({ length: n + 1 }, (_, i) => Math.round(i * size / n));
  const runsOf = (e) => {
    const out = [];
    for (let i = 0; i < e.length - 1; i++) {
      const w = e[i + 1] - e[i], last = out[out.length - 1];
      if (last && last.w === w) last.count++; else out.push({ from: i, count: 1, at: e[i], w });
    }
    return out;
  };

  function size(cols, rows, { board, unlit, glow = true } = {}) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    // The panel keeps the box the page's style gives it (its width, and its aspect ratio or height), before and after
    // the code runs, so nothing on the page moves. The canvas fills that box at the screen's real density; the dots
    // get whole device pixels each, the few left over spread one by one over the cells, so the dots fill the panel
    // edge to edge (a tap at x is still dot x / width * cols).
    canvas.style.width = ''; canvas.style.height = '';
    const box = canvas.getBoundingClientRect();
    const bw = box.width || canvas.parentElement.clientWidth || 600, bh = box.height || bw * rows / cols;
    const W = Math.max(cols, Math.round(bw * dpr)), H = Math.max(rows, Math.round(bh * dpr));
    L.cols = cols; L.rows = rows; L.unlit = unlit; L.glow = glow;
    canvas.width = W; canvas.height = H;
    const ex = edges(cols, W), ey = edges(rows, H);
    L.runsX = runsOf(ex); L.runsY = runsOf(ey);
    L.low = mk(cols, rows); L.lowG = mk(cols, rows); L.wide = mk(W, rows);
    L.img = L.low.getContext('2d').createImageData(cols, rows); L.px32 = new Uint32Array(L.img.data.buffer);
    L.gimg = L.lowG.getContext('2d').createImageData(cols, rows); L.glow32 = new Uint32Array(L.gimg.data.buffer);
    // the mask: the board everywhere, with a round hole over each dot. All holes the same size, as before (.42 of the
    // dot spacing), and never wider than the narrowest cell, so no hole shows a bit of its neighbour's colour.
    L.mask = mk(W, H);
    const minX = Math.floor(W / cols), minY = Math.floor(H / rows);
    const m = L.mask.getContext('2d'), r = Math.max(.5, Math.min(.42 * W / cols, .42 * H / rows, minX / 2, minY / 2));
    m.fillStyle = board; m.fillRect(0, 0, W, H);
    m.globalCompositeOperation = 'destination-out'; m.beginPath();
    for (let y = 0; y < rows; y++) {
      const cy = (ey[y] + ey[y + 1]) / 2;
      for (let x = 0; x < cols; x++) { const cx = (ex[x] + ex[x + 1]) / 2; m.moveTo(cx + r, cy); m.arc(cx, cy, r, 0, 6.2832); }
    }
    m.fill();
  }

  return {
    size,
    rgb: (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0,   // one pixel, as the image data stores it
    clear() { L.px32.fill(0); L.glow32.fill(0); },
    set(i, px, glow) { L.px32[i] = px; if (glow) L.glow32[i] = px; },
    paint() {
      const W = canvas.width, H = canvas.height, rows = L.rows;
      L.low.getContext('2d').putImageData(L.img, 0, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.fillStyle = L.unlit; ctx.fillRect(0, 0, W, H);                           // every dot starts unlit
      // the lit dots, as squares exactly on their cells: stretched across run by run, then down run by run
      const w = L.wide.getContext('2d');
      w.clearRect(0, 0, W, rows); w.imageSmoothingEnabled = false;
      for (const r of L.runsX) w.drawImage(L.low, r.from, 0, r.count, rows, r.at, 0, r.count * r.w, rows);
      ctx.imageSmoothingEnabled = false;
      for (const r of L.runsY) ctx.drawImage(L.wide, 0, r.from, W, r.count, 0, r.at, W, r.count * r.w);
      ctx.drawImage(L.mask, 0, 0);                                                // cut round
      if (L.glow) {                                                               // and the bright ones glow
        L.lowG.getContext('2d').putImageData(L.gimg, 0, 0);
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = glowAlpha; ctx.imageSmoothingEnabled = true;
        ctx.drawImage(L.lowG, 0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      }
    },
  };
}
