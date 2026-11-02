# Keep the Lights On: the website

Squeektoshi's wheel powers a string of numbered bulbs. Every 10 minutes he keeps running, the next bulb lights.
Bet test SQK on a bulb; when he falls asleep (the lights go out), the lit bulbs share the pot.

This folder is the real site, built from the approved prototype (`art/led-demo/lights-on.html`): same LED board,
same plain dashboard (your bulb, one number, one button), same words. Plain HTML, CSS and JavaScript modules: no
build step, no libraries, no npm.

- **Live** (the default) follows his ride right now from Squeekchain's records on Sepolia.
- **Watch a past night** replays one of his real nights with nine pretend players (the prototype's replay).

## Run it

ES modules and `config.json` need a web server (opening `index.html` as a file won't work):

```
python3 -m http.server 8771 --directory site --bind 127.0.0.1
# then open http://127.0.0.1:8771/
```

Any static host works the same way. `#past` opens the replay; `?config=other.json` loads another config file from
this folder (for a local test chain).

## config.json

| Key | |
|---|---|
| `chainId` | 11155111 (Sepolia). The wallet is asked to switch to it, or to add it. |
| `rpc` | JSON-RPC URLs, tried in order; one that can't be reached or rate-limits is skipped. |
| `squeekCore`, `sqk` | SqueekCore proxy and the SQK token on Sepolia. |
| `lightsOn` | The game contract. Empty until it is deployed: the page then shows the live board, the odds and "Betting opens soon", with no wallet buttons. |
| `deployBlock` | Block the game was deployed in. Your past bets are found from there (BetPlaced logs); 0 skips that and only shows bets the page reads anyway. |
| `chainName`, `explorer` | Optional: the network's name on the buttons, and the block explorer for links. |
| `ethFaucet` | Optional: a link (https) where a wallet with no test ETH can get some for the network fee. |
| `statusApi` | Optional, default `https://api.squeekchain.com/v1/status`. |
| `genesis`, `walkFrom`, `clock` | Optional, for local test chains: round 1's start time (read from the contract once one is set), the round to start reading a mock core after (it must follow a blackout), and `"chain"` / `"device"` to force the clock. |

For a local anvil chain, point `rpc` at it (`http://127.0.0.1:8545`), set `chainId` 31337 and the deployed
addresses, and either use the real core through a fork or a MockCore with `walkFrom`.

## How a night settles (settlement v2, `docs/lights-on-spec.md`)

- He starts a ride with one running round (it lights nothing). Each later running round lights the next bulb. One
  quiet round is a break; two in a row are the blackout.
- One bet per wallet per ride, 10 to 10,000 SQK, bulbs 1 to 24. It counts for the ride he's on, or his next ride if
  he's asleep. A bet sent during the two quiet rounds that end a ride goes to his next ride.
- A bet whose bulb lights in the round it was sent or the next one doesn't count and is given back (anyone can
  watch him live). The page only offers bulbs far enough ahead.
- Everyone's counted bets plus the bonus pot make one pot. When the lights go out, the bets on lit bulbs share it by
  stake × (bulb − bulbs already lit when the bet was sent). 2% of what the winners take from others (the bets on dark
  bulbs and the bonus pot) is burned. A lit bulb can get back less than its bet on a long night.
- If no bet wins, the whole pot rolls over to the next ride as the bonus pot.
- Winnings are collected (they never expire). The contract counts a ride as people use it: every bet and every
  collect first reads new rounds and counts bets. So Collect works right after the blackout even if nobody else has
  played: it counts the ride and pays in one go. After a long quiet spell (or a ride with many bets) the page first
  sends one helper transaction (`poke` or `settle`) and says so.

`engine.js` is the settlement in BigInt wei, byte for byte `art/led-demo/lights-engine.js`, and reproduces every
vector in `data/lights-vectors.json` (made by `src/LightsMath.sol`) to the wei.

### The lowest bulb in live mode

The page knows the rounds SqueekCore has recorded (through S). A bet counts in round N = the round of
(time + 60 s guard band + 45 s for the wallet). Rounds S+1 … N+1 aren't recorded yet, and each can light at most one
bulb, so the page offers:

- during a ride: bulbs lit so far + those unknown rounds + 1 (normally lit + 3, as the spec's "lit so far counting
  the round in progress, + 2");
- while he's asleep: the number of unknown rounds (normally 2), except bulb 1 when he's not running right now: it
  only fails to count if he starts in the very round the bet is sent, and then the bet is given back. The page
  says so when bulb 1 is picked.

In the last two rounds of a 36-round night (departure + 34 and + 35) no bulb is offered: a bet there joins that
night, but at most one more bulb can light, so it could only be given back or lose (contract audit M4). The page
says so in plain words.

Each round's record lands about 36-48 s after the round ends, so in the first minute of each round the lowest bulb
is one higher than it will be a minute later. Near the end of a round the bet already counts for the next round.
`test/engine.test.mjs` checks this on every round of rounds 1-780: the bulb offered is never given back.

## Files

| File | |
|---|---|
| `index.html`, `styles.css`, `icon.svg` | The page |
| `app.js` | Starts the page, switches Live / Watch a past night, runs the animation loop |
| `board.js` | The LED board (from the prototype) |
| `live.js` | Live mode: reading, the dashboard, the wallet steps |
| `replay.js` | Watch a past night (the prototype's replay) |
| `live-model.js` | Pure rules for live mode: nights from rounds, the lowest bulb, which ride a bet is for, bets per bulb, the bonus pot chain, odds |
| `engine.js` | Settlement (copy of `art/led-demo/lights-engine.js`) |
| `chain.js` | **All chain access**: JSON-RPC with fallback and batching, hand-written ABI encoding/decoding (selectors and topics from `cast sig` / `cast keccak`), SqueekCore, SQK, LightsOn, the status API, the wallet (EIP-1193), the bet and collect steps, plain-word errors |
| `config.json`, `data/rides.json` | Settings; his nights through round 780 (the page reads newer rounds from SqueekCore) |
| `tools/build-rides.mjs` | Rebuilds `site/data/rides.json` from the repo's `data/rides.json` |

## Contracts (Sepolia)

- SqueekCore: [0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44](https://sepolia.etherscan.io/address/0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44): `state()`, `roundPage(after, through, max ≤ 16)`
- SQK: [0x5501e1fa81be1c3f49225fa7668da0245d07db60](https://sepolia.etherscan.io/address/0x5501e1fa81be1c3f49225fa7668da0245d07db60)
- LightsOn: [0x262c88c4eedf3d543d2523f87fa47701ac429844](https://sepolia.etherscan.io/address/0x262c88c4eedf3d543d2523f87fa47701ac429844) from block 12048847, deployed through IMD (launch 2876) (`src/LightsOn.sol`, `docs/lights-contract.md`)

The wheel speed (`speedMmPerSecond` on a fresh reading from the status API) only animates the wheel and says
whether he's running this minute; it never decides a bulb. `coreStatus` is never used.

**Which ride a bet counts for** (the words under your bulb, the sentence, "Bet placed: …"): a bet moves to his next
ride only if the lights go out before its round (two quiet rounds, C and C + 1; a bet sent in C or later is for the
next ride). So the page needs to know which rounds not recorded yet already have his turns. It keeps the wheel
readings it has seen: a round is known to have his turns when the wheel turned in it, or the status API's
`cumulativeWorkUnits` (the same counter SqueekCore records as `cumulativeWork`; checked against every round of the
11-01 night) went up inside it or is above SqueekCore's count at its start. Any other round may still be quiet.
Then: "for tonight's ride" only when no blackout can come before the bet's round (he runs now, or he stopped after
running in this round: "if he stays asleep, the lights go out and your bulb stays dark"); "for tonight, or his next
ride if the lights go out" when one can (a round quiet so far, the bet landing in the next round, or a quiet round
recorded and the next one ended but not recorded yet: then the sign says "HE IS BACK ON THE WHEEL" without promising
the next bulb); "for the ride he just started" when no ride is recorded yet but he got on the wheel; "for his next
ride" when he is asleep. "Bet placed" uses the round the bet landed in (from its receipt). This only chooses words:
the lowest bulb offered never depends on it.

## Wallet steps

Connect → switch to Sepolia (or add it) → the page checks your SQK and simulates the bet → **allow** the game to
take exactly the bet (only when it isn't allowed enough yet; never unlimited, so normally every bet) → **bet** →
wait. The bet goes out as `betUntil(bulb, amount, lastRound)` with the round the page worked the lowest bulb out
for (checked again right before sending), so a bet the network includes too late fails ("Your bet reached the
network too late…") instead of quietly landing in a later round or his next ride. After a long busy spell nobody
played in, the game may first need to catch up (`PokeFirst`): the wallet then asks once for a helper (`poke`), then
for the bet. Bets go out with a fixed gas limit of 1,500,000 and collects with 1,000,000 + 30,000 per bet (audit A3:
an estimate can be too low if a blackout is recorded meanwhile); only the gas used is paid. When a transaction
fails on chain, the page simulates it again to say why. Collect is offered for bets the contract has paid out, and for lit bets in rides that are over but not counted
yet (the page's amount is the contract's to the wei). It simulates first; if the simulation says nothing would be
paid yet, it sends a helper to count the ride (at most 3), then collects. Plain messages for: saying no in the wallet, the wrong network, not
enough SQK, a bet outside 10-10,000 SQK, no test ETH for the fee, already bet on this ride, a bulb that got too
close, a bet that arrived too late, the game catching up, the game still counting. If the game is ended (`void`),
the dashboard says so and offers only Collect for the bets that come back.

**A page node that lags behind the wallet** (public RPCs are several nodes; the Sepolia rehearsal hit this): what the
page saw go through is kept until its node shows it. A placed bet (from the receipt's `BetPlaced` log) shows at once
as your bet, the button turns off and the balance drops, so the same bet can't be sent twice; a collect (from its
`Claimed` / `Refunded` logs) leaves the button at once. After the allow step the bet is simulated on the wallet's own
node too (`eth_call` through the wallet); if no node shows the allow within about 15 s the page says "Your allow went
through, but the network is slow to show it…" (never "wasn't allowed") and remembers it, so the next press goes
straight to the bet. A bet that fails on chain with no reason from the page's node is explained from the wallet's
node ("You already have a bet on this ride…").

**No wallet in the browser** (a phone opening the page from X): the button says "How to bet on a phone" and the
answer says what to do, with "Open in MetaMask" (this page in MetaMask's browser) and "Copy the link". On a phone,
an answer to a tap scrolls into view while the button is on screen.

**No test ETH** for the network fee: the page reads the wallet's test ETH and says where to get some (`ethFaucet` in
the config is the link), without asking the wallet for anything.

**The one number** is in SQK (unit in small print) and labelled as the best case, with when it holds ("Best case: he
lights 6 to 11 bulbs"); under it, "practice SQK, no real money" in the rehearsal, "test SQK, no real money" otherwise.

**Your last ride** (a win, a refund, several wins together, or a bet that stayed dark on his last ride) fills the
dashboard ("Bulb 20 · stayed dark", "Last ride −100 SQK") and the sentence under the button gives the amount. A win
waiting to be collected never blocks a new bet: the picker stays, the button is "Collect …" until you pick a bulb or an
amount, then it is the bet and the win gets a "Collect …" link in the sentence. Winnings never expire.

## Tests (offline unless noted; no installs)

```
node site/test/engine.test.mjs        # engine == approved copy, 24 vectors, the lowest bulb on rounds 1-780, nights == data/rides.json
node site/test/chain.test.mjs         # encoders vs cast calldata, decoders vs saved Sepolia answers, errors, RPC fallback (--live: 3 real reads)
node site/test/anvil.test.mjs         # real LightsOn bytecode on local anvil: reads, the page's numbers == the contract's payouts, bet/allow/collect via a fake wallet
node site/test/live.test.mjs          # live.js in node (no browser) on anvil through a page node that lags: bet, allow, blackout, collect, no wallet
node site/test/smoke.test.cjs         # Chrome, live without a contract (asleep, running, break, blackout) + replay, 360 px light/reduced motion and 1280 px dark (--real: one pass on Sepolia)
node site/test/contract.smoke.test.mjs  # Chrome on anvil with the contract: connect, switch, allow + bet, blackout, collect
node site/test/static.test.mjs        # page skeleton, local files, no libraries, wording
node site/test/e2e.test.mjs           # the full end-to-end run on anvil in Chrome (about 1 minute): see test/README.md
```
