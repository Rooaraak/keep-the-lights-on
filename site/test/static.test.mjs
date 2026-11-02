#!/usr/bin/env node
// Static checks of site: the page skeleton (doctype, lang, charset, viewport), every local file the page
// loads exists, no script from anywhere else, config.json has the keys the task names, the chain code keeps every
// read and write in chain.js, and the wording rules (no "can't lose", no jargon on the page, no `transition: all`).
// Usage: node site/test/static.test.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(SITE, f), 'utf8');
let failures = 0;
const ok = (cond, msg, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail ? ` (${detail})` : ''}`); if (!cond) failures++; };

const html = read('index.html');
ok(/^<!doctype html>/i.test(html) && /<html lang="en">/.test(html) && /<meta charset="utf-8">/.test(html) && /name="viewport"/.test(html), 'index.html has a doctype, lang, charset and viewport');
ok(/<title>Keep the Lights On<\/title>/.test(html), 'title "Keep the Lights On"');
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
ok(scripts.length === 1 && scripts[0] === 'app.js' && /type="module"/.test(html), 'one local module script, no libraries', scripts.join(', '));
const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
ok(styles.every((h) => h === 'styles.css' || h.startsWith('https://fonts.googleapis.com/')), 'stylesheets: styles.css and Google Fonts only', styles.join(', '));
const js = readdirSync(SITE).filter((f) => f.endsWith('.js'));
const imports = js.flatMap((f) => [...read(f).matchAll(/^import .* from '([^']+)';/gm)].map((m) => [f, m[1]]));
ok(imports.every(([, p]) => /^\.\/[\w-]+\.js$/.test(p) && existsSync(join(SITE, p))), 'every import is a local file that exists', imports.filter(([, p]) => !existsSync(join(SITE, p))).join(' '));
for (const f of ['icon.svg', 'styles.css', 'config.json', 'data/rides.json']) ok(existsSync(join(SITE, f)), `${f} exists`);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set(js.flatMap((f) => [...read(f).matchAll(/\$\('([\w-]+)'\)|setText\('([\w-]+)'/g)].map((m) => m[1] || m[2])));
const missing = [...used].filter((id) => !ids.has(id));
ok(!missing.length, `every element the scripts use is in index.html (${used.size})`, missing.join(', '));

const cfg = JSON.parse(read('config.json'));
// the real game, deployed through IMD on 2026-11-02 (launch 2876): its address and the block it was deployed in
ok(cfg.chainId === 11155111 && Array.isArray(cfg.rpc) && cfg.rpc.length >= 2 && cfg.squeekCore && cfg.sqk && cfg.lightsOn === '0x262c88c4eedf3d543d2523f87fa47701ac429844' && cfg.deployBlock === 12048847 && !cfg.practice, 'config.json: Sepolia, an rpc list, SqueekCore, SQK, the real game 0x262c…9844 from block 12048847, not practice');

// all network access lives in chain.js
const net = js.filter((f) => f !== 'chain.js' && f !== 'app.js' && /\bfetch\(|eth_|window\.ethereum|\.request\(/.test(read(f)));
ok(!net.length, 'no file but chain.js talks to the chain or the status API (app.js only loads its own JSON and hands window.ethereum over)', net.join(', '));
ok(!/\bfetch\([^)]*(rpc|api)/i.test(read('app.js')) && (read('app.js').match(/fetch\(/g) || []).length === 1, 'app.js fetches only its own config and ride history');
ok(!/coreStatus/.test(read('chain.js').replace(/\/\/.*$/gm, '')), 'coreStatus is never read');
ok(!/ff{60}|MaxUint|2n \*\* 256n|1n << 256n\) - 1n/.test(read('chain.js').replace(/\/\/.*$/gm, '')) && /encode\.approve\(game, amount\)/.test(read('chain.js')), 'the only allow is for exactly the bet amount');

// wording and style rules
const pageText = html.replace(/<[^>]+>/g, ' ') + js.map((f) => [...read(f).matchAll(/'([^'\n]{12,})'|`([^`\n]{12,})`/g)].map((m) => m[1] || m[2]).join(' ')).join(' ');
ok(!/can.?t lose/i.test(pageText), 'never says "can\'t lose"');
const shown = html.replace(/<script[\s\S]*?<\/script>|<[^>]+>/g, ' ');
ok(!/\b(claim|approve|approval|revert|nonce|gas|allowance)\b/i.test(shown), 'no jargon in the page text', (shown.match(/\b(claim|approve|approval|revert|nonce|gas|allowance)\b/i) || [])[0]);
ok(!/transition:\s*all/.test(read('styles.css')), 'no `transition: all`');
ok(!js.some((f) => /console\.(log|error|warn)\(/.test(read(f))), 'no console logging in the page code');
ok(/prefers-reduced-motion/.test(read('board.js')) && /prefers-color-scheme: dark/.test(read('styles.css')), 'reduced motion and dark mode are handled');

console.log(failures ? `\n${failures} failure(s)` : '\nall static checks passed');
process.exit(failures ? 1 : 0);
