#!/usr/bin/env node
// End-to-end test of the real page (site/) on local anvil chains, in Chrome, through a fake browser wallet.
// Nothing leaves the box: anvil only, anvil's unlocked dev accounts (no keys), the page's fonts answered empty.
//
//   chain 1 (MockCore + MockSQK + LightsOn, real rounds 45-105 from data/rounds.json, played live round by round)
//     S1 phone 390x844 light:  connect, wrong network -> add + switch, bets too small / too large, not enough SQK,
//                              saying no in the wallet, no ETH for the fee, allow exactly + bet, "already bet" (a bet
//                              from another device), reload keeps your bet
//     S2 desktop 1280x900 dark: real night 1 (45-63: 14 bulbs, two breaks): the board follows every round, a bulb
//                              that gets too close while the wallet asks, a bet in a quiet round (it counts for the
//                              next ride), the blackout, results, collect == an independent copy of the rule
//     S3 phone 390x844 light, reduced motion: real night 2 (nobody wins: the pot rolls on as the bonus pot) and
//                              night 3 (it pays the bonus pot), collect right after the blackout
//                              then: the wallet moves to another network, an old wheel reading, records running
//                              late, a paused core, a bet the network includes too late (it must fail and say so)
//   chain 2 (all 780 real rounds, then made-up long nights)
//     S4 desktop 1280x900 dark: the page's nights == data/rides.json, odds, past nights, the dashboard at 800 and
//                              1000 px; the last two rounds of a 36-round night; collect after a long quiet spell (a
//                              helper first); a returning player after a long busy spell (the game must catch up first)
//     S5 phone 390x844 dark:   he sleeps 7 days, the game is ended (void): refunds shown and collected
// Every Chrome launch is killed at 85 s. Checks: plain words, no console errors, no sideways scroll.
// Every payout is checked three ways: an independent copy of the rule (e2e/reference.mjs, itself checked against
// data/lights-vectors.json), what the contract says it owes (betOutcome), and the SQK that actually arrives.
// Usage: node site/test/e2e.test.mjs [--out <dir for screenshots>] [--only S1,S2,...]
// (S1-S3 share chain 1 and S4-S5 chain 2, so --only runs them in order on a fresh chain: S2 needs S1, S5 needs S4)
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as C from '../chain.js';
import * as H from './e2e/harness.mjs';
import * as R from './e2e/reference.mjs';

const { W, sleep, sqkText } = H;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--out') ? resolve(arg('--out')) : mkdtempSync(join(tmpdir(), 'lights-e2e-'));
mkdirSync(SHOTS, { recursive: true });
if (!arg('--out')) process.on('exit', () => rmSync(SHOTS, { recursive: true, force: true }));
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const t = H.createChecks();
const { check } = t;
const ROUNDS = JSON.parse(readFileSync(join(H.ROOT, 'data', 'rounds.json'), 'utf8'));
const RIDES = JSON.parse(readFileSync(join(H.SITE, 'data', 'rides.json'), 'utf8')).rides;
const REAL = new Map(ROUNDS.active.map((a) => [a.id, a.work]));
const realWorks = (from, to) => new Map([...REAL].filter(([id]) => id >= from && id <= to));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const JARGON = /\b(claim|claimed|approve|approval|revert|reverted|nonce|allowance|calldata|gas limit)\b/i;

// the independent reference over everything chain `c` holds right now
async function reference(c) {
  const bets = (await c.allBets()).map((b) => ({ id: b.id, stake: b.stake, bulb: b.bulb, betRound: b.betRound }));
  return R.settleAll({ active: new Set(c.active.keys()), after: c.startRound, through: c.settled, bets, station: c.station });
}

// common page checks at the end of a session
async function pageHygiene(P, s, label, width) {
  await dashOk(P, label);
  const sw = await P.scrollWidth();
  check(sw <= width, `${label}: no sideways scroll (page ${sw} px wide at ${width})`, String(sw));
  const body = await P.bodyText();
  check(!/can.?t lose/i.test(body), `${label}: never says "can't lose"`);
  check(!JARGON.test(body), `${label}: no jargon on the page`, (body.match(JARGON) || [])[0]);
  check(s.errors.length === 0, `${label}: no console errors`, s.errors.slice(0, 5).join(' | '));
}

// the dashboard row is readable: "your bulb" and the one number get real width and stay on one line
async function dashOk(P, label) {
  const d = await P.dash();
  return check(d.cells.length === 2 && d.cells.every((w) => w >= 130) && d.you === 1 && d.money === 1, `${label}: the dashboard row is readable (cells ${d.cells.join(' / ')} px, "your bulb" on ${d.you} line, the number on ${d.money})`, JSON.stringify(d));
}

async function openPage(ctx, { label, viewport, scheme, reducedMotion }) {
  const s = await H.launch({ viewport, scheme, reducedMotion, label, t });
  await ctx.wallet.attach(s.page);
  await s.page.goto(`${ctx.web.origin}/index.html?config=config.e2e.json`, { waitUntil: 'load' });
  const P = H.pageTools(s.page);
  await P.watchBoard();
  return { s, P, page: s.page };
}

// ================================================================= chain 1

async function chain1() {
  const anvil = await H.startAnvil();
  const c = await H.createTestChain(anvil, { round: 40, secs: 15, startRound: 39 });
  await c.record(39);
  const [, me, me2, p3, p4, p5, p6, p7, p8, p9, poor, noEth] = c.accounts;
  for (const a of [me, me2, p3, p4, p5, p6, p7, p8, p9, noEth]) await c.mint(a, 1000n * W);
  const state = { wheel: 0, config: null };
  const web = await H.startWeb(state);
  state.config = { ...c.chainCfg, chainName: 'Test chain', explorer: '', walkFrom: 39, clock: 'chain', statusApi: `${web.origin}/__status`, wheelHoldMs: 0 }; // rounds are fast-forwarded here: the blip hold has its own tests in chain.test.mjs
  const wallet = H.createFakeWallet(anvil, { account: me, chainId: '0x1' });
  return { anvil, c, state, web, wallet, me, me2, p3, p4, p5, p6, p7, p8, p9, poor, noEth, ids: {} };
}

