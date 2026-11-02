# site tests

Everything runs locally. Nothing is deployed, nothing is signed on a public chain, no key is used: the local
chains are anvil, and every transaction is sent from one of anvil's own unlocked test accounts. Only `--live` /
`--real` read the public Sepolia RPC and the Squeekchain status API, gently (a handful of reads).

Needs node 22, Foundry (`anvil`), Chrome and puppeteer. If they aren't on the default paths, point the tests at
them with `ANVIL=/path/to/anvil`, `CHROME=/path/to/chrome` and `PUPPETEER=/path/to/node_modules/puppeteer`. No
npm, pip or forge installs are needed for the page itself. The contracts must be built (`out`, from `forge build --offline` in
`contracts/`); the end-to-end test checks that the build is newer than the sources.

## Run them

From the repo root:

```
node site/test/static.test.mjs           # page skeleton, local files, no libraries, wording          (< 1 s)
node site/test/engine.test.mjs           # settlement == vectors, lowest bulb on rounds 1-780, M4    (~ 5 s)
node site/test/chain.test.mjs            # ABI encoders/decoders, errors in plain words, RPC fallback  (< 1 s)
node site/test/anvil.test.mjs            # chain.js against the real contract on anvil (no browser)   (~ 5 s)
node site/test/live.test.mjs             # live.js in node on anvil, through a page node that lags     (~ 1 min)
node site/test/smoke.test.cjs            # Chrome, live mode without a contract + replay              (~ 50 s)
node site/test/contract.smoke.test.mjs   # Chrome, one quick pass with the contract                   (~ 15 s)
node site/test/e2e.test.mjs              # Chrome, the full end-to-end run (below)                   (~ 1 min)
```

Each prints `ok` / `FAIL` per check and exits 1 on any failure. Add `--out <dir>` to the browser tests to keep
screenshots. Optional real reads: `chain.test.mjs --live` (3 calls) and `smoke.test.cjs --real` (one page load).

