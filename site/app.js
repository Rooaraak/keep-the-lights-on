// Starts the page: reads config.json and the ride history, then runs live mode (the default) or the replay
// ("Watch a past night", also opened with #past). Both draw on the same LED board; this file only wires buttons
// to whichever mode is showing and runs the one animation loop.
import * as Board from './board.js';
import { createStage } from './cam.js';
import { createTitle } from './sign.js';
import sprites from './sprites.js';
import { createLive } from './live.js';
import { createReplay } from './replay.js';
import { roundStart } from './live-model.js';

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
const setStatus = (msg) => { const el = $('status'); if (el.textContent !== msg || el.childElementCount) { el.textContent = msg; el.dataset.key = ''; } };

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ?config=<file>.json picks another config next to this page (a local test chain, say). Only plain file names.
function configPath() {
  const q = new URLSearchParams(location.search).get('config');
  return q && /^[\w.-]+\.json$/.test(q) ? q : 'config.json';
}

function banner(text) {
  const el = $('banner');
  el.hidden = !text;
  if (text) el.textContent = text;
}

function links(config) {
  const box = $('links'), ex = (config.explorer || '').replace(/\/$/, '');
  box.textContent = '';
  const items = [['SqueekCore', config.squeekCore], ['SQK', config.sqk], ['the game', config.lightsOn]];
  items.forEach(([name, addr], i) => {
    if (!addr) return;
    if (box.childNodes.length) box.append(' · ');
    if (ex) { const a = document.createElement('a'); a.href = `${ex}/address/${addr}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = name; box.append(a); }
    else box.append(`${name} ${addr}`);
    void i;
  });
  if (!config.lightsOn) box.append(' · the game contract is not deployed yet');
}

async function boot() {
  Board.attach($('board'));
  // the top of the page: the LED title switches on, and the hamster cam shows his speed (fed from the same view as the board)
  createTitle($('sign'), { sprites, dark: Board.isDark });
  const cam = createStage($('cam'), { sprites, dark: Board.isDark });
  let config, rides;
  try {
    [config, rides] = await Promise.all([loadJson(configPath()), loadJson('data/rides.json')]);
  } catch (e) {
    banner('The page could not load its settings. Please reload.');
    setText('caption', 'Could not load the page settings.');
    return;
  }
  links(config);

  const replay = createReplay({ $, setText, setStatus });
  const G0 = Number(config.genesis) || rides.genesis;
  const withTimes = (list, G) => list.map((r) => ({ ...r, utc: new Date(roundStart(r.start, G) * 1000).toISOString() }));
  replay.setRides(withTimes(rides.rides, G0));
  const live = createLive({
    $, setText, setStatus, config, base: rides,
    provider: typeof window !== 'undefined' ? window.ethereum : undefined,
    // nights read from the chain join the replay list and the odds
    onRides: (list, G) => replay.setRides(withTimes(list, G)),
  });

  let mode = null;
  function show(next) {
    if (mode === next) return;
    if (mode) mode.exit();
    mode = next;
    $('modeLive').setAttribute('aria-pressed', String(next === live));
    $('modeReplay').setAttribute('aria-pressed', String(next === replay));
    mode.enter();
  }

  $('modeLive').addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search); show(live); });
  $('modeReplay').addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search + '#past'); show(replay); });
  $('bMinus').addEventListener('click', () => mode.minus());
  $('bPlus').addEventListener('click', () => mode.plus());
  for (const id of ['b50', 'b100', 'b200']) $(id).addEventListener('click', (e) => mode.amount(+e.currentTarget.dataset.bet));
  $('amtOther').addEventListener('input', (e) => { const v = e.currentTarget.value.trim(); if (mode === live) mode.amount(v || '100', !!v); });
  $('act').addEventListener('click', () => mode.act());
  $('board').addEventListener('click', (e) => mode.board(e.clientX));
  $('again').addEventListener('click', () => replay.again());
  $('ride').addEventListener('change', () => replay.ride());
  for (const id of ['sp1', 'sp2', 'sp4']) $(id).addEventListener('click', (e) => replay.speed(+e.currentTarget.dataset.sp));
  $('sound').addEventListener('click', (e) => {
    const on = Board.toggleSound();
    e.currentTarget.textContent = on ? 'Sound on' : 'Sound off'; e.currentTarget.setAttribute('aria-pressed', String(on));
    Board.sfx.tick();
  });

  let resizeT = 0;
  new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(Board.setup, 120); }).observe($('board').parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', Board.setup);
  new MutationObserver(Board.setup).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  show(location.hash === '#past' ? replay : live);
  live.start();
  window.lightsPage = { live, replay, config, mode: () => (mode === live ? 'live' : 'replay'), bulbPoint: Board.bulbPoint }; // for tests and the console

  let last = 0, acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.1, (now - (last || now)) / 1000); last = now;
    acc += dt;
    if (acc < 1 / 32) return;
    const step = acc, time = now / 1000; acc = 0;
    try {
      const v = mode.view(time, step);
      Board.draw(v, time, step);
      const running = !v.resting;
      cam.set({ rpm: running ? (v.pace || 0) / 10 : 0, running });
      if (running !== frame.running) { frame.running = running; $('cam').setAttribute('aria-label', `Hamster cam: Squeektoshi is ${running ? 'running and the big bulb glows' : 'asleep and the big bulb is dark'}`); }
    } catch (e) {
      // one bad frame must not stop the board; show it once
      if (!frame.failed) { frame.failed = true; banner('Something went wrong drawing the board. Please reload the page.'); setTimeout(() => { throw e; }); }
    }
  }
  requestAnimationFrame(frame);
}

boot();