// ---------------------------------------------------------------- S1: before his first ride
async function S1(ctx) {
  const { c, wallet, me, me2, p3, p4, p9 } = ctx;
  // two players bet before the page opens (round 40, he is asleep), one on a bulb that will stay dark
  ctx.ids.p3 = (await c.betDirect(p3, 2, 100n * W)).betId;
  ctx.ids.p4 = (await c.betDirect(p4, 5, 200n * W)).betId;
  ctx.ids.p9 = (await c.betDirect(p9, 20, 500n * W)).betId;
  ctx.state.wheel = 0;
  const { s, P, page } = await openPage(ctx, { label: 'S1 phone 390x844 light', viewport: { width: 390, height: 844 }, scheme: 'light' });
  try {
    check(await P.waitText('#act', /Connect wallet/), 'S1: with a game, the button is "Connect wallet"', await P.text('#act'));
    await P.waitText('#riders', /bulb 20/);
    check(/He is asleep\. A bet now counts for his next ride/.test(await P.text('#status')), 'S1: he is asleep: "A bet now counts for his next ride"', await P.text('#status'));
    check(/bulb 2.*bulb 5.*bulb 20/.test(await P.text('#riders')) && /Bets for his next ride/.test(await P.text('#playersTitle')), 'S1: the three bets placed so far are listed for his next ride', await P.text('#riders'));
    const b0 = await P.waitBoard((b) => /ASLEEP/.test(b.msg));
    check(b0 && b0.msg === 'HE IS ASLEEP * BETS NOW COUNT FOR HIS NEXT RIDE' && b0.lit === 0 && [2, 5, 20].every((k) => b0.markers.includes(k)), 'S1: the board: asleep, no bulb lit, markers on bulbs 2, 5, 20', JSON.stringify(b0));

    // ---- connect, then the wallet is on another network it doesn't know yet: add it, switch
    await P.click('#act');
    check(await P.waitText('#act', /Switch to Test chain/), 'S1: connected on another network: the button is "Switch to Test chain"', await P.text('#act'));
    check(/another network/.test(await P.text('#walletLine')), 'S1: the wallet line says the wallet is on another network', await P.text('#walletLine'));
    await P.click('#act');
    check(await P.waitText('#act', /^Bet 100 SQK on bulb \d+$/), 'S1: after switching, the button offers a bet', await P.text('#act'));
    const li = wallet.log.indexOf('wallet_switchEthereumChain');
    check(li >= 0 && wallet.log.indexOf('wallet_addEthereumChain') > li && wallet.added && wallet.added.chainId === '0x7a69' && wallet.added.rpcUrls[0] === c.url && wallet.added.chainName === 'Test chain', 'S1: the unknown network was added to the wallet (chain 0x7a69, the page\'s RPC, its name), then switched to', JSON.stringify(wallet.added));
    check(await P.waitText('#walletLine', /you have 1,000 SQK/), 'S1: the wallet line shows your 1,000 SQK', await P.text('#walletLine'));

    // ---- amounts: too small, too large, more than you have
    const sends0 = wallet.sends.length;
    await P.typeAmount(5);
    check(/^Pick a bet$/.test(await P.text('#act')) && await P.disabled('#act'), 'S1: a 5 SQK bet: the button is off ("Pick a bet")', await P.text('#act'));
    check(/10 (to|and) 10,000 SQK/.test(await P.text('#status')), 'S1: a 5 SQK bet: the page says in plain words that bets are 10 to 10,000 SQK', await P.text('#status'));
    await P.typeAmount(20000);
    check(/^Pick a bet$/.test(await P.text('#act')) && await P.disabled('#act'), 'S1: a 20,000 SQK bet: the button is off', await P.text('#act'));
    check(/10 (to|and) 10,000 SQK/.test(await P.text('#status')), 'S1: a 20,000 SQK bet: the page says bets are 10 to 10,000 SQK', await P.text('#status'));
    await P.typeAmount(5000);
    check(await P.text('#act') === 'Not enough SQK' && !(await P.disabled('#act')), 'S1: 5,000 SQK with 1,000 in the wallet: the button says "Not enough SQK"', await P.text('#act'));
    await P.click('#act');
    check(await P.waitText('#status', /Not enough SQK: you have 1,000, this bet needs 5,000\./), 'S1: more than you have: "Not enough SQK: you have 1,000, this bet needs 5,000."', await P.text('#status'));
    check(wallet.sends.length === sends0, 'S1: nothing was sent to the wallet for any of these');
    await P.click('#b100');
    await sleep(300);

    // ---- saying no in the wallet
    wallet.refuse = 1;
    await P.click('#act');
    check(await P.waitText('#status', /You said no in your wallet, so nothing was sent\./), 'S1: saying no in the wallet: "You said no in your wallet, so nothing was sent."', await P.text('#status'));
    check((await c.allowance(me)) === 0n && wallet.sends.at(-1).refused && wallet.sends.at(-1).data.startsWith(C.SEL.approve), 'S1: the refused step was the allow step, and nothing is allowed');

    // ---- no test ETH for the fee
    await c.setEth(me, 0n);
    await sleep(200);
    await P.click('#act');
    check(await P.waitText('#status', /needs a little .*ETH to pay the network fee/), 'S1: no ETH for the fee: "Your wallet needs a little ... ETH to pay the network fee."', await P.text('#status'));
    await c.setEth(me, 1000n * W);

    // ---- the bet: bulb 3, allow exactly 100, then bet
    check(await P.pickBulb(3), 'S1: bulb 3 can be picked before he starts', await P.text('#bPick'));
    const st = await P.state();
    check(st.floor <= 2 && st.night === 'next', `S1: asleep: the lowest bulb offered is ${st.floor}, for his next ride`, JSON.stringify(st));
    check(/for his next ride/.test(await P.text('#youSub')) && /^Bulb 3 · 30 min · no nights to count yet$/.test(await P.text('#pickOdds')), 'S1: "for his next ride" under your bulb; the odds next to the picker', `${await P.text('#youSub')} / ${await P.text('#pickOdds')}`);
    // bets on 2, 5 and 20: bulb 3 gets its best case while he lights 3 or 4 bulbs (at 5, the bet on bulb 5 takes a slice)
    check(/^Best case: he lights 3 to 4 bulbs$/.test(await P.text('#moneyLabel')) && /^[+−±][\d,.]* SQK$/.test(await P.text('#money')), `S1: the one number, with its unit: ${await P.text('#money')}, best case "${await P.text('#moneyLabel')}"`);
    check(await P.text('#moneySub') === 'test SQK, no real money', 'S1: under the number, right above the bet buttons: "test SQK, no real money"', await P.text('#moneySub'));
    await page.screenshot({ path: join(SHOTS, 's1-before-bet.png') });
    const sendsBefore = wallet.sends.length;
    await P.click('#act');
    check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 3, for his next ride\./, 20_000), 'S1: "Bet placed: 100 SQK on bulb 3, for his next ride."', await P.text('#status'));
    const sent = wallet.sends.slice(sendsBefore);
    check(sent.length === 2 && sent[0].data === C.encode.approve(c.lights, 100n * W) && sent[0].to.toLowerCase() === c.sqk.toLowerCase(), 'S1: two wallet steps; the first allows the game exactly 100 SQK (never more)', sent.map((x) => x.data.slice(0, 10)).join(', '));
    const betTx = sent[1] || { data: '' };
    const myBet = (await c.allBets()).find((b) => b.owner.toLowerCase() === me.toLowerCase());
    ctx.ids.me1 = myBet && myBet.id;
    check(myBet && myBet.bulb === 3 && myBet.stake === 100n * W && myBet.betRound === 40, 'S1: the contract holds your bet: bulb 3, 100 SQK, sent in round 40', JSON.stringify(myBet, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    check(betTx.data.startsWith('0xffc37000') && BigInt('0x' + betTx.data.slice(2 + 128, 2 + 192)) >= 40n, 'S1: the bet is sent as betUntil(bulb, amount, the round the page showed), so a bet that waits too long fails instead of moving to a later round', betTx.data.slice(0, 10));
    check(betTx.gas && BigInt(betTx.gas) >= 1_500_000n, 'S1: the bet is sent with a fixed gas limit of at least 1,500,000 (audit A3)', String(betTx.gas));
    check((await c.allowance(me)) === 0n, 'S1: nothing is left allowed after the bet');
    await P.refresh({ bets: 4 });
    check(await P.waitText('#act', /^Bet placed$/) && await P.disabled('#act'), 'S1: the button now says "Bet placed"', await P.text('#act'));
    check(await P.waitText('#mine', /Bulb 3 · 100 SQK.*waits for his next ride/), 'S1: your bets: "Bulb 3 · 100 SQK", waits for his next ride', await P.text('#mine'));
    check(/^You/.test(await P.text('#riders')), 'S1: you are listed first among the bets', await P.text('#riders'));

    // ---- already bet: me2 bets from another device while this page shows the bet button
    await wallet.switchAccount(me2);
    check(await P.waitText('#walletLine', new RegExp(`${me2.slice(0, 6)}.*you have 1,000 SQK`)), 'S1: the wallet switched accounts: the page follows', await P.text('#walletLine'));
    ctx.ids.me2 = (await c.betDirect(me2, 4, 50n * W)).betId;
    const sends1 = wallet.sends.length;
    if (/^Bet /.test(await P.text('#act'))) {
      await P.click('#act');
      check(await P.waitText('#status', /You already have a bet on this ride\. It's one bet per ride/), 'S1: a second bet on the same ride: "You already have a bet on this ride. It\'s one bet per ride..."', await P.text('#status'));
      check(wallet.sends.length === sends1, 'S1: and nothing was sent to the wallet (the check runs first)');
    } else check(false, 'S1: the page should still offer the bet button here', await P.text('#act'));
    check(await P.waitText('#act', /^Bet placed$/, 35_000), 'S1: the page then finds the bet from the other device ("Bet placed")', await P.text('#act'));
    await wallet.switchAccount(me);
    await P.waitText('#walletLine', new RegExp(me.slice(0, 6)));

    // ---- reload: your bet is still there
    await page.reload({ waitUntil: 'load' });
    await P.watchBoard();
    check(await P.waitText('#mine', /Bulb 3 · 100 SQK.*waits for his next ride/), 'S1: after a reload, your bet is still shown (from the chain, not the browser)', await P.text('#mine'));
    check(await P.waitText('#act', /^Bet placed$/), 'S1: after a reload, the button still says "Bet placed"', await P.text('#act'));
    const b1 = await P.waitBoard((b) => b.markers.includes(3));
    check(b1 && b1.markers.includes(3) && b1.pick === 3, 'S1: after a reload, the board marks your bulb 3', JSON.stringify(b1));
    await page.screenshot({ path: join(SHOTS, 's1-after-reload.png'), fullPage: true });
    await pageHygiene(P, s, 'S1', 390);
  } catch (e) {
    check(false, `S1 crashed: ${e.stack || e}`);
  } finally { await s.close(); }
}

// ---------------------------------------------------------------- S2: his first night (real rounds 45-63)
async function S2(ctx) {
  const { c, wallet, me, p5, p6, p7, p8 } = ctx;
  const works = realWorks(45, 63); // 45 departs, bulbs in 46-53, a break in 54, 55-57, a break in 58, 59-61, out in 62-63
  ctx.state.wheel = 0;
  const { s, P, page } = await openPage(ctx, { label: 'S2 desktop 1280x900 dark', viewport: { width: 1280, height: 900 }, scheme: 'dark' });
  const seen = [];
  try {
    await P.waitText('#act', /Bet placed/);
    let tooCloseDone = false, quietDone = false;
    for (let r = 44; r <= 63; r++) {
      await c.at(r + 1, 40);
      await c.record(r, works);
      ctx.state.wheel = works.has(r + 1) ? 300 : 0;
      check(await P.refresh({ S: r }), `S2: the page reads round ${r}`);
      const st = await P.state();
      const ref = R.nights(new Set(c.active.keys()), c.startRound, r, c.station);
      const want = ref.open ? { lit: ref.open.litRounds.length - 1, quiet: ref.open.quiet } : null;
      const b = await P.waitBoard((x) => (ref.open ? x.lit === want.lit : true));
      seen.push(`${r}:${b && b.lit}${b && b.flicker ? '~' : ''}`);
      if (r === 44) {
        // (your bet from S1 was sent before he left: it is on the ride he just started, not "his next ride"). The board
        // shows 0 lit both before and after the departure is read, so wait for the words, not the board.
        await P.waitText('#status', /He just got on the wheel|^Your bet is on the ride he just started\.$|^Bet placed/);
        await P.waitText('#playersTitle', /^This ride's bets$/);
        const st44 = await P.text('#status');
        check(/He just got on the wheel\. You can bet on bulb 2 or higher\./.test(st44) || /^Your bet is on the ride he just started\.$/.test(st44) || /^Bet placed/.test(st44), 'S2: round 45 starts with the wheel turning: "He just got on the wheel" (with your bet from before: "Your bet is on the ride he just started.")', st44);
        check(!/asleep|next ride/.test(st44) && /^This ride's bets$/.test(await P.text('#playersTitle')), 'S2: ... not "asleep" or "his next ride"; the list is "This ride\'s bets"', `${st44} / ${await P.text('#playersTitle')}`);
        const b44 = await P.waitBoard((x) => x.msg === 'HE IS ON THE WHEEL * LIGHTS ON SOON');
        check(b44 && b44.msg === 'HE IS ON THE WHEEL * LIGHTS ON SOON', 'S2: the board: "HE IS ON THE WHEEL * LIGHTS ON SOON"', b44 && b44.msg);
        // two players bet in the departure round: bulb 2 counts, bulb 1 (lights in the next round) is given back
        ctx.ids.p5 = (await c.betDirect(p5, 2, 100n * W)).betId;
        ctx.ids.p6 = (await c.betDirect(p6, 1, 100n * W)).betId;
      }
      if (r === 45) check(st.open && st.open.start === 45 && st.lit === 0 && b.msg === 'HE IS ON THE WHEEL * WARMING UP', 'S2: round 45 recorded: the ride is on, warming up, no bulb yet', JSON.stringify({ open: st.open, msg: b && b.msg }));
      if (ref.open && r > 45) {
        check(st.lit === want.lit && b.lit === want.lit, `S2: round ${r}: ${want.lit} bulbs lit on the page and on the board`, `${st.lit}/${b && b.lit}`);
        // a quiet round recorded while the wheel turns again right now (what the cam shows): he is back, no flicker
        const back = want.quiet === 1 && works.has(r + 1);
        const flick = !back && (want.quiet > 0 || !works.has(r + 1));
        check(b.flicker === flick, `S2: round ${r}: the bulbs ${flick ? 'flicker (a quiet round)' : back ? 'shine steadily (a quiet round, but the wheel turns again)' : 'shine steadily'}`, JSON.stringify(b));
        if (back) check(b.msg === `HE IS BACK ON THE WHEEL * NEXT: BULB ${want.lit + 1}` && !b.resting, `S2: round ${r} was quiet and the wheel turns again: "HE IS BACK ON THE WHEEL * NEXT: BULB ${want.lit + 1}", and the cam runs`, JSON.stringify(b));
        else if (want.quiet === 1) check(b.msg === 'LIGHTS FLICKER ... IS HE ASLEEP?', `S2: round ${r} was quiet: "LIGHTS FLICKER ... IS HE ASLEEP?"`, b.msg);
        else if (!works.has(r + 1)) check(b.msg === 'SHORT BREAK * LIGHTS FLICKER', `S2: round ${r + 1} is quiet so far: "SHORT BREAK * LIGHTS FLICKER"`, b.msg);
        else check(b.msg === `HE IS RUNNING * NEXT: BULB ${want.lit + 1}`, `S2: round ${r}: "HE IS RUNNING * NEXT: BULB ${want.lit + 1}"`, b.msg);
        check(st.floor === want.lit + (st.N + 1 - r) + 1, `S2: round ${r}: lowest bulb offered ${st.floor} = lit ${want.lit} + rounds not recorded yet ${st.N + 1 - r} + 1`, JSON.stringify(st));
      }
      if (r === 48 && !tooCloseDone) {
        tooCloseDone = true;
        // ---- a bulb that gets too close while the wallet asks: p7 picks the lowest bulb (6), the next round's record
        // arrives while the wallet's allow window is open, and bulb 6 is then too close
        await wallet.switchAccount(p7);
        await P.waitText('#walletLine', new RegExp(p7.slice(0, 6)));
        await P.waitText('#act', /^Bet 100 SQK on bulb/);
        check(Number(await P.text('#bPick')) === 6 && !(await P.pickBulb(5)), 'S2: 3 bulbs lit, round 49 running: bulb 5 is not offered, bulb 6 is the lowest', await P.text('#bPick'));
        wallet.hold = async (tx) => {
          if (!tx.data.startsWith(C.SEL.approve)) return;
          wallet.hold = null;
          await c.at(50, 40);
          await c.record(49, works);
          ctx.state.wheel = 300;
          await P.refresh({ S: 49 });
        };
        const n0 = wallet.sends.length;
        await P.click('#act');
        check(await P.waitText('#status', /Bulb 6 got too close while you were confirming, so the bet wasn't sent\..*bulb 7 or higher/, 20_000), 'S2: "Bulb 6 got too close while you were confirming, so the bet wasn\'t sent ... bulb 7 or higher"', await P.text('#status'));
        check(wallet.sends.length === n0 + 1 && wallet.sends[n0].data.startsWith(C.SEL.approve), 'S2: only the allow step went out, no bet');
        check(Number(await P.text('#bPick')) === 7, 'S2: the picker moved up to bulb 7', await P.text('#bPick'));
        await P.click('#act');
        check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 7, for tonight's ride\./, 20_000), 'S2: pressed again: "Bet placed: 100 SQK on bulb 7, for tonight\'s ride." (one wallet step: the allow was already there)', await P.text('#status'));
        check(wallet.sends.length === n0 + 2, 'S2: the second press needed one wallet step');
        ctx.ids.p7 = (await c.allBets()).find((x) => x.owner.toLowerCase() === p7.toLowerCase()).id;
        r = 49; // round 49 is recorded already
        continue;
      }
      if (r === 61 && !quietDone) {
        quietDone = true;
        // ---- round 62 is quiet so far: a bet now counts tonight if he runs again, else for his next ride
        await wallet.switchAccount(p8);
        await P.waitText('#walletLine', new RegExp(`${p8.slice(0, 6)}.*1,000 SQK`));
        check(await P.waitText('#status', /He stopped for a moment\. A bet now counts for this ride, or for his next ride if the lights go out\. Bulb 17 or higher\./), 'S2: round 62 is quiet: "He stopped for a moment. A bet now counts for this ride, or for his next ride if the lights go out. Bulb 17 or higher."', await P.text('#status'));
        check(/for tonight, or his next ride if the lights go out/.test(await P.text('#youSub')), 'S2: under your bulb: "for tonight, or his next ride if the lights go out"', await P.text('#youSub'));
        await P.click('#act');
        check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 17, for tonight, or his next ride if the lights go out\./, 20_000), 'S2: "Bet placed: 100 SQK on bulb 17, for tonight, or his next ride if the lights go out."', await P.text('#status'));
        ctx.ids.p8 = (await c.allBets()).find((x) => x.owner.toLowerCase() === p8.toLowerCase()).id;
        const pb = await c.getBet(ctx.ids.p8);
        check(pb.betRound === 62, 'S2: the bet was sent in round 62 (the first of the two quiet rounds)', String(pb.betRound));
      }
      if (r === 63) {
        check(st.rides.length === 1 && st.rides[0].start === 45 && st.rides[0].C === 62 && st.rides[0].lit === 14 && !st.open, 'S2: the blackout: the page\'s night 1 = start 45, lights out in 62, 14 bulbs', JSON.stringify(st.rides));
        check(RIDES[0].start === 45 && RIDES[0].C === 62 && RIDES[0].lit === 14, 'S2: ... the same as night 1 in data/rides.json');
        const bo = await P.waitBoard((x) => /BLACKOUT/.test(x.msg));
        check(bo && bo.msg === 'BLACKOUT AFTER 14 BULBS * SWEET DREAMS', 'S2: the board: "BLACKOUT AFTER 14 BULBS * SWEET DREAMS"', bo && bo.msg);
        // the 14 lights go out on the board, then it shows his next ride (no bulb lit, scrolled to bulb 1) with the
        // bet for it on bulb 17 and the picked bulb; the sign still says how far he got
        const of = await P.outFrame();
        check(of && of.lit === 14 && of.outP >= 0 && of.outP < 1 && !of.markers.length && !of.pick, 'S2: while the lights go out, the board shows the 14 lit bulbs going dark (no marks)', JSON.stringify(of));
        const nx = await P.waitBoard((x) => /BLACKOUT/.test(x.msg) && x.outP == null, 6000);
        check(nx && nx.outP == null && nx.lit === 0 && nx.markers.includes(17) && nx.pick === 17, 'S2: then the board shows his next ride: no bulb lit, your bet on bulb 17 marked, the sign still "BLACKOUT AFTER 14 BULBS"', JSON.stringify(nx));
        check(await P.waitText('#status', /^Blackout after 14 bulbs\./), 'S2: the sentence under the dashboard starts "Blackout after 14 bulbs."', await P.text('#status'));
        check(await P.waitText('#mine', /Bulb 17 · 100 SQK.*waits for his next ride/), 'S2: the bet sent in the quiet round now waits for his next ride', await P.text('#mine'));
        check(/Bets for his next ride/.test(await P.text('#playersTitle')) && /bulb 17/.test(await P.text('#riders')), 'S2: and it is listed under "Bets for his next ride"', await P.text('#riders'));
      }
    }
    console.log(`     bulbs on the board after each round: ${seen.join(' ')}`);

    // ---- results: you (bulb 3) collect what the rule says
    const ref = await reference(c);
    const mine = ref.byBet.get(ctx.ids.me1);
    check(ref.nights.length === 1 && ref.nights[0].lit === 14 && ref.byBet.get(ctx.ids.p6).cls === 'refund' && ref.byBet.get(ctx.ids.p9).cls === 'lose' && ref.byBet.get(ctx.ids.p8) === undefined, 'S2: the reference: night 1 lit 14; bulb 1 sent in the departure round is given back; bulb 20 loses; the quiet-round bet is not in night 1');
    await wallet.switchAccount(me);
    await P.waitText('#walletLine', new RegExp(me.slice(0, 6)));
    const want = `Collect ${sqkText(mine.payout)} SQK`;
    check(await P.waitText('#act', new RegExp(`^${want}$`), 20_000), `S2: right after the blackout the button is "${want}" (the rule's ${mine.payout} wei)`, await P.text('#act'));
    check(await P.waitText('#mine', new RegExp(`Bulb 3 · 100 SQK.*lit · ${sqkText(mine.payout).replace('.', '\\.')} SQK to collect`)), 'S2: your bets: "lit · ... SQK to collect"', await P.text('#mine'));
    check(new RegExp(`Your bulb 3 lit\\. Press Collect to count the ride and take your ${sqkText(mine.payout).replace('.', '\\.')} SQK\\.`).test(await P.text('#status')), 'S2: "Your bulb 3 lit. Press Collect to count the ride and take your ... SQK."', await P.text('#status'));
    await dashOk(P, 'S2 with Collect showing');
    await page.screenshot({ path: join(SHOTS, 's2-blackout.png'), fullPage: true });
    const before = await c.balance(me), n0 = wallet.sends.length;
    await P.click('#act');
    check(await P.waitText('#status', new RegExp(`Collected ${sqkText(mine.payout).replace('.', '\\.')} SQK\\.`), 20_000), `S2: "Collected ${sqkText(mine.payout)} SQK."`, await P.text('#status'));
    const got = (await c.balance(me)) - before;
    check(got === mine.payout, `S2: exactly ${mine.payout} wei arrived, the rule's number`, String(got));
    const sends = wallet.sends.slice(n0);
    check(sends.length === 1 && sends[0].data.startsWith(C.SEL.claim), 'S2: one wallet step: collect counted the ride itself', sends.map((x) => x.data.slice(0, 10)).join());
    check(sends[0] && sends[0].gas && BigInt(sends[0].gas) >= 1_000_000n, 'S2: collect is sent with a fixed gas limit of at least 1,000,000', String(sends[0] && sends[0].gas));
    await P.refresh();
    check(await P.waitText('#mine', /Bulb 3 · 100 SQK.*collected/), 'S2: your bets: collected', await P.text('#mine'));
    check(!/^Collect/.test(await P.text('#act')), 'S2: no second Collect for the same bet', await P.text('#act'));
    // ---- everyone else's payout, as the contract pays it, == the reference
    await c.send(c.deployer, c.lights, C.encode.settle(500));
    const bad = [];
    for (const [id, x] of ref.byBet) {
      const o = await c.outcome(id), b = await c.getBet(id);
      const cls = { 0: 'refund', 1: 'win', 2: 'lose' }[o.cls];
      if (!o.ready || o.payout !== x.payout || cls !== x.cls || b.litBefore !== x.litBefore) bad.push(`#${id} ${o.payout}/${x.payout} ${cls}/${x.cls} litBefore ${b.litBefore}/${x.litBefore}`);
    }
    check(!bad.length, `S2: the contract pays all ${ref.byBet.size} bets of night 1 exactly what the reference says (class, litBefore, payout to the wei)`, bad.join('; '));
    await pageHygiene(P, s, 'S2', 1280);
  } catch (e) {
    check(false, `S2 crashed: ${e.stack || e}`);
  } finally { await s.close(); }
}

// ---------------------------------------------------------------- S3: nobody wins (real night 2), then the bonus pot is won (night 3)
async function S3(ctx) {
  const { c, wallet, me, p3, p4, p5 } = ctx;
  await c.at(70, 30);
  await c.record(69);
  ctx.ids.p3b = (await c.betDirect(p3, 6, 100n * W)).betId; // for night 2: stays dark
  ctx.state.wheel = 0;
  const { s, P, page } = await openPage(ctx, { label: 'S3 phone 390x844 light, reduced motion', viewport: { width: 390, height: 844 }, scheme: 'light', reducedMotion: true });
  try {
    check(await P.waitText('#mine', /Bulb 3 · 100 SQK.*collected/), 'S3: a new visit: your collected bet from night 1 is shown', await P.text('#mine'));
    check(await P.waitText('#act', /^Bet 100 SQK on bulb/), 'S3: one bet per ride: you can bet on the next ride', await P.text('#act'));
    // ---- you bet bulb 5 for his next ride
    await P.pickBulb(5);
    await P.click('#act');
    check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 5, for his next ride\./, 20_000), 'S3: "Bet placed: 100 SQK on bulb 5, for his next ride."', await P.text('#status'));
    ctx.ids.me2nd = (await c.allBets()).filter((b) => b.owner.toLowerCase() === me.toLowerCase()).at(-1).id;
    // ---- night 2: leaves in 78, bulbs in 79-80, lights out in 81-82. Bets on 5, 6 and 17: nobody wins
    const works = realWorks(78, 105);
    for (let r = 78; r <= 82; r++) { await c.at(r + 1, 40); await c.record(r, works); ctx.state.wheel = works.has(r + 1) ? 300 : 0; }
    check(await P.refresh({ S: 82 }), 'S3: the page reads night 2');
    const ref2 = await reference(c);
    const n2 = ref2.nights[1];
    check(n2 && n2.start === 78 && n2.C === 81 && n2.lit === 2 && n2.result === 'rolled' && n2.bonusOut === 300n * W, 'S3: the reference: night 2 lit 2 bulbs, nobody won, 300 SQK roll on', JSON.stringify(n2 && { s: n2.start, C: n2.C, lit: n2.lit, r: n2.result }));
    check(await P.waitText('#caption', /Bonus pot: 300 SQK\./), 'S3: the caption shows "Bonus pot: 300 SQK."', await P.text('#caption'));
    const bo = await P.waitBoard((x) => /BLACKOUT/.test(x.msg));
    check(bo && bo.msg === 'BLACKOUT AFTER 2 BULBS * SWEET DREAMS * BONUS POT 300 ROLLS ON' && bo.pot === 300, 'S3: the board: "BLACKOUT AFTER 2 BULBS * SWEET DREAMS * BONUS POT 300 ROLLS ON"', bo && bo.msg);
    check(await P.waitText('#status', /Blackout after 2 bulbs\. Your bulb 5 stayed dark: nobody won, so your bet rolls into the bonus pot\./), 'S3: "Blackout after 2 bulbs. Your bulb 5 stayed dark: nobody won, so your bet rolls into the bonus pot."', await P.text('#status'));
    check(await P.waitText('#mine', /Bulb 5 · 100 SQK.*stayed dark · rolls into the bonus pot/), 'S3: your bets: "stayed dark · rolls into the bonus pot"', await P.text('#mine'));
    check(/^Bet 100 SQK on bulb/.test(await P.text('#act')), 'S3: nothing to collect, the button offers the next bet', await P.text('#act'));
    await page.screenshot({ path: join(SHOTS, 's3-rolled.png'), fullPage: true });

    // ---- night 3: you bet bulb 2, p4 bulb 3, p5 bulb 8 (round 85); he leaves in 99, bulbs in 100-103, out in 104-105
    await c.at(85, 30);
    await c.record(84);
    await P.refresh({ S: 84 });
    await P.pickBulb(2);
    await P.click('#act');
    check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 2, for his next ride\./, 20_000), 'S3: you bet 100 on bulb 2 for night 3', await P.text('#status'));
    ctx.ids.me3 = (await c.allBets()).filter((b) => b.owner.toLowerCase() === me.toLowerCase()).at(-1).id;
    await c.betDirect(p4, 3, 200n * W);
    await c.betDirect(p5, 8, 100n * W);
    await P.refresh({ bets: (await c.betCount()) });
    const b3 = await P.waitBoard((x) => x.pot === 300);
    check(b3 && b3.pot === 300 && /Bonus pot: 300 SQK/.test(await P.text('#caption')), 'S3: before night 3 the board shows the 300 SQK bonus pot', JSON.stringify(b3));
    for (let r = 85; r <= 105; r++) { await c.at(r + 1, 40); await c.record(r, works); ctx.state.wheel = works.has(r + 1) ? 300 : 0; }
    check(await P.refresh({ S: 105 }), 'S3: the page reads night 3');
    const ref3 = await reference(c);
    const n3 = ref3.nights[2], mine = ref3.byBet.get(ctx.ids.me3);
    check(n3 && n3.lit === 4 && n3.bonusIn === 300n * W && n3.result === 'paid' && n3.burned === 8n * W && mine.payout === 173n * W, 'S3: the reference: night 3 lit 4, won the 300 bonus pot, 8 burned (2% of 100 lost + 300), you get 173', JSON.stringify(n3 && { lit: n3.lit, burned: String(n3.burned), you: String(mine && mine.payout) }));
    const bo3 = await P.waitBoard((x) => /BLACKOUT/.test(x.msg));
    check(bo3 && bo3.msg === 'BLACKOUT AFTER 4 BULBS * SWEET DREAMS' && bo3.pot === 0, 'S3: the board: "BLACKOUT AFTER 4 BULBS * SWEET DREAMS", no bonus pot left', bo3 && bo3.msg);
    check(await P.waitText('#act', /^Collect 173 SQK$/, 20_000), 'S3: "Collect 173 SQK"', await P.text('#act'));
    const before = await c.balance(me), n0 = wallet.sends.length;
    await P.click('#act');
    check(await P.waitText('#status', /Collected 173 SQK\./, 20_000), 'S3: "Collected 173 SQK."', await P.text('#status'));
    check((await c.balance(me)) - before === 173n * W && wallet.sends.length === n0 + 1, 'S3: exactly 173 SQK arrived, in one wallet step, with nobody else playing since the bets');
    await P.refresh();
    check(!/Bonus pot/.test(await P.text('#caption')), 'S3: the bonus pot is gone from the caption', await P.text('#caption'));
    const outs = await Promise.all([...ref3.byBet.keys()].map(async (id) => [id, await c.outcome(id)]));
    await c.send(c.deployer, c.lights, C.encode.settle(500));
    const bad = [];
    for (const [id, x] of ref3.byBet) { const o = await c.outcome(id); if (!o.ready || o.payout !== x.payout) bad.push(`#${id} ${o.payout} vs ${x.payout}`); }
    check(!bad.length && outs.length === ref3.byBet.size, `S3: all ${ref3.byBet.size} bets so far: the contract's payouts == the reference`, bad.join('; '));
    await page.screenshot({ path: join(SHOTS, 's3-collected.png'), fullPage: true });

    // ---- the wallet moves to another network mid-visit: the page asks to switch back (the network is known now)
    const l0 = wallet.log.length;
    wallet.chainId = '0x1';
    await wallet.emit('chainChanged', '0x1');
    check(await P.waitText('#act', /^Switch to Test chain$/), 'S3: the wallet moved to another network: "Switch to Test chain"', await P.text('#act'));
    await P.click('#act');
    check(await P.waitText('#act', /^Bet 100 SQK on bulb/), 'S3: switched back in one step', await P.text('#act'));
    check(!wallet.log.slice(l0).includes('wallet_addEthereumChain'), 'S3: a known network is not added again');

    // ---- an old wheel reading: the page follows the records only
    ctx.state.stale = true;
    await P.refresh();
    check(await P.waitText('#caption', /Following Squeekchain's 10-minute records\./), 'S3: with an old wheel reading the caption says "Following Squeekchain\'s 10-minute records."', await P.text('#caption'));
    ctx.state.stale = false;

    // ---- the records run late (nothing recorded for 7 rounds): no bets until they arrive
    await c.at(113, 40);
    await P.refresh({ S: 105 });
    check(await P.waitText('#status', /Squeekchain's records are running late \(the last one is 7 rounds old\), so the page waits before offering bulbs\./), 'S3: records 7 rounds late: "Squeekchain\'s records are running late (the last one is 7 rounds old)..."', await P.text('#status'));
    check(/^No bets right now$/.test(await P.text('#act')) && await P.disabled('#act'), 'S3: ... and "No bets right now"', await P.text('#act'));
    await c.record(112);
    await P.refresh({ S: 112 });
    check(await P.waitText('#act', /^Bet 100 SQK on bulb/), 'S3: the records arrive: bets are offered again', await P.text('#act'));

    // ---- the core pauses its records
    await c.setPaused(true);
    await P.refresh();
    check(await P.waitText('#status', /Squeekchain has paused its records\. The lights wait until it starts again\./), 'S3: a paused core: "Squeekchain has paused its records. The lights wait until it starts again."', await P.text('#status'));
    check(/^No bets right now$/.test(await P.text('#act')), 'S3: ... and "No bets right now"', await P.text('#act'));
    await c.setPaused(false);
    await P.refresh();
    await P.waitText('#act', /^Bet 100 SQK on bulb/);

    // ---- a bet the network includes too late: it must fail (not quietly move to a later round), and say so
    await P.pickBulb(4);
    const k2 = await P.saidCount(), bets2 = await c.betCount();
    wallet.hold = async (tx) => {
      if (!tx.data.startsWith(C.SEL.approve) && (tx.data.startsWith(C.SEL.bet) || tx.data.startsWith('0xffc37000'))) { wallet.hold = null; await c.at(115, 40); await c.record(114); }
    };
    await P.click('#act');
    const late = await P.waitSaid(/too late/i, k2, 20_000);
    check(late && !/Bet placed/.test((await P.said(k2)).join()), 'S3: a bet included two rounds late fails and the page says it came too late', (await P.said(k2)).join(' | '));
    check((await c.betCount()) === bets2, 'S3: ... and no bet was placed');
    wallet.hold = null;
    await P.refresh({ S: 114 });
    const n4 = wallet.sends.length;
    await P.click('#act');
    check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 4, for his next ride\./, 20_000), 'S3: pressed again: the bet is placed', await P.text('#status'));
    check(wallet.sends.length === n4 + 1, 'S3: ... in one wallet step (the game was still allowed exactly 100 SQK)', String(wallet.sends.length - n4));
    await pageHygiene(P, s, 'S3', 390);
  } catch (e) {
    check(false, `S3 crashed: ${e.stack || e}`);
  } finally { await s.close(); }
}

// ================================================================= chain 2: the whole history, then long nights

async function chain2() {
  const anvil = await H.startAnvil();
  const c = await H.createTestChain(anvil, { round: 781, secs: 15, startRound: 780 });
  const [, me, p3] = c.accounts;
  for (const a of [me, p3]) await c.mint(a, 1000n * W);
  await c.record(780, REAL);
  // A: 790-825, a 36-round night with a break every other round (17 bulbs); B, C, D: 830-937, three full nights
  const works = new Map();
  for (let r = 790; r <= 825; r += 2) works.set(r, 400);
  for (let r = 830; r <= 937; r++) works.set(r, 500);
  for (let r = 945; r <= 948; r++) works.set(r, 500); // E: a short ride after the long spell
  for (let r = 960; r <= 1067; r++) works.set(r, 500); // F, G, H: another long spell
  for (let r = 1075; r <= 1078; r++) works.set(r, 500); // I
  await c.at(824, 40);
  await c.record(823, works);
  const state = { wheel: 300, config: null };
  const web = await H.startWeb(state);
  state.config = { ...c.chainCfg, chainName: 'Test chain', explorer: '', walkFrom: 0, clock: 'chain', statusApi: `${web.origin}/__status`, wheelHoldMs: 0 }; // rounds are fast-forwarded here: the blip hold has its own tests in chain.test.mjs
  const wallet = H.createFakeWallet(anvil, { account: me, chainId: '0x7a69' });
  wallet.known.add('0x7a69');
  return { anvil, c, state, web, wallet, me, p3, works };
}

async function S4(ctx) {
  const { c, state, wallet, me, p3, works } = ctx;
  const { s, P, page } = await openPage(ctx, { label: 'S4 desktop 1280x900 dark', viewport: { width: 1280, height: 900 }, scheme: 'dark' });
  try {
    check(await P.refresh({ S: 823, ms: 20_000 }), 'S4: the page reads all 823 rounds');
    const st = await P.state();
    const same = RIDES.every((r, i) => st.rides[i] && st.rides[i].start === r.start && st.rides[i].C === r.C && st.rides[i].lit === r.lit);
    check(same && st.rides.length === 19, 'S4: the page\'s 19 nights read from the chain == data/rides.json (start, lights out, bulbs)', JSON.stringify(st.rides.slice(0, 3)));
    const lit6 = RIDES.filter((r) => r.lit >= 6).length;
    // ---- the last two rounds of a 36-round night: a bet there can only be given back or lose
    check(st.open && st.open.start === 790 && st.lit === 16 && st.cur === 824, 'S4: night A is open since 790 with 16 bulbs; round 824 = its 35th round', JSON.stringify({ open: st.open, lit: st.lit, cur: st.cur }));
    check(await P.waitText('#act', /^Connect wallet$/), 'S4: "Connect wallet"', await P.text('#act'));
    await P.click('#act');
    check(await P.waitText('#walletLine', /you have 1,000 SQK/), 'S4: a wallet already on the right network connects in one step', await P.text('#walletLine'));
    await sleep(400);
    check(/^No bets right now$/.test(await P.text('#act')) && await P.disabled('#act'), 'S4: in the last two rounds of a 36-round night no bet is offered (it could only be given back or lose)', `${await P.text('#act')} / floor ${st.floor}`);
    check(/last|6 hours|almost/i.test(await P.text('#status')) && /next ride/.test(await P.text('#status')), 'S4: and the page says why, in plain words', await P.text('#status'));
    // ---- the odds next to the picker come from his real nights
    await c.at(826, 40); await c.record(825, works); state.wheel = 0;
    await P.refresh({ S: 825 });
    await P.pickBulb(6);
    const o6 = Math.round((lit6 + 1) / 20 * 100); // + night A (17 bulbs)
    check(new RegExp(`^Bulb 6 · 1 hour · lit on ${o6}% of his nights$`).test(await P.text('#pickOdds')), `S4: next to the picker: "Bulb 6 · 1 hour · lit on ${o6}% of his nights" (${lit6 + 1} of 20)`, await P.text('#pickOdds'));
    // ---- the dashboard at other widths, with the bet controls showing
    for (const width of [800, 1000]) {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await sleep(400);
      await dashOk(P, `S4 at ${width} px`);
      check((await P.scrollWidth()) <= width, `S4 at ${width} px: no sideways scroll`);
    }
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await sleep(300);
    // ---- past nights: the chain's nights join the replay list
    await P.click('#modeReplay');
    await sleep(500);
    const opts = await page.$$eval('#ride option', (o) => o.length);
    check(opts >= 20, `S4: "Watch a past night" lists the nights read from the chain (${opts})`, String(opts));
    await P.click('#modeLive');
    await sleep(300);

    // ---- a long quiet spell for the game: B, C, D run (108 rounds) and nobody bets
    await c.at(941, 30); await c.record(940, works); state.wheel = 0;
    check(await P.refresh({ S: 940, ms: 20_000 }), 'S4: the page reads the long nights B, C, D');
    await P.pickBulb(2);
    await P.click('#act');
    check(await P.waitText('#status', /Bet placed: 100 SQK on bulb 2, for his next ride\./, 20_000), 'S4: you bet 100 on bulb 2 for his next ride (the game is far behind; the bet still goes through)', await P.text('#status'));
    const myBet = (await c.allBets()).find((b) => b.owner.toLowerCase() === me.toLowerCase());
    await c.betDirect(p3, 10, 100n * W);
    // E: leaves 945, bulbs 946-948, lights out 949-950
    await c.at(952, 40); await c.record(951, works);
    check(await P.refresh({ S: 951, bets: 2 }), 'S4: the page reads ride E');
    let ref = await reference(c);
    const due = ref.byBet.get(myBet.id).payout;
    check(due === 198n * W, 'S4: the reference: your bulb 2 lit in ride E, you get 198 (100 + 100 lost - 2 burned)', String(due));
    check(await P.waitText('#act', /^Collect 198 SQK$/, 20_000), 'S4: "Collect 198 SQK"', await P.text('#act'));
    const before = await c.balance(me), n0 = wallet.sends.length, k0 = await P.saidCount();
    await P.click('#act');
    check(await P.waitSaid(/Collected 198 SQK\./, k0, 30_000), 'S4: "Collected 198 SQK." after a long quiet spell', (await P.said(k0)).join(' | '));
    check((await P.said(k0)).some((x) => /^The game hasn't counted this ride yet\. Your wallet asks once to count it/.test(x)), 'S4: the page said first: "The game hasn\'t counted this ride yet. Your wallet asks once to count it, then once to collect."', (await P.said(k0)).join(' | '));
    const sends = wallet.sends.slice(n0);
    check((await c.balance(me)) - before === 198n * W, 'S4: exactly 198 SQK arrived');
    check(sends.length >= 2 && sends.at(-1).data.startsWith(C.SEL.claim) && sends.slice(0, -1).every((x) => x.data.startsWith(C.SEL.poke) || x.data.startsWith(C.SEL.settle)), `S4: the wallet first counted the ride (${sends.length - 1} helper step), then collected`, sends.map((x) => x.data.slice(0, 10)).join());

    // ---- a returning player after a long busy spell: F, G, H run (108 rounds) unread; p3 bets, I runs, p3 bets again
    await c.at(1071, 30); await c.record(1070, works);
    await c.betDirect(p3, 5, 100n * W);
    await c.at(1083, 40); await c.record(1082, works);
    await wallet.switchAccount(p3);
    check(await P.refresh({ S: 1082, bets: 3, ms: 20_000 }), 'S4: the page reads the second long spell and ride I');
    await P.waitText('#walletLine', new RegExp(`${p3.slice(0, 6)}`));
    await P.waitText('#act', /^Bet 100 SQK on bulb/);
    const n1 = wallet.sends.length, k1 = await P.saidCount();
    await P.click('#act');
    const placed = await P.waitSaid(/Bet placed: 100 SQK on bulb \d+, for his next ride\./, k1, 25_000);
    const said = (await P.said(k1)).join(' | ');
    check(placed, 'S4: a returning player after a long busy spell: the game catches up first, then the bet is placed', said);
    check(!/refused|went wrong/i.test(said), 'S4: ... and is never told "the network refused" for it', said);
    const s2 = wallet.sends.slice(n1);
    check(s2.length >= 2 && s2.some((x) => x.data.startsWith(C.SEL.poke)), `S4: the wallet steps: ${s2.map((x) => x.data.slice(0, 10)).join(', ')} (a catch-up step first)`);
    ref = await reference(c);
    const all = await c.allBets();
    const bad = [];
    await c.send(c.deployer, c.lights, C.encode.poke(50));
    await c.send(c.deployer, c.lights, C.encode.settle(500));
    for (const [id, x] of ref.byBet) {
      const o = await c.outcome(id);
      // a losing stake in a night nobody won rides in the bonus pot: not final (ready false) until a later night wins it
      const rolled = ref.nights[x.night].result === 'rolled';
      if (o.payout !== x.payout || (rolled ? o.result !== C.RESULT.ROLLED : !o.ready)) bad.push(`#${id} ${o.payout} vs ${x.payout} ready ${o.ready} result ${o.result}`);
    }
    check(!bad.length && all.length === 4, `S4: every bet the contract counted pays what the reference says (${ref.byBet.size}; a stake riding in the bonus pot is not final yet)`, bad.join('; ') + ` bets ${all.length}`);
    await page.screenshot({ path: join(SHOTS, 's4-desktop-dark.png'), fullPage: true });
    await pageHygiene(P, s, 'S4', 1280);
  } catch (e) {
    check(false, `S4 crashed: ${e.stack || e}`);
  } finally { await s.close(); }
}

// ---------------------------------------------------------------- S5: he sleeps for a week: the game ends, bets come back
async function S5(ctx) {
  const { c, wallet, me, p3 } = ctx;
  // 1,008 rounds (7 days) with no running round after ride I (last active 1078): anyone may end the game
  await c.at(2100, 30);
  await c.record(2099);
  await c.send(c.deployer, c.lights, C.encode.poke(50));
  await c.send(c.deployer, c.lights, C.encode.settle(500));
  await c.send(c.deployer, c.lights, '0xac4c25b2', { gas: 3_000_000 }); // void() (cast sig)
  check(C.decode.bool(await c.call(c.lights, C.SEL.voided)), 'S5: after a week without running the game was ended (void)');
  const ref = await reference(c);
  // after the game ends: bets not in a closed night come back, and so do stakes riding in a bonus pot nobody won
  const lastPaid = ref.nights.map((n) => n.result).lastIndexOf('paid');
  const p3Bets = (await c.allBets()).filter((b) => b.owner.toLowerCase() === p3.toLowerCase());
  let due = 0n;
  for (const b of p3Bets) {
    if (ref.waiting.includes(b.id)) due += b.stake;
    else { const x = ref.byBet.get(b.id); if (x && x.cls === 'lose' && ref.nights[x.night].result === 'rolled' && x.night > lastPaid) due += b.stake; else if (x && b.status !== C.STATUS.CLAIMED) due += x.payout; }
  }
  const { s, P, page } = await openPage(ctx, { label: 'S5 phone 390x844 dark', viewport: { width: 390, height: 844 }, scheme: 'dark' });
  try {
    check(await P.waitText('#walletLine', new RegExp(p3.slice(0, 6))), 'S5: the wallet is still connected (p3)', await P.text('#walletLine'));
    check(await P.waitText('#status', /^This game has ended\. Collect your refunds\.$/), 'S5: "This game has ended. Collect your refunds."', await P.text('#status'));
    check(await P.waitText('#act', new RegExp(`^Collect ${sqkText(due)} SQK$`)), `S5: "Collect ${sqkText(due)} SQK": every waiting bet and the stake riding in the bonus pot come back`, await P.text('#act'));
    const b = await P.board();
    check(b && !/BETS NOW COUNT/.test(b.msg) && /ENDED/.test(b.msg) && !b.pick && !b.markers.length, 'S5: the board says the game has ended, with no bulb picked and no bet markers', JSON.stringify(b));
    check(!/waits for his next ride/.test(await P.text('#mine')), 'S5: your bets no longer say they wait for his next ride', await P.text('#mine'));
    check(!/Bonus pot/.test(await P.text('#caption')) && !(b && b.pot), 'S5: no bonus pot is shown after the game ended', await P.text('#caption'));
    check(!(await P.visible('#pickRow')) && /^Game ended$/.test(await P.text('#youState')) && new RegExp(`^${sqkText(due)} SQK$`).test(await P.text('#money')), 'S5: the dashboard shows "Game ended" and what you can collect, no bulb picker', `${await P.text('#youState')} / ${await P.text('#money')}`);
    check(/^Bets waiting when the game ended$/.test(await P.text('#playersTitle')), 'S5: the list of bets is titled "Bets waiting when the game ended"', await P.text('#playersTitle'));
    await dashOk(P, 'S5 after the game ended');
    await page.screenshot({ path: join(SHOTS, 's5-ended.png'), fullPage: true });
    const before = await c.balance(p3);
    await P.click('#act');
    check(await P.waitText('#status', new RegExp(`Collected ${sqkText(due)} SQK\\.`), 20_000), `S5: "Collected ${sqkText(due)} SQK."`, await P.text('#status'));
    check((await c.balance(p3)) - before === due, 'S5: exactly that arrived');
    check(await P.waitText('#mine', /the game ended · given back 100 SQK/), 'S5: your bets: "the game ended · given back 100 SQK"', await P.text('#mine'));
    await P.refresh();
    check(await P.waitText('#act', /^Game ended$/) && await P.disabled('#act'), 'S5: then the button says "Game ended"', await P.text('#act'));
    await wallet.switchAccount(me);
    check(await P.waitText('#act', /^Game ended$/), 'S5: a player with nothing to collect sees "Game ended"', await P.text('#act'));
    await pageHygiene(P, s, 'S5', 390);
  } catch (e) {
    check(false, `S5 crashed: ${e.stack || e}`);
  } finally { await s.close(); }
}

// ================================================================= run

const fresh = H.checkBuildFresh();
check(fresh.fresh, 'out/LightsOn.json is built from the current src (else run forge build --offline)');
const started = Date.now();
try {
  const sessions = ['S1', 'S2', 'S3'].filter((x) => !ONLY || ONLY.has(x));
  if (sessions.length) {
    const ctx = await chain1();
    try {
      for (const name of sessions) {
        const t0 = Date.now();
        console.log(`\n--- ${name}`);
        await ({ S1, S2, S3 })[name](ctx);
        console.log(`     ${name} took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
    } finally { await ctx.web.stop(); ctx.anvil.stop(); }
  }
  const later = ['S4', 'S5'].filter((x) => !ONLY || ONLY.has(x));
  if (later.length) {
    const ctx = await chain2();
    try {
      for (const name of later) {
        const t0 = Date.now();
        console.log(`\n--- ${name}`);
        await ({ S4, S5 })[name](ctx);
        console.log(`     ${name} took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
    } finally { await ctx.web.stop(); ctx.anvil.stop(); }
  }
} catch (e) {
  check(false, `harness: ${e.stack || e}`);
} finally {
  H.killAll();
}
console.log(`\n${t.passed} passed, ${t.failed} failed in ${((Date.now() - started) / 1000).toFixed(0)} s${arg('--out') ? ` · screenshots in ${SHOTS}` : ''}`);
if (t.failed) console.log('failed:\n  ' + t.fails.join('\n  '));
process.exit(t.failed ? 1 : 0);
