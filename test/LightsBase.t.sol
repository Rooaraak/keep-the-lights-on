// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LightsOn} from "../src/LightsOn.sol";
import {LightsMath} from "../src/LightsMath.sol";
import {MockCore, MockSQK} from "./mocks/Mocks.sol";

abstract contract LightsBase is Test {
    uint256 internal constant G = 1793022600;
    uint256 internal constant SQK1 = 1e18;

    MockCore internal core;
    MockSQK internal sqk;
    LightsOn internal lights;
    address[] internal bettors;

    function setUp() public virtual {
        _deploy(36);
    }

    function _deploy(uint256 station) internal {
        core = new MockCore();
        sqk = new MockSQK();
        lights = new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(sqk), genesisTime: G, station: station, startRound: 0})
        );
        delete bettors;
        for (uint256 i; i < 40; ++i) {
            address a = address(uint160(0xBE7000 + i));
            bettors.push(a);
            _fund(a, 1_000_000e18);
        }
    }

    function _fund(address who, uint256 amt) internal {
        sqk.mint(who, amt);
        vm.prank(who);
        sqk.approve(address(lights), type(uint256).max);
    }

    /// 100 s into round r, with every earlier round recorded.
    function _at(uint256 r) internal {
        vm.warp(G + (r - 1) * 600 + 100);
        core.setSettled(uint64(r - 1));
    }

    /// 30 s before round r ends: inside the guard band, so a bet counts as sent in round r+1.
    function _late(uint256 r) internal {
        vm.warp(G + r * 600 - 30);
        core.setSettled(uint64(r - 1));
    }

    function _bet(address who, uint8 bulb, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = lights.bet(bulb, amount);
    }

    function _settleAll() internal {
        lights.poke(1000);
        lights.settle(1_000_000);
    }

    function _claim(uint256 id) internal returns (uint256 paid) {
        address o = lights.getBet(id).owner;
        uint256 before = sqk.balanceOf(o);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        lights.claim(ids);
        paid = sqk.balanceOf(o) - before;
    }

    function _due(uint256 id) internal view returns (uint256 pay, bool ready) {
        (,,, pay, ready) = lights.betOutcome(id);
    }

    function _cls(uint256 id) internal view returns (uint8 cls) {
        (, cls,,,) = lights.betOutcome(id);
    }

    function _active(uint256 from, uint256 to) internal {
        core.setActiveRange(uint64(from), uint64(to));
    }

    /// The core stops answering and stays down until 145 rounds have ended after the last round the walker read.
    /// Only then does it count as stalled (the spec: 144 rounds), so flagStall works from here on.
    function _coreDownForAStall() internal {
        core.setReverting(true);
        uint256 r = uint256(lights.getWalker().cursor) + 146; // last ended round = r - 1 > cursor + 144
        if (lights.currentRound() < r) vm.warp(G + (r - 1) * 600 + 100);
        assertTrue(lights.stalled(), "down for 145 rounds: a stall");
    }

    // ------------------------------------------------------------ independent reading of a night

    function _bulbsLit(uint64 stops) internal pure returns (uint256 n) {
        for (uint256 i = 1; i < 64; ++i) {
            if ((stops >> i) & 1 == 1) ++n;
        }
    }

    /// Round bulb k lit in, read straight off the stops mask, 0 if it stayed dark.
    function _litRoundOf(uint256 start, uint64 stops, uint256 k) internal pure returns (uint256) {
        uint256 seen;
        for (uint256 i = 1; i < 64; ++i) {
            if ((stops >> i) & 1 == 1 && ++seen == k) return start + i;
        }
        return 0;
    }

    /// Bulbs lit in rounds before `betRound`, read straight off the stops mask.
    function _litBeforeOf(uint256 start, uint64 stops, uint256 betRound) internal pure returns (uint256 n) {
        for (uint256 i = 1; i < 64 && start + i < betRound; ++i) {
            if ((stops >> i) & 1 == 1) ++n;
        }
    }

    struct PureNight {
        uint256[] pays;
        uint256 burned;
        uint256 bonusOut;
        uint8[] cls;
        uint8 result;
    }

    /// The bets of night x as the pure function takes them, with litRound and litBefore read off the stops mask by
    /// the test. Bets sent in a blackout's two quiet rounds (C and C + 1) belong to the next night.
    function _pureInputs(uint256 x, uint256 firstBet, uint256 betEnd)
        internal
        view
        returns (LightsMath.BetIn[] memory ins, uint256 stakes)
    {
        LightsOn.Night memory night = lights.getNight(x);
        uint256 prevLast = x == 0 ? 0 : _lastBetRoundOf(lights.getNight(x - 1));
        ins = new LightsMath.BetIn[](betEnd - firstBet);
        for (uint256 i; i < ins.length; ++i) {
            LightsOn.Bet memory b = lights.getBet(firstBet + i);
            assertGt(b.betRound, prevLast, "bet is after the previous night's last bet round");
            assertLe(b.betRound, _lastBetRoundOf(night), "bet is before this night's blackout (or at its STATION end)");
            ins[i] = LightsMath.BetIn({
                stake: b.stake,
                bulb: b.bulb,
                betRound: b.betRound,
                litRound: _litRoundOf(night.start, night.stops, b.bulb),
                litBefore: _litBeforeOf(night.start, night.stops, b.betRound)
            });
            stakes += b.stake;
        }
    }

    /// The spec's bet window, from the night's shape: bets up to C - 1 (C and C + 1 go to the next night), or up to
    /// the last round at a STATION end. Also checks the contract stored the same.
    function _lastBetRoundOf(LightsOn.Night memory night) internal pure returns (uint256 last) {
        last = night.c != 0 ? uint256(night.c) - 1 : night.spanEnd;
        assertEq(night.lastBetRound, last, "lastBetRound = C - 1, or spanEnd at a STATION end");
    }

    /// Re-settles a settled night with the pure function and checks that the paged contract agrees bet by bet,
    /// that the night balances to the wei, and that its bonus pot came from the night before.
    function _checkNightAgainstPure(uint256 x, uint256 firstBet) internal view returns (uint256 betEnd) {
        LightsOn.Night memory night = lights.getNight(x);
        require(night.result != 0, "night not settled");
        betEnd = night.betEnd;
        (LightsMath.BetIn[] memory ins, uint256 stakes) = _pureInputs(x, firstBet, betEnd);
        uint256 bulbsLit = _bulbsLit(night.stops);
        assertEq(lights.lit(x), bulbsLit, "lit");
        PureNight memory p;
        (p.pays, p.burned, p.bonusOut, p.cls, p.result) = lights.settleNight(200, bulbsLit, night.bonusIn, ins);
        assertEq(p.result, night.result, "result");
        assertEq(p.burned, night.burned, "burned");
        uint256 sum = p.burned + p.bonusOut;
        for (uint256 i; i < ins.length; ++i) {
            _checkBet(firstBet + i, ins[i], p, i);
            sum += p.pays[i];
        }
        assertEq(sum, stakes + night.bonusIn, "payouts + burn + bonusOut == stakes + bonusIn");
        // what this night carried is what the next night received (or what is still carried, if none has settled)
        bool nextSettled = x + 1 < lights.nightCount() && lights.getNight(x + 1).result != 0;
        uint256 carried = nextSettled ? lights.getNight(x + 1).bonusIn : lights.bonusPot();
        if (nextSettled || !lights.voided()) assertEq(carried, p.bonusOut, "bonusOut is the next night's bonusIn");
    }

    function _checkBet(uint256 id, LightsMath.BetIn memory b, PureNight memory p, uint256 i) internal view {
        assertEq(_cls(id), p.cls[i], "class");
        assertEq(lights.getBet(id).litBefore, b.litBefore, "litBefore stored by settle == read off the stops");
        (uint256 pay, bool ready) = _due(id);
        // a loser in a ROLLED night is owed nothing by this night: its stake is in bonusOut
        if (p.result == LightsMath.ROLLED && p.cls[i] == LightsMath.LOSE) {
            if (!lights.voided()) assertEq(pay, 0, "rolled loser owed nothing yet");
        } else {
            assertTrue(ready, "ready");
            assertEq(pay, p.pays[i], "paged payout == pure payout");
        }
        if (b.litRound != 0 && b.litRound <= b.betRound + 1) {
            assertEq(p.pays[i], b.stake, "bulb lit within betRound + 1: refunded, no profit");
        }
    }

    /// Checks every settled night in order. Returns the first bet that is not in a settled night.
    function _checkAllNights() internal view returns (uint256 first) {
        for (uint256 x; x < lights.nightCount(); ++x) {
            if (lights.getNight(x).result == 0) break;
            first = _checkNightAgainstPure(x, first);
        }
    }
}
