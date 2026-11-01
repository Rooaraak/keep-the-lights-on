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
  const L = { cols: 0, rows: 0, px: 2, img: null, px32: null, gimg: null, glow32: null, low: null, lowG: null, mask: null, unlit: null, glow: true };

  function size(cols, rows, { board, unlit, glow = true } = {}) {
    const w = canvas.parentElement.clientWidth || 600, dpr = Math.min(3, window.devicePixelRatio || 1);
    // whole device pixels per dot at the screen's real density, and the canvas shown at exactly that size (centred,
    // a hair narrower than its box at most), so no dot is ever scaled: crisp, even dots on every screen
    L.cols = cols; L.rows = rows; L.px = Math.max(2, Math.floor(w / cols * dpr)); L.unlit = unlit; L.glow = glow;
    canvas.width = cols * L.px; canvas.height = rows * L.px;
    canvas.style.width = `${cols * L.px / dpr}px`; canvas.style.height = `${rows * L.px / dpr}px`;
    L.low = mk(cols, rows); L.lowG = mk(cols, rows);
    L.img = L.low.getContext('2d').createImageData(cols, rows); L.px32 = new Uint32Array(L.img.data.buffer);
    L.gimg = L.lowG.getContext('2d').createImageData(cols, rows); L.glow32 = new Uint32Array(L.gimg.data.buffer);
    // the mask: the board everywhere, with a round hole over each dot
    L.mask = mk(canvas.width, canvas.height);
    const m = L.mask.getContext('2d'), r = L.px * .42;
    m.fillStyle = board; m.fillRect(0, 0, L.mask.width, L.mask.height);
    m.globalCompositeOperation = 'destination-out'; m.beginPath();
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const cx = (x + .5) * L.px, cy = (y + .5) * L.px; m.moveTo(cx + r, cy); m.arc(cx, cy, r, 0, 6.2832); }
    m.fill();
  }

  return {
    size,
    rgb: (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0,   // one pixel, as the image data stores it
    clear() { L.px32.fill(0); L.glow32.fill(0); },
    set(i, px, glow) { L.px32[i] = px; if (glow) L.glow32[i] = px; },
    paint() {
      const W = canvas.width, H = canvas.height;
      L.low.getContext('2d').putImageData(L.img, 0, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.fillStyle = L.unlit; ctx.fillRect(0, 0, W, H);                           // every dot starts unlit
      ctx.imageSmoothingEnabled = false; ctx.drawImage(L.low, 0, 0, W, H);       // the lit dots, as squares
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