Every test picks free local ports itself (a fixed port can be held by another local server; the page would then load
someone else's site). A cron on this machine kills Chrome older than about 2 minutes, so every Chrome launch is
killed by the test itself at 85 s and counted as a failure.

## The end-to-end harness (`e2e.test.mjs` + `e2e/`)

| File | |
|---|---|
| `e2e/harness.mjs` | anvil on a free port; `createTestChain` deploys `MockCore` and `MockSQK` (from `contracts/test/mocks/Mocks.sol`) and `LightsOn` from `out`, then drives time (`at(round, secs)`: `evm_setNextBlockTimestamp` + `evm_mine`) and the core (`record(through, works)`: `setActive` for running rounds, then `setSettled`); a small web server for `site/` that also serves the **test copy of config.json** at `/config.e2e.json` (anvil's RPC, chain 31337, the deployed addresses, `walkFrom`, `clock: "chain"`) and a fake status API at `/__status` (wheel speed set by the scenario, or an old reading); the **fake wallet**; Chrome launch with the 85 s limit; page helpers |
| `e2e/reference.mjs` | an independent copy of the settlement rule (written from the spec and `LightsMath.sol`, not from the page's `engine.js`). Before it is trusted it reproduces all 24 vectors in `data/lights-vectors.json` and the 19 nights of `data/rides.json` |
| `e2e.test.mjs` | the scenarios |

The page is opened as `index.html?config=config.e2e.json`, so the real `config.json` is never touched. It talks to
anvil directly (anvil answers with `access-control-allow-origin: *`). Google Fonts are answered empty.

**The fake wallet** is `window.ethereum`, injected before the page loads. Each request goes to node
(`page.exposeFunction`), where it behaves like a browser wallet: it shares its account only after
`eth_requestAccounts`, starts on another network (0x1) and doesn't know the test chain (switching fails with 4902
until `wallet_addEthereumChain`), fires `chainChanged` / `accountsChanged`, refuses a transaction when told to
(code 4001), can hold a transaction while the test moves the chain (this is how "too close" and "too late" are
made), and sends through anvil's unlocked account. Every request and every transaction (with its data and gas) is
logged for the checks.

### Scenarios

Chain 1: a fresh anvil, the chain starts in round 40, the game's walker starts after round 39, and the core then
records his **real rounds 45-105 from `data/rounds.json`**, round by round with their real turns.

- **S1, phone 390x844, light.** Three players already bet. Connect; the wallet is on another network it doesn't
  know: add + switch; 5 and 20,000 SQK (button off, plain words); 5,000 SQK with 1,000 in the wallet ("Not enough
  SQK…"); saying no in the wallet; no test ETH for the fee; bulb 3: allow exactly 100 SQK, then the bet
  (`betUntil`, gas ≥ 1,500,000), nothing left allowed; another account whose bet arrives "from another device":
  "You already have a bet on this ride…" with nothing sent; reload: your bet is still shown and marked on the board.
- **S2, desktop 1280x900, dark.** Night 1 (45-63: departure, 8 bulbs, a break, 3 bulbs, a break, 3 bulbs, lights out
  in 62). After every round: bulbs lit on the page and on the board, steady or flickering, the board's sign, the
  lowest bulb offered (= lit + rounds not recorded yet + 1). Two bets in the departure round (bulb 1 is given back).
  A player picks bulb 6; while the wallet asks to allow, the next round is recorded: "Bulb 6 got too close…", only the
  allow went out; pressed again, bulb 7 in one step. In round 62 (quiet so far) a bet says "for tonight, or his next
  ride if the lights go out" and after the blackout waits for his next ride. Blackout: the page's night == night 1 in
  `data/rides.json`; "Collect 155.45 SQK" == the reference; one collect step counts the ride and pays it to the wei;
  every bet of the night: the contract's class, `litBefore` and payout == the reference.
- **S3, phone 390x844, light, reduced motion.** Night 2 (78-82, 2 bulbs) where every bet is on bulb 5 or higher:
  nobody wins, "Bonus pot: 300 SQK", "BONUS POT 300 ROLLS ON", "your bet rolls into the bonus pot". Night 3 (99-105,
  4 bulbs) pays it: 8 SQK burned, "Collect 173 SQK", 173 arrive in one step. Then: the wallet moves to another
  network (switch back, no second add), an old wheel reading, records 7 rounds late ("No bets right now"), a paused
  core, and a bet the network includes two rounds late (it fails, "…too late…", no bet; pressed again it is placed in
  one step).

Chain 2: a fresh anvil with **all 137 real running rounds of 1-780**, then made-up nights.

- **S4, desktop 1280x900, dark.** The page's 19 nights == `data/rides.json`; the odds next to the picker; "Watch a
  past night" lists the chain's nights; the dashboard at 800 and 1000 px. A 36-round night with a break every other
  round: in its last two rounds no bulb is offered (audit M4). Three long nights nobody plays in: your bet still goes
  through, and Collect first sends one helper to count the ride ("The game hasn't counted this ride yet…"), then
  pays 198 SQK. Another long busy spell: a returning player's bet hits `PokeFirst`; the page sends one catch-up step,
  then allow and bet.
- **S5, phone 390x844, dark.** He sleeps 1,008 rounds (7 days); the game is ended with `void()`. The page says "This
  game has ended. Collect your refunds.", shows no bonus pot, no bet picker and no "next ride"; collect returns the
  waiting bet and the stake riding in the bonus pot; then "Game ended".

In every Chrome session: no console errors, no sideways scroll, never "can't lose", no jargon on the page (claim,
approve, revert, nonce, allowance…), and the dashboard row readable ("your bulb" and the one number get real width
and stay on one line).

Every payout is checked three ways: the reference, what the contract says it owes (`betOutcome`), and the SQK that
actually arrives (and the page's Collect button shows the same number).

`--only S4,S5` runs a part on a fresh chain; S2 and S3 build on S1, and S5 on S4.

## What the end-to-end run found and what was fixed (2026-11-01)

Site bugs, fixed in `site/` and covered by the checks above:

1. **Bets were sent with `bet()`, not `betUntil()`** (contract audit T1). A bet the network included late quietly
   landed in a later round, or in his next ride after a blackout. Now `betUntil(bulb, amount, lastRound)` with the
   round the page worked the lowest bulb out for, read again at every step; a late bet fails and the page says so
   (it simulates the failed bet again to learn why).
2. **`PokeFirst` was not handled** (audit T6). After a long busy spell nobody played in, a returning player got "The
   network refused this transaction" and could not bet. Now the page sends one catch-up step (`poke(16)`), then the
   bet, and explains it.
3. **No fixed gas limits** (audit A3). Bets now go out with 1,500,000, collects with 1,000,000 + 30,000 per bet,
   helpers with 1.5x their estimate.
4. **Bets were offered in the last two rounds of a 36-round night** (audit M4), where they could only be given back
   or lose. Now no bulb is offered there, with a plain sentence.
5. **The new contract errors were unknown** (`TooLate`, `PokeFirst`, `NeedMoreGas`, `SettleFirst`, `TooEarly`,
   `NotStalled`, `NotSettled`, `BadPage`): added, with plain words for the two a player can meet.
6. **A bet outside 10-10,000 SQK only turned the button off** ("Pick a bet") with no reason. Now: "A bet must be a
   whole number from 10 to 10,000 SQK."
7. **Desktop layout with a game was broken**: the bet controls' column took the width of all its parts on one line,
   squeezing "Your bulb" and the one number to a few letters ("Bul / b / 7?"). The column is now capped
   (`fit-content(440px)`) and the controls move under the two cells up to 920 px wide.
8. **After the game ended** (`void`), the board still said "BETS NOW COUNT FOR HIS NEXT RIDE", the caption still showed
   the bonus pot, the dashboard still offered a bulb and a "+50 if the lights go out", and waiting bets said "waits
   for his next ride". Now: "THIS GAME HAS ENDED", no pot, "Game ended" with what you can collect, and each bet says
   "the game ended · … to collect" / "given back …".
9. **An old message could hide a new problem**: "Collected 173 SQK." stayed for 30 s even when the records started
   running late or the core paused. A change of situation now replaces it.
10. **"You (you)"** in the list of bets: the row already says You.

Test fixes: `contract.smoke.test.mjs` failed because its fixed port 8773 was held by another local server (it loaded
the wrong site); every test now picks free ports, and its own limit went from 110 s to 85 s. It now expects the bet as
`betUntil`. `chain.test.mjs` checks the `betUntil` encoding against `cast calldata` and the new errors;
`engine.test.mjs` checks the M4 rule.

Not changed (contract-side or out of scope): the page does not show the stall state or offer `flagStall` / `void`
buttons (anyone can call them; the page only shows the result). A `TooLate` that happens on chain costs the network
fee of the failed bet (test ETH).

## Bug bash round 1 (2026-11-01): fixed in `live.js` / `chain.js`, covered by `live.test.mjs` and `chain.test.mjs`

`live.test.mjs` runs the page's live mode in node on a fake page (plain objects for the dashboard's elements), on
anvil, through a page RPC that answers 'latest' from a block 8 s (or 20 s) old, like a lagging public node; the wallet
talks to anvil directly. It needs no Chrome, so it stays steady when the machine is busy.

1. **Right after "Bet placed" the page offered the same bet again** (its node didn't show the bet yet); a second tap
   sent a bet that failed on chain and said "Please try again". Now the bet from the receipt shows at once (your bulb,
   the button off, the balance), until the node shows it; a failed bet the page's node can't explain is explained from
   the wallet's own node ("You already have a bet on this ride…").
2. **After the allow step, a node more than 15 s behind made the page say the game wasn't allowed**, and the next press
   asked to allow again. Now the bet is simulated on the wallet's node too (no wait when it shows the allow); if no
   node shows it, the page says the allow went through and the next press goes straight to the bet.
3. **After the blackout a lit bulb that got back less than its bet was told it won** (coins, "Your bulb 6 lit. Press
   Collect…"), and the dashboard went back to the picker. Now the sentence says "…but higher bulbs and earlier bets got
   bigger slices of the pot, so you get back 88.89 of your 100 SQK", the dashboard keeps "Bulb 6 lit · Last ride
   −11.11" until you collect, and the coin sound is skipped for a net loss.
4. **The line above the button talked about the picker's bulb after you bet**, and mid-ride its time read like time
   left. Now it is about your bet's bulb (blank once lit), and while he runs it says the time still to run ("Bulb 6 ·
   about 20 min more · …").
5. **A collect on a lagging node could be pressed twice** (a second collect paid 0 and cost a fee). Now the collected
   bets leave the button at once and the balance adds what arrived.
6. **No wallet in the browser** (a phone from X) only said "No wallet found". Now: open it in a wallet app's browser,
   with "Open in MetaMask" and "Copy the link".

## Bug bash round 2 (2026-11-01): fixed in `live.js` / `replay.js` / `chain.js`, covered by `live.test.mjs`, `e2e.test.mjs` and `bugbash_fixer/`

1. **After a blackout a tap on the board picked another bulb** (the board was drawn scrolled to last night's bulbs
   13-19, a tap was read as if scrolled to bulb 1), and the board showed no pick or bet. Now the lights go out on the
   board (1.6 s), then it shows his next ride (no bulb lit, scrolled to bulb 1) with its bets and your pick; only the
   sign still says "BLACKOUT AFTER 14 BULBS". A tap is read for the board as drawn in that frame.
2. **The answer to a tap sat below a phone's screen** ("No wallet…", "Not enough SQK…"): while the button is on
   screen, the sentence under it now scrolls into view. With no wallet on a phone the button says "How to bet on a
   phone".
3. **No test ETH: the practice SQK button only said "Nothing was sent."** Now the page reads the wallet's test ETH;
   with none it says "Your wallet needs a little test ETH on Sepolia to pay the network fee. Test ETH is free from a
   Sepolia faucet. Then tap Get 1,000 practice SQK below." with a "Get free test ETH" link (`ethFaucet` in the
   config), and asks the wallet for nothing. Other refusals say why ("You said no in your wallet…"). "Not enough SQK"
   adds "Tap Get 1,000 practice SQK below." in the rehearsal.
4. **No unit, no "play money" on the first phone screen.** The one number shows "SQK" in small print, the button says
   "Bet 100 SQK on bulb 6", and under the number: "practice SQK, no real money" (rehearsal) / "test SQK, no real money".
5. **The green number read like a likely win.** It is labelled as the best case and when it holds: "Best case: he
   lights 6 to 11 bulbs" (worked out from the bets: a higher bet that lights takes a slice). Same in the replay.
6. **The sign said "IS HE ASLEEP?" / "SWEET DREAMS" while the cam showed him running.** A fresh wheel reading wins:
   after a quiet round "HE IS BACK ON THE WHEEL * NEXT: BULB 9" (no flicker), after a blackout "BLACKOUT AFTER 14
   BULBS * HE IS BACK ON THE WHEEL * LIGHTS ON SOON".

`bugbash_fixer/after-blackout.mjs` (the tap after a blackout, in Chrome) and `bugbash_fixer/phone-answers.mjs` (the
answer scrolled into view at 390 x 664, the number with its unit on one line at 360 px, no test ETH) run on anvil.
`live.test.mjs`'s lagging node now answers 'latest' from its own head even before it has seen a newer block (a block
mined inside its 200 ms head cache showed early, which made the slow-allow part flaky).

## Bug bash round 2b (2026-11-01): fixed in `live.js` / `replay.js`, covered by `live.test.mjs` (part `lost`)

1. **A win not yet collected hid the bet controls** (the picker, the amounts, taps on the board) while he ran his next
   ride, and the sentence still said which bulbs to bet on. Now the picker always stays when you have no bet on the
   ride. Your last ride's result fills the dashboard and the button is "Collect …" until you pick a bulb or an amount;
   then the dashboard shows the new bet, the button is for it, and the sentence says "68.77 SQK from your last ride is
   waiting for you." with its own "Collect 68.77 SQK" link. With the bet placed, the button collects the win.
2. **A lost bet vanished from the first screen** (only a sentence with no amount, gone after 6 rounds). Now it shows on
   the dashboard like a win ("Bulb 20 · stayed dark · bet 100", "Last ride −100 SQK, you lost your bet"), and the
   sentence says "Your bulb 20 stayed dark: you lost your 100 SQK." (later: "…on his last ride…"), until he picks a
   bulb or the next ride ends.
3. **Two wins waiting: the number showed only the newest (+98) while the button collected both (266.77).** Now "2 bets
   to collect", the number is what both gain together, "you get back 266.77 SQK".
4. **"Past night" → "Live" kept the replay's pretend players in the bets list**; the list and its title are redrawn.
   The replay calls them "Pretend players", with "His run is real. These 9 players are made up, so you can see how the
   pot is shared."
5. **The replay's sign never showed a whole message** (the countdown and the turn count changed it every second): its
   messages are now short words that stay while the night does the same thing ("PLACE YOUR BETS", "WARMING UP",
   "NEXT: BULB 4", "SHORT BREAK", "IS HE ASLEEP?"); up to 16 letters stand still on a phone's 99-dot sign.
6. **Past night broke on older phone browsers** (`Array.prototype.at`, iOS 15.0-15.3, Chrome before 92): not used.
7. Smaller ones: a double tap on Bet while the page looks at the wallet's test ETH no longer starts two bets (the
   button is busy at once); a failed look-up of your past bets is tried again (it hid an earlier win until a reload);
   switching wallet accounts or networks clears the old sentence; after the allow the button says "Waiting for the
   network…" like the sentence; the one number's settle animation is no longer cut (only the win/lose classes change);
   while the chain can't be read, a fresh wheel reading still drives the LIVE cam (running, not asleep).

## Bug bash round 3 (2026-11-01): fixed in `live.js` / `live-model.js` / `chain.js` / `led.js`, covered by `engine.test.mjs` (5b), `live.test.mjs` (part `stopped`), `chain.test.mjs` and `bugbash_fixer/r3-layout.mjs`

1. **"Your bet moves to his next ride if the lights go out" was wrong after he ran in the round** (high). He runs a few
   minutes, stops, and a bet sent then is in a round that already has his turns: it stays on tonight's ride and is
   lost if he sleeps on. The page now keeps the wheel readings it has seen and knows a round has his turns when the
   wheel turned in it, or the wheel's counter (`cumulativeWorkUnits`, the same counter SqueekCore records) went up in
   it. Then: "He stopped for a moment. A bet now counts for this ride: if he stays asleep, the lights go out and your
   bulb stays dark." and "for tonight's ride"; the "…or his next ride if the lights go out" words only when the round
   is quiet so far (or the bet lands in the next round).
2. **"HE IS BACK ON THE WHEEL · NEXT: BULB 6" and "for tonight's ride" while a blackout record could still arrive**
   (one quiet round recorded, the next one ended but not recorded yet). Now the sign says "HE IS BACK ON THE WHEEL"
   (no next bulb, the bulbs still flicker), the sentence "…or for his next ride if the lights went out in his break",
   and the words under the bulb "for tonight, or his next ride if the lights go out". "Bet placed" names the ride for
   the round the bet landed in (from its receipt).
3. **In the departure round (he just got on the wheel, nothing recorded yet) the page said "for his next ride"**, the
   list "Bets for his next ride", your bets "waits for his next ride". Now "for the ride he just started", "This
   ride's bets", "on the ride he just started", "Your bet is on the ride he just started." The same when he ran since
   the last record and stopped (the sign says "SHORT BREAK * LIGHTS ON SOON", not "HE IS ASLEEP").
4. **The board's sign kept "CONNECTING TO SQUEEKCHAIN" for ~15 s on phones** after the page had loaded: the loading
   word is now "CONNECTING..." (fits a phone's sign, so the first news replaces it at once). A new record also reads
   the wheel again before both show, so a bulb and "he stopped" reach the sign as one message. Still open (board.js,
   the art pass): two live messages less than 6 s apart let the first scroll through (~14 s on a phone); the replay's
   view now says `waitSign: true`, so the board can keep that wait for the replay only.
5. **The LED panels shrank when the code ran** (the page jumped 44 px on a laptop, dark strips beside the panels).
   `led.js` now fills the box the page's style keeps for each panel; the dots get whole device pixels and the few
   left over are spread over the cells (a tap is still read at x / width * cols).

`engine.test.mjs` 5b checks the words against where the bet really lands, on every round of the real history, with
the core one or two rounds behind, for a bet landing 0-2 rounds later, with him running / stopped after running /
quiet so far, the page knowing little or everything, in what happened and in the two futures (he sleeps on, he runs
on). `bugbash_fixer/r3-layout.mjs` (Chrome, real config, read only) checks the panels keep their size when the code
runs, at 390, 360 and 1280 px.
