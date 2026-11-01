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
