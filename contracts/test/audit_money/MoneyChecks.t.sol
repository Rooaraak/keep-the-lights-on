// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "../LightsBase.t.sol";
import {LightsOn} from "../../src/LightsOn.sol";
import {LightsMath} from "../../src/LightsMath.sol";

/// Money audit, checks that hold. Every test here PASSES on the current LightsOn.sol. Run:
///   forge test --offline --match-path 'test/audit_money/*' --match-contract MoneyChecksTest -vv
contract MoneyChecksTest is LightsBase {
    uint8 internal constant REFUND = 0;
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;
    uint8 internal constant PAID = 1;
    uint8 internal constant ROLLED = 3;

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _void() internal {
        _coreDownForAStall();
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        lights.void();
        assertTrue(lights.voided());
    }

    // ------------------------------------------------------------ bonus pot and void

    /// Nobody wins three nights in a row (one with two refunded late bets, one with no bets at all, one with a single
    /// loser), then the game is voided with a night open. Every stake comes back to the exact bet it came from, the
    /// late bets are refunded once, the bonus pot ends at 0 and the contract ends empty.
    function test_voidReturnsAChainOfRolledPotsToTheExactBets() public {
        _at(97);
        uint256 l0 = _bet(bettors[0], 9, 100e18);
        uint256 l1 = _bet(bettors[1], 12, 250e18);
        _active(100, 102); // bulbs 1-2 lit in 101-102, quiet 103-104
        _at(101);
        uint256 r0 = _bet(bettors[2], 1, 30e18); // bulb 1 lights in 101 = this round: refunded
        uint256 r1 = _bet(bettors[3], 2, 20e18); // bulb 2 lights in 102 = next round: refunded
        core.setActive(110, 10); // false start, nobody bet
        _at(115);
        uint256 l2 = _bet(bettors[4], 5, 40e18);
        core.setActive(120, 10);
        core.setActive(121, 10); // 1 bulb: bulb 5 stays dark
        _at(125);
        uint256 o = _bet(bettors[0], 3, 500e18); // the open night
        _active(127, 129);
        _at(131);
        _settleAll();

        assertEq(lights.nightCount(), 3);
        assertEq(lights.getNight(0).result, ROLLED);
        assertEq(lights.getNight(1).bonusIn, 350e18, "the refunded 50 is not in the pot");
        assertEq(lights.getNight(1).result, ROLLED);
        assertEq(lights.getNight(2).bonusIn, 350e18, "an empty night passes the pot on untouched");
        assertEq(lights.bonusPot(), 390e18);
        assertEq(_cls(r0), REFUND);
        assertEq(_cls(r1), REFUND);
        _checkAllNights();

        // Refunds of late bets are paid at once, before any void.
        assertEq(_claim(r0), 30e18);
        assertEq(_claim(r1), 20e18);
        assertEq(_claim(r1), 0, "a second collect pays nothing");

        _void();
        assertEq(_claim(l0), 100e18);
        assertEq(_claim(l1), 250e18);
        assertEq(_claim(l2), 40e18);
        assertEq(_claim(o), 500e18);
        assertEq(_claim(l0), 0, "a second collect pays nothing");
        assertEq(lights.bonusPot(), 0);
        assertEq(sqk.balanceOf(address(lights)), 0, "nothing stuck");
    }

    /// Nobody wins night 0; its loser's stake rides in the bonus pot (collect skips it, it is not zeroed). Night 1
    /// wins that pot. Nobody wins night 2. Void: night 0's loser gets 0 (night 1 won its stake), night 2's loser gets
    /// his stake back, night 1's winner is paid as settled.
    function test_rolledStakeRidesThenIsWonThenVoidReturnsOnlyTheLaterPot() public {
        _at(97);
        uint256 l0 = _bet(bettors[0], 9, 100e18);
        _active(100, 102);
        _at(106);
        _settleAll();
        uint256 balBefore = sqk.balanceOf(address(lights));
        assertEq(lights.claim(_ids(l0)), 0, "riding in the bonus pot: skipped");
        assertEq(lights.getBet(l0).status, lights.COUNTED(), "skipped, not marked collected");
        assertEq(sqk.balanceOf(address(lights)), balBefore);

        uint256 w = _bet(bettors[1], 1, 100e18);
        _active(110, 112);
        _at(116);
        uint256 l2 = _bet(bettors[2], 9, 60e18);
        _active(118, 120);
        _at(124);
        uint256 o = _bet(bettors[3], 3, 80e18);
        _active(126, 128);
        _at(130);
        _settleAll();
        assertEq(lights.getNight(1).result, PAID);
        assertEq(lights.getNight(1).burned, 2e18, "2% of the 100 bonus pot");
        assertEq(lights.getNight(2).bonusIn, 0, "night 1 won the pot");
        assertEq(lights.bonusPot(), 60e18);
        _checkAllNights();

        _void();
        assertEq(_claim(w), 198e18, "pot 200, burn 2");
        assertEq(_claim(l0), 0, "night 1 won this stake");
        assertEq(lights.getBet(l0).status, lights.CLAIMED());
        assertEq(_claim(l2), 60e18, "still in the bonus pot at the void: back to its bet");
        assertEq(_claim(o), 80e18);
        assertEq(lights.bonusPot(), 0);
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    /// A bonus pot won by winners only: the burn is 2% of the pot alone, the winners share their stakes plus the
    /// rest of the pot, to the wei.
    function test_bonusPotWithNoLosersBurnsTwoPercentOfThePotOnly() public {
        _at(97);
        _bet(bettors[0], 9, 500e18);
        _active(100, 102); // rolls 500
        _at(106);
        uint256 a = _bet(bettors[1], 1, 100e18);
        uint256 b = _bet(bettors[2], 2, 300e18);
        _active(110, 113); // lit 3: both win, nobody loses
        _at(117);
        _settleAll();
        LightsOn.Night memory n = lights.getNight(1);
        assertEq(n.loseStake, 0);
        assertEq(n.burned, 10e18, "2% of the 500 pot");
        uint256 pa = _claim(a);
        uint256 pb = _claim(b);
        assertEq(pa + pb, 890e18, "400 staked + 500 pot - 10 burned");
        assertEq(pa, uint256(890e18) * 100 / 700, "weights 100 x 1 : 300 x 2");
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    // ------------------------------------------------------------ claims: order, doubles, rounding

    /// Odd stakes, a late winner (bulbs already lit when it was sent), a refunded late bet and two losers. Collecting
    /// one by one in bet order and collecting in one batch in reverse order pay exactly the same to every bet; a
    /// repeated id in a batch pays once; a second collect pays nothing; the night balances to the wei.
    function test_collectOrderDoesNotMatterAndPaysOnce() public {
        _at(97);
        uint256[] memory ids = new uint256[](8);
        ids[0] = _bet(bettors[0], 2, 137e18 + 7);
        ids[1] = _bet(bettors[1], 3, 1000e18 + 1);
        ids[2] = _bet(bettors[2], 5, 333e18 + 3);
        ids[3] = _bet(bettors[3], 1, 10e18);
        ids[4] = _bet(bettors[4], 7, 777e18); // dark: loses
        ids[5] = _bet(bettors[5], 9, 10e18); // dark: loses
        _active(100, 105); // lit 5
        _at(102); // bulb 1 lit in 101
        ids[6] = _bet(bettors[6], 5, 55e18 + 5); // bulb 5 lights in 105 = N + 3: wins, weight 55 x (5 - 1)
        _at(103);
        ids[7] = _bet(bettors[7], 4, 200e18); // bulb 4 lights in 104 = N + 1: refunded
        _at(110);
        _settleAll();
        assertEq(_cls(ids[6]), WIN);
        assertEq(lights.getBet(ids[6]).litBefore, 1);
        assertEq(_cls(ids[7]), REFUND);
        uint256 lost = 787e18;
        assertEq(lights.getNight(0).burned, lost * 200 / 10_000, "burn: 2% of the losers' stakes only");
        _checkAllNights();

        uint256 snap = vm.snapshotState();
        uint256[] memory forward = new uint256[](8);
        uint256 total;
        for (uint256 i; i < 8; ++i) {
            forward[i] = _claim(ids[i]);
            total += forward[i];
        }
        uint256 staked = 137e18 + 7 + 1000e18 + 1 + 333e18 + 3 + 10e18 + 777e18 + 10e18 + 55e18 + 5 + 200e18;
        assertEq(total + lights.getNight(0).burned, staked, "paid + burned == staked, to the wei");
        assertEq(forward[7], 200e18, "the refund is exactly the stake");
        assertEq(sqk.balanceOf(address(lights)), 0);
        vm.revertToState(snap);

        uint256[] memory before = new uint256[](8);
        for (uint256 i; i < 8; ++i) {
            before[i] = sqk.balanceOf(bettors[i]);
        }
        uint256[] memory twice = new uint256[](2);
        twice[0] = ids[2];
        twice[1] = ids[2];
        assertEq(lights.claim(twice), 1, "a repeated id pays once");
        uint256[] memory rev = new uint256[](8);
        for (uint256 i; i < 8; ++i) {
            rev[i] = ids[7 - i];
        }
        assertEq(lights.claim(rev), 7, "the other seven");
        for (uint256 i; i < 8; ++i) {
            assertEq(sqk.balanceOf(bettors[i]) - before[i], forward[i], "same pay in any order");
        }
        assertEq(lights.claim(rev), 0, "a second round of collects pays nothing");
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    // ------------------------------------------------------------ whales, minimums, overflow

    /// 10 whales at the 10,000 SQK limit on bulb 24, 10 minimum bets, 10 odd-wei bets and 10 near-limit bets sent
    /// mid-night after 9 bulbs lit. Lit 23 (the whales lose and fill the pot) and lit 24 (they win most of it).
    /// Both nights balance to the wei, the stored weight is exact (no cut-off) and every lit bet gets back at least
    /// 1/24 of its weight.
    function test_whalesAndMinimumBetsBalanceToTheWei_whalesLose() public {
        _whaleNight(23);
    }

    function test_whalesAndMinimumBetsBalanceToTheWei_whalesWin() public {
        _whaleNight(24);
    }

    function _whaleNight(uint256 lit) internal {
        uint256[] memory ids = new uint256[](40);
        uint256 staked;
        uint256 sumW;
        _at(97);
        for (uint256 i; i < 30; ++i) {
            uint256 amt = i < 10 ? 10_000e18 : i < 20 ? 10e18 : 10e18 + i;
            uint8 bulb = i < 10 ? 24 : uint8(i - 9); // whales on 24, the others on 1..20
            ids[i] = _bet(bettors[i], bulb, amt);
            staked += amt;
            if (bulb <= lit) sumW += amt * bulb;
        }
        _active(100, 100 + lit);
        _at(110); // bulbs 1-9 lit in 101-109
        for (uint256 i = 30; i < 40; ++i) {
            uint8 bulb = uint8(i - 18); // 12..21: bulb 12 lights in 112 = N + 2
            ids[i] = _bet(bettors[i], bulb, 9_999e18 + 999);
            staked += 9_999e18 + 999;
            sumW += (9_999e18 + 999) * (bulb - 9);
        }
        _at(100 + lit + 4);
        _settleAll();
        LightsOn.Night memory n = lights.getNight(0);
        assertEq(n.result, PAID);
        assertEq(n.sumW, sumW, "stored weight is exact");
        _checkAllNights();

        uint256 paid;
        for (uint256 i; i < 40; ++i) {
            uint256 p = _claim(ids[i]);
            paid += p;
            LightsOn.Bet memory b = lights.getBet(ids[i]);
            if (b.cls == WIN) {
                uint256 w = uint256(b.stake) * (b.bulb - b.litBefore);
                assertGe(p * 24 + 24, w, "a lit bet gets back at least 1/24 of its weight (minus 1 wei)");
            }
        }
        assertEq(paid + n.burned, staked, "paid + burned == staked");
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    /// The same 1/24 floor on random nights through the pure rule (dust stakes, random bonus pot, random litBefore).
    function testFuzz_litBetGetsBackAtLeastOneTwentyFourthOfItsWeight(uint256 seed, uint8 nBets, uint8 litIn, uint96 bonus)
        public
        view
    {
        uint256 n = bound(nBets, 1, 24);
        uint256 lit = bound(litIn, 0, 24);
        LightsMath.BetIn[] memory bets = new LightsMath.BetIn[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 bulb = 1 + (r % 24);
            bets[i] = LightsMath.BetIn({
                stake: 1 + ((r >> 8) % 10_000e18),
                bulb: bulb,
                betRound: 97,
                litRound: bulb <= lit ? 100 + bulb : 0,
                litBefore: (r >> 128) % bulb
            });
        }
        (uint256[] memory pays, uint256 burned, uint256 bonusOut, uint8[] memory cls,) =
            lights.settleNight(200, lit, bonus, bets);
        uint256 sum = burned + bonusOut;
        uint256 stakes = bonus;
        for (uint256 i; i < n; ++i) {
            sum += pays[i];
            stakes += bets[i].stake;
            if (cls[i] == WIN) {
                uint256 w = bets[i].stake * (bets[i].bulb - bets[i].litBefore);
                assertGe(pays[i] * 24 + 24, w);
            }
        }
        assertEq(sum, stakes, "conservation to the wei");
    }

    /// v2 in one number for the page: a 10 SQK bet on bulb 1 that lit, among 39 whales on bulb 24 that also lit,
    /// gets back 0.4167 SQK. That is the floor (1/24 of its stake for a bulb-1 bet sent before the start). A lit
    /// bulb is not a guaranteed profit, and not even a guaranteed refund.
    function test_aLitBetCanGetBackOnlyAboutOneTwentyFourthOfItsStake() public {
        _at(97);
        uint256 small = _bet(bettors[0], 1, 10e18);
        for (uint256 i = 1; i < 40; ++i) {
            _bet(bettors[i], 24, 10_000e18);
        }
        _active(100, 124); // lit 24
        _at(130);
        _settleAll();
        uint256 p = _claim(small);
        emit log_named_decimal_uint("10 SQK on bulb 1, lit, gets back", p, 18);
        assertEq(p, uint256(10e18) * 390_010e18 / 9_360_010e18);
        assertLt(p, 0.42e18);
        assertGe(p, uint256(10e18) / 24);
    }

    // ------------------------------------------------------------ which night a bet is in

    /// A bet in the last minute of round C - 1 counts as sent in C, so it joins the next night (litBefore 0 there).
    function test_lastMinuteBetBeforeTheBlackoutJoinsTheNextNight() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _active(100, 104); // lit 4, quiet 105-106: C = 105
        _late(104);
        uint256 g = _bet(bettors[1], 2, 100e18);
        assertEq(lights.getBet(g).betRound, 105);
        _active(110, 113);
        _at(117);
        _settleAll();
        assertEq(lights.getBet(a).night, 0);
        assertEq(lights.getBet(g).night, 1, "sent in C: the next night");
        assertEq(_cls(g), WIN);
        assertEq(lights.getBet(g).litBefore, 0);
        assertEq(_claim(a), 100e18, "alone on its night, no losers: its own stake");
        assertEq(_claim(g), 100e18);
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    /// A night cut at STATION (12 here, 36 on deploy) keeps the bets of its last two rounds, and those bets can never
    /// win: a bulb that lights in those rounds is within N + 1 (refunded), and a bulb above it stays dark (lost). The
    /// page's pick (bulbs lit so far, counting the round in progress, + 2) is a certain loss in both rounds.
    function test_lastTwoRoundsOfAStationNightCanOnlyBeRefundedOrLose() public {
        _deploy(12);
        _at(97);
        uint256 early = _bet(bettors[0], 5, 100e18);
        _active(100, 114); // runs past STATION: rounds 100-111 are the night, 112 starts the next one
        uint256[] memory late = new uint256[](24);
        _at(110); // bulbs 1-9 lit in 101-109
        for (uint256 i; i < 12; ++i) {
            late[i] = _bet(bettors[1 + i], uint8(i + 1), 50e18); // bulbs 1..12, incl. the page's pick 12
        }
        _at(111); // bulbs 1-10 lit in 101-110
        for (uint256 i; i < 12; ++i) {
            late[12 + i] = _bet(bettors[13 + i], uint8(i + 2), 50e18); // bulbs 2..13, incl. the page's pick 13
        }
        _at(118);
        _settleAll();
        LightsOn.Night memory n = lights.getNight(0);
        assertEq(n.c, 0, "STATION end");
        assertEq(n.spanEnd, 111);
        assertEq(n.lastBetRound, 111, "its last two rounds' bets stay in it");
        assertEq(lights.lit(0), 11);
        uint256 lost;
        for (uint256 i; i < 24; ++i) {
            uint8 c = _cls(late[i]);
            assertTrue(c != WIN, "no bet sent in the last two rounds can win");
            if (c == LOSE) lost += 50e18;
        }
        assertEq(lost, 150e18, "bulbs 12 (twice) and 13: the page's picks, all lost");
        assertEq(_cls(early), WIN);
        _checkAllNights();
    }

    // ------------------------------------------------------------ the view a page would read

    /// betOutcome still reports the full payout as ready after the bet was collected. A page must read
    /// getBet(id).status (CLAIMED = 2, REFUNDED = 3) to know a bet is already collected.
    function test_betOutcomeLooksTheSameBeforeAndAfterCollecting() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        (uint256 payBefore, bool readyBefore) = _due(a);
        assertEq(_claim(a), 198e18);
        (uint256 payAfter, bool readyAfter) = _due(a);
        assertEq(payAfter, payBefore);
        assertEq(readyAfter, readyBefore);
        assertEq(lights.getBet(a).status, lights.CLAIMED());
        assertEq(_claim(a), 0, "the money itself is safe");
    }
}
