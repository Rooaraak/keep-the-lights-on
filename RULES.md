# Keep the Lights On: the rules

## Rounds and rides

- SqueekCore records Squeektoshi's wheel in 10-minute rounds. Round R covers `[G + (R − 1) × 600, G + R × 600)` seconds,
  with G = 1793022600. Rounds where he ran are *active*, and the rest are *quiet*.
- **A ride** starts with the first active round after a blackout. That round starts the generator and lights nothing.
  Every later active round lights the next bulb: bulb 1, bulb 2, and so on. Bulb k means k × 10 minutes of running.
- **One quiet round** is a break: the lights flicker, and nothing else changes.
- **Two quiet rounds in a row** are a blackout. The ride ends, and its bets are settled.
- A ride ends after 36 rounds (6 hours) at the latest, even if he is still running.
- A ride where no bulb lit (he ran one round and slept) is a false start.

## Betting

- Pick one bulb from 1 to 24 and a bet from 10 to 10,000 SQK. These are fixed limits, not settings.
- One bet per wallet per ride. A bet can't be changed or taken back.
- A bet belongs to the ride that is open when it is sent, or to the next ride if he is asleep. A bet sent in the last
  60 seconds of a round counts as sent in the next round.
- Bets sent during the two quiet rounds that end a ride belong to the **next** ride.
- **Two rounds ahead:** a bet sent in round N whose bulb lights in round N + 1 or earlier doesn't count, and it is
  refunded. Everyone can watch him live, so nobody may profit from a bulb that is already being lit. The page only
  offers bulbs far enough ahead, so a normal bet never hits this.
- In the last two rounds of a 6-hour ride, no new bulb can win. The page says so, and new bets wait for his next ride.

## When the lights go out

Let `lit` be the number of bulbs lit when the ride ends. Refunded bets are set aside first. Of the bets that count,
**winners** picked a bulb ≤ `lit`, and **losers** picked a higher one.

- **Pot** = every counted bet, winners' and losers', plus the bonus pot carried into this ride.
- **Burn** = 2% of (losers' bets + the incoming bonus pot), that is, 2% of what winners take from others. If nobody lost
  and there is no bonus pot, nothing is burned.
- **Weight of a winning bet** = `bet × (bulb − litBefore)`. `litBefore` is the number of bulbs already lit before the
  round the bet was sent in, so it's 0 for a bet sent before he started. Higher bulbs and earlier bets weigh more.
- **Each winner gets** `(pot − burn) × weight ÷ (sum of all winners' weights)`. Losers get nothing.
- On a long ride a low lit bulb can get back less than it bet, because the higher bulbs take most of the pot.
- **No winner** (false starts included): every counted bet, plus any incoming bonus pot, rolls over as the next ride's
  bonus pot. Nothing is paid and nothing is burned. Refunded bets are still refunded.
- Everything is rounded down step by step, so payouts + burn + rolled-over pot + refunds add up to the bets plus the
  incoming pot, to the wei.

## Collecting

- Anyone can settle a ride, and anyone can collect for anyone. The money always goes to the bet's owner.
- Winnings and refunds never expire.

## Safety valves

- There is no owner, admin, pause, proxy or setter. The SqueekCore address and every limit are fixed in the contract.
- If SqueekCore stops recording, or its answers can't be read, for 144 rounds (24 hours), anyone can flag a stall. If
  it is still stuck the same way 24 hours later, anyone can end the game. If he hasn't run at all for 7 days, anyone can
  end the game straight away.
- When the game ends, rides that already ended still pay as they ended. Every other bet is refunded, and so is every
  bet in a bonus pot that no ride won. No bet can get stuck.
- Nothing rewards speed or wakes him. Only running rounds count, not turns.
