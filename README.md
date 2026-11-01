# Keep the Lights On

A game for [Squeekchain](https://squeekchain.com). Squeektoshi's wheel powers a string of numbered bulbs: every 10
minutes he keeps running, the next bulb lights up. Bet test SQK on a bulb. When he falls asleep, the lights go out and
the lit bulbs share the pot.

Everything is settled on Sepolia straight from SqueekCore's records of his wheel. There is no server, no admin and no
off-chain oracle: the contract reads the rounds itself, and anyone can settle a night or collect for anyone.

- **Play the rehearsal:** <https://rooaraak.github.io/keep-the-lights-on/?config=rehearsal.json>. It's a test copy of
  the game on Sepolia that follows his real rounds, using a free practice token. The page has a button that gives you
  1,000 practice SQK.
- **Watch a past night:** <https://rooaraak.github.io/keep-the-lights-on/#past>. This is a replay of one of his real
  nights, with nine made-up players.

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
| `contracts/src/LightsOn.sol` | The game: bets, the night walker over SqueekCore, settlement, collecting, the stall and void safety valves |
| `contracts/src/LightsMath.sol` | Who wins and how much (weights, burn, rollover, rounding to the wei) |
| `contracts/test/` | Foundry tests: unit, fuzz, invariants, gas, replays of his real nights, the shared test vectors |
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
cd contracts && forge test
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
| SqueekCore | `0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44` |
| SQK | `0x5501e1fa81be1c3f49225fa7668da0245d07db60` |
| Rehearsal game | `0xFe3D58bb18F89DCe0F13a0E83Ca7A9a7E458F49F` |
| Rehearsal practice token | `0xfC812E27a816e083b3313b6DECDF15dEa9d8896e` |
| The real game | not deployed yet |

## Safety

The contract has no owner, no admin, no pause, no proxy and no setters. If SqueekCore stops recording for a day and
stays stuck, or he hasn't run at all for 7 days, anyone can end the game. Rides that already ended still pay as they
ended. Every other bet is refunded, including bets in an unwon bonus pot, so no bet can get stuck. Winnings never
expire.

This is a test-network game. Test SQK has no money value, and 2% of what winners take from others is burned. Nothing
in the game wakes him or rewards running faster. Naps are good.
