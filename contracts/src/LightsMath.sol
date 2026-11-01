// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Settlement math for Keep the Lights On (docs/lights-on-spec.md, settlement v2), shared by LightsOn's paged
/// settle/claim and the pure `settle` that produces the test vectors.
///
/// One night, `lit` = bulbs lit at the blackout, bets in the order they were placed. `litBefore` = bulbs already lit
/// before the round the bet was sent in (0 for a bet sent before the night's first bulb could light):
///   refund (bulb <= lit, and it lit in round <= betRound + 1): stake back, the bet does not count
///   win    (bulb <= lit, and it lit in round >= betRound + 2): weight = stake * (bulb - litBefore)
///   lose   (bulb > lit)
///   pot = winners' stakes + losers' stakes + bonusIn
///   PAID   (at least one winner): burned = floor((losers' stakes + bonusIn) * bps / 10000); the winners share
///          pool = pot - burned by weight, so a winner can get back less than its stake; a loser gets 0
///   ROLLED (no winner): bonusOut = losers' stakes + bonusIn, the next night's bonus pot; nothing is paid or burned
/// Shares use cumulative floors in bet order: share = floor((cb+w)*pool/W) - floor(cb*pool/W), where cb is the
/// winning weight placed before the bet. They telescope, so the winners split exactly `pool` and
/// payouts + burned + bonusOut == stakes + bonusIn to the wei (refunds included).
library LightsMath {
    uint8 internal constant REFUND = 0;
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;

    uint8 internal constant SETTLING = 0; // closed, not settled yet
    uint8 internal constant PAID = 1;
    // 2 was v1's ALL_BACK ("nobody lost: stakes back"). v2 has no such result; the number stays unused.
    uint8 internal constant ROLLED = 3;

    /// A winning bet whose litBefore is not below its bulb: the inputs describe no real night.
    error InconsistentBet(uint256 index);

    /// `litRound` is the round the bet's bulb lit in; it is only read when bulb <= lit.
    function classify(uint256 bulb, uint256 lit, uint256 betRound, uint256 litRound) internal pure returns (uint8) {
        if (bulb > lit) return LOSE;
        if (litRound <= betRound + 1) return REFUND;
        return WIN;
    }

    /// A winner's bulb lit at least two rounds after the bet, so it is above every bulb lit before: weight > 0.
    function weight(uint256 stake, uint256 bulb, uint256 litBefore) internal pure returns (uint256) {
        return stake * (bulb - litBefore);
    }

    /// `sumW` = winners' weight, `winStake` / `loseStake` = winners' / losers' stakes.
    function close(uint256 sumW, uint256 winStake, uint256 loseStake, uint256 bonusIn, uint256 burnBps)
        internal
        pure
        returns (uint8 result, uint256 burned, uint256 bonusOut, uint256 pool)
    {
        uint256 taken = loseStake + bonusIn; // what the winners take from others
        if (sumW == 0) return (ROLLED, 0, taken, 0);
        burned = taken * burnBps / 10_000;
        return (PAID, burned, 0, winStake + taken - burned);
    }

    function share(uint256 cb, uint256 w, uint256 pool, uint256 total) internal pure returns (uint256) {
        if (total == 0) return 0;
        return (cb + w) * pool / total - cb * pool / total;
    }

    /// What one bet gets from its own night. A loser gets 0 here; in a ROLLED night its stake went into bonusOut.
    /// A winner exists only in a PAID night.
    function payout(uint8 cls, uint256 stake, uint256 w, uint256 cb, uint256 sumW, uint256 pool)
        internal
        pure
        returns (uint256)
    {
        if (cls == REFUND) return stake;
        if (cls == LOSE) return 0;
        return share(cb, w, pool, sumW);
    }

    struct BetIn {
        uint256 stake;
        uint256 bulb;
        uint256 betRound;
        uint256 litRound; // 0 = the bulb never lit
        uint256 litBefore; // bulbs lit before betRound
    }

    struct Tally {
        uint8[] classes;
        uint256[] w; // weight of each winner, 0 for the others
        uint256[] cb; // winning weight placed before each winner
        uint256 sumW;
        uint256 winStake;
        uint256 loseStake;
    }

    /// Classes and weights of a night's bets, in the order they were placed.
    function tally(uint256 lit, BetIn[] memory bets) internal pure returns (Tally memory t) {
        uint256 n = bets.length;
        t.classes = new uint8[](n);
        t.w = new uint256[](n);
        t.cb = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            BetIn memory b = bets[i];
            uint8 cls = classify(b.bulb, lit, b.betRound, b.litRound);
            t.classes[i] = cls;
            if (cls == WIN) {
                if (b.litBefore >= b.bulb) revert InconsistentBet(i);
                t.w[i] = weight(b.stake, b.bulb, b.litBefore);
                t.cb[i] = t.sumW;
                t.sumW += t.w[i];
                t.winStake += b.stake;
            } else if (cls == LOSE) {
                t.loseStake += b.stake;
            }
        }
    }

    /// The whole night at once, bets in the order they were placed. LightsOn computes the same numbers page by page.
    function settle(uint256 burnBps, uint256 lit, uint256 bonusIn, BetIn[] memory bets)
        internal
        pure
        returns (uint256[] memory payouts, uint256 burned, uint256 bonusOut, uint8[] memory classes, uint8 result)
    {
        Tally memory t = tally(lit, bets);
        uint256 pool;
        (result, burned, bonusOut, pool) = close(t.sumW, t.winStake, t.loseStake, bonusIn, burnBps);
        payouts = new uint256[](bets.length);
        for (uint256 i; i < bets.length; ++i) {
            payouts[i] = payout(t.classes[i], bets[i].stake, t.w[i], t.cb[i], t.sumW, pool);
        }
        classes = t.classes;
    }
}
