# Keep the Lights On

A game for [Squeekchain](https://squeekchain.com). Squeektoshi's wheel powers a string of numbered bulbs: every 10
minutes he keeps running, the next bulb lights up. Bet SQK on a bulb. When he falls asleep, the lights go out and
the lit bulbs share the pot.

Everything is settled on Sepolia straight from SqueekCore's records of his wheel. There is no server, no admin and no
off-chain oracle: the contract reads the rounds itself, and anyone can settle a night or collect for anyone.

- **Play:** <https://keepthelightson.xyz/>. The real game, with Squeekchain's SQK on Sepolia.
- **No SQK? Practice:** tap **Practice (free)** on the page, or open
  <https://keepthelightson.xyz/practice/>. The same game following his real rounds, with a
  free practice token: the page has a button that gives you 1,000 practice SQK.
- **Watch a past night:** <https://keepthelightson.xyz/#past>. This is a replay of one of his real
  nights, with nine made-up players.

## For reviewers

- **Two-minute tour.** Open the page and tap **Practice (free)**, then **Get 1,000 practice SQK**, pick a bulb and bet.
  Your bet shows on the LED board and in tonight's bets, with the pot. Tap **Watch a past night** to see a whole ride,
  from the first bulb to the blackout, in about a minute.
- **Moved to Squeekchain's new core on 5 Nov.** Squeekchain replaced SqueekCore on 4 Nov; the old core stopped settling
  at round 1339, so the game was redeployed unchanged on the new core: `0x0d8C44AF…1823` (block 12070221). The first copy,
  `0x262c88c4…9844`, was built and deployed through IMD (launch 2876) on the old core and never took a bet.
- **The deployed contract is this code.** Both copies' runtime bytecode equals a compile of `src/LightsOn.sol` from this
  repository, apart from the immutables (core, token, genesis time, station, start round). You can check that with
  `forge build` and `cast code`.
- **Review findings are kept as tests.** IMD's launch review raised two findings. The medium one (a stall of the
  unreadable kind could be measured from too early a round) was fixed before deployment with `readThrough`, and
  `test/audit_review/` proves the fix. The low one (a 7-day void can fall in a round he departs in) is kept by design:
  that ride is refunded like every bet not in a closed night. `test/audit_attacks`, `audit_money` and `audit_time` hold
  the earlier audit passes as regression tests.
- **Tests.** 149 Foundry tests: unit, fuzz, invariants, gas, and replays of his real nights. The page has static,
  engine, chain and local-chain tests, plus Chrome end-to-end runs that place, settle, collect and end real games on a
  local chain. See "Run it" below.

## How it works

1. **Bet on a bulb.** Pick a bulb from 1 to 24 and a bet from 10 to 10,000 SQK, before he starts or while he runs. Bulb 6
   means one hour of running, and bulb 12 means two hours. One bet per wallet per ride.
2. **He powers the lights.** Every 10-minute round that he runs lights the next bulb. One quiet round makes the
   lights flicker. Two quiet rounds in a row are a blackout, and the ride is over.
3. **Lit bulbs share the pot.** Everyone's bets make one pot. When the lights go out, the lit bulbs share it. Higher
   bulbs and earlier bets get bigger slices. If no bulb wins, the whole pot rolls over to the next ride as a bonus pot.

You can't bet on a bulb that the current or next round could light, because everyone can watch him live. A bet like
that is simply refunded. The full rules, with the exact maths, are in [RULES.md](RULES.md).

## How it's connected to the real hamster

Squeektoshi's wheel has a sensor. Every 10 minutes Squeekchain records how far he ran in `SqueekCore` on Sepolia,
where nobody can change it. The game contract reads those records with `roundPage` and walks through them: running
rounds light bulbs, and quiet rounds flicker them or cause a blackout. The hamster cam at the top of the page shows his
speed right now, from Squeekchain's public status API. It can run a few minutes ahead of the records, which are what
count.

## What's in here

| Path | What |
|---|---|
| `src/LightsOn.sol` | The game: bets, the night walker over SqueekCore, settlement, collecting, the stall and void safety valves |
| `src/LightsMath.sol` | Who wins and how much (weights, burn, rollover, rounding to the wei) |
| `test/` | Foundry tests: unit, fuzz, invariants, gas, replays of his real nights, the shared test vectors |
| `site/` | The website: plain HTML, CSS and JavaScript modules, no build step and no libraries |
| `site/test/` | Page tests: static checks, engine vs vectors, chain encoding, a real contract on a local chain, Chrome end to end |
| `data/rounds.json`, `data/rides.json` | His real rounds and rides from SqueekCore, which the replays and tests use |
| `data/lights-vectors.json` | Settlement test vectors that the contract and the page must both match |

## Run it

The website is static. Serve the folder and open it:

```
python3 -m http.server 8000 --directory site
```

Contract tests (Foundry):

```
forge test
```

Page tests (node 22; the browser tests also need Chrome, puppeteer and Foundry's `anvil`; see `site/test/README.md`):

```
node site/test/static.test.mjs
node site/test/engine.test.mjs
node site/test/chain.test.mjs
node site/test/e2e.test.mjs
```

## Addresses (Sepolia)

| | Address |
|---|---|
| SqueekCore (new, since 4 Nov) | `0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4` (genesis 1793735400, 600 s rounds) |
| SQK | `0xd78a3956cf63164d1fa1c622ad3c66623162fa1e` |
| **The game** | `0x0d8C44AF26De81F2749cf0FA67b45FaBFC251823` (from block 12070221, start round 258) |
| Practice game | `0x7c1b0f0e051645B157356c583a3eb4c41b63Dfab` (from block 12070225) |
| Practice token | `0xfC812E27a816e083b3313b6DECDF15dEa9d8896e` |
| First copy (old core `0x980b…3d44`, no bets) | `0x262c88c4eedf3d543d2523f87fa47701ac429844` (deployed through IMD, launch 2876) |

## Safety

The contract has no owner, no admin, no pause, no proxy and no setters. If SqueekCore stops recording for a day and
stays stuck, or he hasn't run at all for 7 days, anyone can end the game. The page shows an **End the game** button
(or **Flag the stall** first) only when that is allowed. Rides that already ended still pay as they ended. Every other bet is refunded, including bets in an unwon bonus pot, so no bet can get stuck. Winnings never
expire.

This is a test-network game. Test SQK has no money value, and 2% of what winners take from others is burned. Nothing
in the game wakes him or rewards running faster. Naps are good.
