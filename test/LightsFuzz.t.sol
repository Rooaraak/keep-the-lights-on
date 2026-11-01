// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "./LightsBase.t.sol";
import {LightsOn} from "../src/LightsOn.sol";
import {LightsMath} from "../src/LightsMath.sol";

contract LightsFuzzTest is LightsBase {
    uint256 internal deposited;

    // ------------------------------------------------------------ the pure rule

    struct Sums {
        uint256 stakes;
        uint256 pays;
        uint256 winStake;
        uint256 loseStake;
        uint256 sumW;
        uint256 winPays;
        uint256 wins;
    }

    /// Arbitrary nights, dust stakes included: payouts + burn + bonusOut == stakes + bonusIn to the wei, and the
    /// two-rounds rule, both results, the burn and the v2 shares hold exactly.
    function testFuzz_pureNightConservesToTheWei(uint256 seed, uint8 nBets, uint64 mask, uint96 bonus, bool withPot)
        public
        view
    {
        uint256 n = bound(nBets, 0, 40);
        uint64 stops = (mask & ((uint64(1) << 36) - 1)) | 1; // departure + up to 35 bulbs
        uint256 start = 100;
        uint256 bulbsLit = _bulbsLit(stops);
        uint256 bonusIn = withPot ? uint256(bonus) : 0;
        LightsMath.BetIn[] memory bets = new LightsMath.BetIn[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 bulb = 1 + (r >> 8) % 24;
            uint256 betRound = 90 + (r >> 128) % 46;
            bets[i] = LightsMath.BetIn({
                stake: r % 4 == 0 ? (r >> 64) % 7 + 1 : 10e18 + (r >> 64) % 9_990e18, // a quarter are dust
                bulb: bulb,
                betRound: betRound,
                litRound: _litRoundOf(start, stops, bulb),
                litBefore: _litBeforeOf(start, stops, betRound)
            });
        }
        (uint256[] memory pays, uint256 burned, uint256 bonusOut, uint8[] memory cls, uint8 result) =
            lights.settleNight(200, bulbsLit, bonusIn, bets);

        Sums memory s;
        for (uint256 i; i < n; ++i) {
            LightsMath.BetIn memory b = bets[i];
            s.stakes += b.stake;
            s.pays += pays[i];
            if (b.bulb > bulbsLit) {
                assertEq(cls[i], LightsMath.LOSE, "a dark bulb loses");
                assertEq(pays[i], 0, "a loser gets nothing from its night");
                s.loseStake += b.stake;
            } else if (b.litRound <= b.betRound + 1) {
                assertEq(cls[i], LightsMath.REFUND, "lit within betRound + 1: does not count");
                assertEq(pays[i], b.stake, "and is refunded exactly");
            } else {
                assertEq(cls[i], LightsMath.WIN);
                assertLt(b.litBefore, b.bulb, "a winner's bulb was still dark when the bet was sent");
                s.sumW += b.stake * (b.bulb - b.litBefore);
                s.winStake += b.stake;
                s.winPays += pays[i];
                ++s.wins;
            }
        }
        uint256 taken = s.loseStake + bonusIn;
        assertEq(s.pays + burned + bonusOut, s.stakes + bonusIn, "payouts + burn + bonusOut == stakes + bonusIn");
        if (s.wins == 0) {
            assertEq(result, LightsMath.ROLLED);
            assertEq(bonusOut, taken, "nobody won: every counted stake and the pot roll");
            assertEq(burned, 0);
        } else {
            assertEq(result, LightsMath.PAID);
            assertEq(burned, taken * 200 / 10_000, "burn is exactly floor(2% of losers' stakes + bonus pot)");
            assertEq(s.winPays, s.winStake + taken - burned, "winners split exactly the whole pot after the burn");
            assertEq(bonusOut, 0);
            if (taken == 0) assertEq(burned, 0, "nobody lost, no pot: nothing burns, winners redistribute");
            _checkProportional(bets, pays, cls, s.sumW, s.winStake + taken - burned);
        }
    }

    /// Each winner's payout is its weight's share of the pool, off by less than one wei.
    function _checkProportional(
        LightsMath.BetIn[] memory bets,
        uint256[] memory pays,
        uint8[] memory cls,
        uint256 sumW,
        uint256 pool
    ) internal pure {
        for (uint256 i; i < bets.length; ++i) {
            if (cls[i] != LightsMath.WIN) continue;
            uint256 exact = bets[i].stake * (bets[i].bulb - bets[i].litBefore) * pool;
            uint256 got = pays[i] * sumW;
            assertLt(got > exact ? got - exact : exact - got, sumW, "pay = pool * weight / total, within 1 wei");
        }
    }

    /// Inputs that describe no real night (a winner whose bulb had already lit when the bet was sent) are refused.
    function test_pureRefusesAWinnerLitBeforeItsBet() public {
        LightsMath.BetIn[] memory bets = new LightsMath.BetIn[](1);
        bets[0] = LightsMath.BetIn({stake: 10e18, bulb: 2, betRound: 97, litRound: 102, litBefore: 2});
        vm.expectRevert(abi.encodeWithSelector(LightsMath.InconsistentBet.selector, 0));
        lights.settleNight(200, 5, 0, bets);
    }

    function testFuzz_guardBand(uint32 dt) public {
        uint256 t = G + 96 * 600 + bound(dt, 0, 40 * 600);
        vm.warp(t);
        core.setSettled(uint64(lights.currentRound() - 1));
        uint256 id = _bet(bettors[0], 5, 50e18);
        uint256 n = lights.getBet(id).betRound;
        assertEq(n, (t + 60 - G) / 600 + 1, "the round of block time + 60 s");
        uint256 cur = lights.currentRound();
        if (t >= G + cur * 600 - 60) assertEq(n, cur + 1, "last 60 s: the next round");
        else assertEq(n, cur);
    }

    // ------------------------------------------------------------ random nights through the contract

    /// Two rounds in three running, random bettors every round, random page sizes. Every night the paged contract
    /// settles equals the pure rule bet by bet, the bonus pot chains night to night, one address has one bet per
    /// night, and every wei is paid, burned, carried or still waiting.
    function testFuzz_randomNightsPagedEqualsPure(uint256 seed) public {
        uint256 last = _randomHistory(seed, 100, 200);
        _at(last + 3);
        lights.poke(100);
        while (lights.nextSettle() < lights.nightCount()) {
            lights.settle(1 + uint256(keccak256(abi.encode(seed, lights.betCursor()))) % 5);
        }
        uint256 firstOpen = _checkAllNights();
        _assertOneBetPerNight();

        uint256 paid;
        uint256 waiting;
        for (uint256 id; id < lights.betCount(); ++id) {
            if (id >= firstOpen) {
                waiting += lights.getBet(id).stake;
                continue;
            }
            paid += _claim(id);
        }
        assertEq(paid + sqk.totalBurned() + lights.bonusPot() + waiting, deposited, "every wei accounted for");
        assertEq(sqk.balanceOf(address(lights)), lights.bonusPot() + waiting);
    }

    /// Any state, then the core dies: after flagStall, 24 h and void, claiming every bet leaves nothing behind,
    /// the bonus pot included, and nobody gets more back than a settled night or their own stake gives.
    function testFuzz_voidLeavesNothingStuck(uint256 seed, uint8 stopAt) public {
        uint256 last = _randomHistory(seed, 100, 100 + bound(stopAt, 5, 120));
        _at(last + 1);
        lights.poke(100);
        lights.settle(bound(seed, 0, 30)); // possibly part-way
        _coreDownForAStall();
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        if (lights.nextSettle() < lights.nightCount()) {
            vm.expectRevert(LightsOn.SettleFirst.selector);
            lights.void();
            lights.settle(1_000_000);
        }
        lights.void();
        uint256 potBefore = lights.bonusPot();
        uint256 paid;
        uint256 refundedPot;
        for (uint256 id; id < lights.betCount(); ++id) {
            LightsOn.Bet memory b = lights.getBet(id);
            uint256 got = _claim(id);
            paid += got;
            if (b.status == lights.WAITING()) {
                assertEq(got, b.stake, "a bet in no settled night is refunded");
            } else if (lights.getNight(b.night).result == LightsMath.ROLLED && b.cls == LightsMath.LOSE) {
                assertTrue(got == 0 || got == b.stake, "a rolled stake comes back whole, or was won");
                refundedPot += got;
            }
        }
        assertEq(refundedPot, potBefore, "the stranded bonus pot goes back to exactly the bets it came from");
        assertEq(lights.bonusPot(), 0);
        assertEq(sqk.balanceOf(address(lights)), lights.unburned(), "nothing stuck");
        assertEq(paid + sqk.totalBurned(), deposited);
        uint256[] memory ids = new uint256[](lights.betCount());
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = i;
        }
        assertEq(lights.claim(ids), 0, "every bet is closed");
    }

    /// Plays rounds [from, to): about two in three active, with 0-3 bet attempts per round by 12 bettors, some in
    /// the guard band. A refused attempt must be AlreadyBet. Returns the last round played.
    function _randomHistory(uint256 seed, uint256 from, uint256 to) internal returns (uint256) {
        for (uint256 r = from; r < to; ++r) {
            uint256 h = uint256(keccak256(abi.encode(seed, r)));
            if (h % 3 != 0) core.setActive(uint64(r), uint64(100 + h % 500));
        }
        for (uint256 r = from - 4; r < to; ++r) {
            uint256 h = uint256(keccak256(abi.encode(seed, r, "bets")));
            if ((h >> 200) % 5 == 0) _late(r);
            else _at(r);
            for (uint256 k; k < h % 4; ++k) {
                uint256 x = uint256(keccak256(abi.encode(h, k)));
                address who = bettors[x % 12];
                uint8 bulb = uint8(1 + (x >> 16) % 24);
                uint256 stake = 10e18 + (x >> 64) % 3_000e18;
                vm.prank(who);
                try lights.bet(bulb, stake) {
                    deposited += stake;
                } catch (bytes memory err) {
                    assertEq(bytes4(err), LightsOn.AlreadyBet.selector, "only AlreadyBet may refuse a valid bet");
                }
            }
            if ((h >> 100) % 7 == 0) lights.settle((h >> 120) % 6);
        }
        return to;
    }

    function _assertOneBetPerNight() internal view {
        uint256 first;
        for (uint256 x; x < lights.nightCount(); ++x) {
            LightsOn.Night memory n = lights.getNight(x);
            if (n.result == 0) break;
            for (uint256 i = first; i < n.betEnd; ++i) {
                for (uint256 j = i + 1; j < n.betEnd; ++j) {
                    assertTrue(lights.getBet(i).owner != lights.getBet(j).owner, "one bet per address per night");
                }
            }
            first = n.betEnd;
        }
    }
}
