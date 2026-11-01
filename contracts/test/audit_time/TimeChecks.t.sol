// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "../LightsBase.t.sol";
import {LightsOn} from "../../src/LightsOn.sol";
import {MockCore} from "../mocks/Mocks.sol";

/// Time and chain-data audit, checks that HOLD on the current LightsOn.sol (every test here passes). They pin the
/// boundaries the time rules depend on, so a later change that breaks one shows up at once.
///   forge test --offline --match-path 'test/audit_time/*' --match-contract TimeChecksTest -vv
contract TimeChecksTest is LightsBase {
    uint8 internal constant REFUND = 0;
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;

    uint256 internal constant SEPOLIA_GENESIS = 1655733600; // beacon genesis; slots every 12 s

    struct Active {
        uint256 cumulative;
        uint256 id;
        uint256 work;
    }

    // ------------------------------------------------------------ round <-> time

    /// round R = [G + (R-1)*600, G + R*600), and a bet in the last 60 s counts in the next round. On Sepolia every
    /// block lands on a 12 s slot, and G, 600 and 60 are all multiples of 12, so each edge is one exact block.
    function test_roundAndGuardBandEdges() public {
        assertEq((G - SEPOLIA_GENESIS) % 12, 0, "G is on a Sepolia slot");
        assertEq(uint256(600) % 12, 0);
        assertEq(uint256(60) % 12, 0);

        vm.warp(G);
        assertEq(lights.currentRound(), 1);
        vm.warp(G + 599);
        assertEq(lights.currentRound(), 1);
        vm.warp(G + 600);
        assertEq(lights.currentRound(), 2);

        uint256 r = 105;
        vm.warp(G + (r - 1) * 600); // first second of the round
        assertEq(lights.effectiveRound(), r);
        vm.warp(G + r * 600 - 61); // one second before the guard band
        assertEq(lights.currentRound(), r);
        assertEq(lights.effectiveRound(), r);
        vm.warp(G + r * 600 - 60); // first second of the guard band
        assertEq(lights.currentRound(), r);
        assertEq(lights.effectiveRound(), r + 1);
        vm.warp(G + r * 600 - 1);
        assertEq(lights.effectiveRound(), r + 1);

        // bets right at those edges
        core.setSettled(uint64(r - 1));
        vm.warp(G + r * 600 - 72); // the last block that still counts in round r
        assertEq(lights.getBet(_bet(bettors[0], 3, 50e18)).betRound, r);
        vm.warp(G + r * 600 - 60); // the next block
        assertEq(lights.getBet(_bet(bettors[1], 3, 50e18)).betRound, r + 1);

        // before genesis: only the last 60 s before it count (as round 1); anything earlier is refused
        _deploy(36);
        vm.warp(G - 61);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.BeforeGenesis.selector);
        lights.bet(3, 50e18);
        vm.warp(G - 60);
        assertEq(lights.getBet(_bet(bettors[0], 3, 50e18)).betRound, 1);
    }

    // ------------------------------------------------------------ which night a bet is in

    /// One night with a break, then the next night, with a bet at every edge:
    /// leaves 100, bulbs 1-4 in 101-104, 105 quiet (a break), bulb 5 in 106, lights out 107-108 (C = 107);
    /// the next night leaves 110 (bulbs in 111, 112), lights out 113-114.
    function test_betAtEveryNightEdgeJoinsTheRightNight() public {
        _active(100, 104);
        core.setActive(106, 500);
        _active(110, 112);

        _at(99);
        uint256 dMinus1 = _bet(bettors[0], 1, 100e18); // before he leaves
        _at(100);
        uint256 dBulb1 = _bet(bettors[1], 1, 100e18); // the round he leaves in
        uint256 dBulb2 = _bet(bettors[2], 2, 100e18);
        _at(105);
        uint256 brk5 = _bet(bettors[3], 5, 100e18); // in the break: bulb 5 lights in 106
        uint256 brk6 = _bet(bettors[4], 6, 100e18); // bulb 6 never lights
        _late(106); // last 60 s of the last bet round: counts as C
        uint256 lateC = _bet(bettors[5], 1, 100e18);
        _at(107);
        uint256 inC = _bet(bettors[6], 2, 100e18);
        _at(108);
        uint256 inC1 = _bet(bettors[7], 1, 100e18);
        _at(109);
        uint256 between = _bet(bettors[8], 1, 100e18);
        _late(109); // counts as 110, the next departure
        uint256 lateGap = _bet(bettors[9], 1, 100e18);
        _at(110);
        uint256 d2 = _bet(bettors[10], 2, 100e18);
        _at(120);
        _settleAll();

        LightsOn.Night memory n0 = lights.getNight(0);
        assertEq(n0.c, 107);
        assertEq(n0.lastBetRound, 106);
        assertEq(lights.lit(0), 5);

        uint256[5] memory night0 = [dMinus1, dBulb1, dBulb2, brk5, brk6];
        uint8[5] memory cls0 = [WIN, REFUND, WIN, REFUND, LOSE];
        uint8[5] memory before0 = [0, 0, 0, 4, 4];
        for (uint256 i; i < 5; ++i) {
            assertEq(lights.getBet(night0[i]).night, 0, "tonight");
            assertEq(_cls(night0[i]), cls0[i], "class");
            assertEq(lights.getBet(night0[i]).litBefore, before0[i], "bulbs lit before the bet's round");
        }
        uint256[6] memory night1 = [lateC, inC, inC1, between, lateGap, d2];
        uint8[6] memory cls1 = [WIN, WIN, WIN, WIN, REFUND, WIN];
        for (uint256 i; i < 6; ++i) {
            assertEq(lights.getBet(night1[i]).night, 1, "the next night");
            assertEq(_cls(night1[i]), cls1[i], "class");
            assertEq(lights.getBet(night1[i]).litBefore, 0, "nothing lit yet in the next night");
        }
        assertEq(lights.getBet(lateC).betRound, 107, "the guard band moved it into C");
        assertEq(lights.getBet(lateGap).betRound, 110, "the guard band moved it into the departure round");
        _checkAllNights();
    }

    /// A STATION end (36 rounds, he never stops): bets up to its last round stay in it; a bet in that round's last
    /// 60 s is in the next night, which leaves in the very next round.
    function test_betAtStationEdges() public {
        _active(100, 140); // night 0 = 100..135, night 1 leaves 136, bulbs in 137-140, lights out 141-142
        _at(97);
        _bet(bettors[0], 24, 100e18);
        _at(134);
        uint256 sMinus1 = _bet(bettors[1], 24, 100e18);
        _at(135);
        uint256 s = _bet(bettors[2], 2, 100e18);
        _late(135);
        uint256 lateS = _bet(bettors[3], 2, 100e18);
        _at(136);
        uint256 d = _bet(bettors[4], 1, 100e18);
        _at(150);
        _settleAll();
        assertEq(lights.getNight(0).c, 0);
        assertEq(lights.getNight(0).spanEnd, 135);
        assertEq(lights.getBet(sMinus1).night, 0);
        assertEq(lights.getBet(s).night, 0);
        assertEq(_cls(sMinus1), REFUND);
        assertEq(_cls(s), REFUND);
        assertEq(lights.getBet(s).litBefore, 34);
        assertEq(lights.getBet(lateS).night, 1);
        assertEq(lights.getBet(lateS).betRound, 136);
        assertEq(_cls(lateS), WIN, "bulb 2 of the next night lights in 138 = 136 + 2");
        assertEq(_cls(d), REFUND, "bulb 1 lights in 137 = 136 + 1");
        _checkAllNights();
    }

    /// The largest STATION the constructor allows (64): bit 63 of the stops mask is used by the walker's shift and
    /// by the litBefore mask, and both stay right.
    function test_station64UsesTheTopBit() public {
        _deploy(64);
        _active(100, 170); // night 0 = 100..163 (63 bulbs), night 1 leaves 164 (6 bulbs), lights out 171-172
        _at(97);
        uint256 early = _bet(bettors[0], 24, 100e18);
        _at(162);
        uint256 b62 = _bet(bettors[1], 1, 100e18);
        _at(163);
        uint256 b63 = _bet(bettors[2], 24, 100e18);
        _at(180);
        _settleAll();
        LightsOn.Night memory n0 = lights.getNight(0);
        assertEq(n0.stops, type(uint64).max, "all 64 bits, bit 63 = round 163");
        assertEq(n0.spanEnd, 163);
        assertEq(lights.lit(0), 63);
        assertEq(lights.litRound(0, 24), 124);
        assertEq(lights.getBet(b62).litBefore, 61);
        assertEq(lights.getBet(b63).litBefore, 62, "the mask reaches bit 62 when the bet is in the top round");
        assertEq(_cls(early), WIN);
        assertEq(_cls(b63), REFUND);
        assertEq(lights.getNight(1).start, 164);
        assertEq(lights.lit(1), 6);
        _checkAllNights();
    }

    // ------------------------------------------------------------ the walker on real rounds, however it is fed

    function _realCoreAndLights() internal returns (MockCore c, LightsOn l) {
        c = new MockCore();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../data/rounds.json"));
        Active[] memory act = abi.decode(vm.parseJson(json, ".active"), (Active[]));
        for (uint256 i; i < act.length; ++i) {
            c.setActive(uint64(act[i].id), uint64(act[i].work));
        }
        l = new LightsOn(
            LightsOn.Config({core: address(c), sqk: address(sqk), genesisTime: G, station: 36, startRound: 0})
        );
    }

    function _sameNights(LightsOn a, LightsOn b) internal view {
        assertEq(a.nightCount(), b.nightCount(), "same number of nights");
        for (uint256 i; i < a.nightCount(); ++i) {
            LightsOn.Night memory x = a.getNight(i);
            LightsOn.Night memory y = b.getNight(i);
            assertEq(x.start, y.start, "start");
            assertEq(x.c, y.c, "C");
            assertEq(x.stops, y.stops, "bulbs");
            assertEq(x.spanEnd, y.spanEnd, "end");
            assertEq(x.lastBetRound, y.lastBetRound, "last bet round");
        }
    }

    /// Rounds 1-780 of the real core, read four ways: every round (dense), one page every 150 rounds (nobody
    /// around), the core settling in batches of 16 rounds and 48 s late (its maxRoundsPerBatch is 16), and the core
    /// down (reverting) for 150 rounds and paused for 40. All four find the same 19 nights.
    function test_realRoundsReadFourWaysGiveTheSameNights() public {
        (MockCore c0, LightsOn dense) = _realCoreAndLights();
        (MockCore c1, LightsOn sparse) = _realCoreAndLights();
        (MockCore c2, LightsOn batched) = _realCoreAndLights();
        (MockCore c3, LightsOn outage) = _realCoreAndLights();
        for (uint256 r = 1; r <= 781; ++r) {
            vm.warp(G + (r - 1) * 600 + 48);
            uint64 s = uint64(r - 1);
            c0.setSettled(s);
            dense.poke(3);
            c1.setSettled(s);
            if (r % 150 == 0) sparse.poke(1);
            c2.setSettled(uint64(((r - 1) / 16) * 16));
            batched.poke(1);
            c3.setSettled(s);
            c3.setReverting(r >= 300 && r < 450);
            c3.setPaused(r >= 600 && r < 640);
            outage.poke(1);
        }
        c2.setSettled(780);
        c3.setReverting(false);
        sparse.poke(1000);
        batched.poke(1000);
        outage.poke(1000);
        assertEq(dense.nightCount(), 19, "the 19 real nights");
        _sameNights(dense, sparse);
        _sameNights(dense, batched);
        _sameNights(dense, outage);
    }

    /// Bets placed while the core lags 30 rounds behind and nobody pokes: each bet still lands in the night its own
    /// round says, and every night settles to the wei like the pure rule.
    function test_betsWhileTheCoreLagsLandInTheRightNights() public {
        _active(100, 104); // night 0, lights out 105-106
        _active(110, 125); // night 1, lights out 126-127
        core.setActive(130, 500); // a false start, lights out 131-132
        _active(140, 150); // night 3, lights out 151-152
        uint256 who;
        for (uint256 r = 95; r <= 150; r += 3) {
            vm.warp(G + (r - 1) * 600 + 300);
            core.setSettled(uint64(r - 30)); // the core is far behind
            _bet(bettors[who++], uint8(1 + (r % 7)), 10e18 + r * 1e18); // a new bettor each time
        }
        _at(170);
        _settleAll();
        assertEq(lights.nightCount(), 4);
        _checkAllNights();
    }

    // ------------------------------------------------------------ stall and void edges

    function test_stallAndVoidTimingEdges() public {
        _at(200);
        core.setSettled(199 - 144); // exactly 144 rounds behind: not a stall yet
        assertFalse(lights.stalled());
        core.setSettled(199 - 145);
        assertTrue(lights.stalled(), "145 behind is a stall");
        lights.flagStall();
        uint256 at = lights.stallFlaggedAt();
        vm.warp(block.timestamp + 600);
        lights.flagStall(); // flagging again does not move the clock
        assertEq(lights.stallFlaggedAt(), at);
        vm.warp(at + 1 days - 1);
        vm.expectRevert(LightsOn.TooEarly.selector);
        lights.void();
        vm.warp(at + 1 days);
        vm.expectRevert(LightsOn.SettleFirst.selector); // the core can still serve rounds the walker has not read
        lights.void();
        lights.poke(100);
        lights.void();
        assertTrue(lights.voided());
        vm.expectRevert(LightsOn.IsVoided.selector);
        lights.flagStall();
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.IsVoided.selector);
        lights.bet(3, 50e18);
    }
}
