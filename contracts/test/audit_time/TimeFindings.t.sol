// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "../LightsBase.t.sol";
import {LightsOn} from "../../src/LightsOn.sol";
import {LightsMath} from "../../src/LightsMath.sol";
import {MockCore} from "../mocks/Mocks.sol";
import {RoundPage, RoundRecord, LedgerPosition} from "../../src/ISqueek.sol";

/// A RoundRecord as a core upgrade might shape it: one more field (`work`). Used to build a reply LightsOn can't read.
struct RoundRecordPlus {
    uint64 roundId;
    uint64 work;
    uint64 cumulativeWork;
    uint96 cumulativeBlockUnits;
    uint32 workPerThousandBlocks;
    bytes32 dataHash;
}

struct RoundPagePlus {
    uint64 certifiedThroughRound;
    LedgerPosition start;
    LedgerPosition end;
    RoundRecordPlus[] rounds;
}

/// Time and chain-data audit (11-01), issues T1-T6. These tests FAILED on the audited LightsOn.sol; after the fixes
/// they are regression tests and pass. T5 (the start round) is not a contract change: its test checks the deploy
/// check that docs/lights-contract.md asks for.
///   forge test --offline --match-path 'test/audit_time/*' --match-contract TimeFindingsTest -vv
contract TimeFindingsTest is LightsBase {
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;
    uint8 internal constant REFUND = 0;

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    // ------------------------------------------------------------ T1: a bet had no "only in this round" limit

    /// Was: Alice signs bet(5, 100) in round 103 (2 bulbs lit, the 3rd lighting). If it waits to be included until
    /// round 106, the lights went out meanwhile and the same bet silently became her one bet for the NEXT night,
    /// where bulb 5 stays dark: she loses 100.
    /// Now: the page sends betUntil(bulb, amount, lastRound) with the round she saw. Included late, it reverts
    /// TooLate and no bet is placed. Plain bet() keeps the old behaviour (no limit), for anyone calling it directly.
    function test_T1a_aBetThatWaitsToBeIncludedJoinsTheNextNight() public {
        _active(100, 105); // tonight: he leaves in 100, bulbs 1-5 light in 101-105, lights out 106-107
        core.setActive(112, 500); // the next night: he leaves in 112, bulb 1 lights in 113, lights out 114-115
        core.setActive(113, 500);
        _at(97);
        _bet(bettors[1], 9, 100e18); // Bob, bulb 9: stays dark

        uint256 snap = vm.snapshotState();
        _at(103);
        vm.prank(bettors[0]);
        uint256 a = lights.betUntil(5, 100e18, 103); // included right away
        _at(120);
        _settleAll();
        assertEq(_claim(a), 198e18, "pot 200, burn 2, Alice is the only lit bulb");
        vm.revertToState(snap);

        _at(106); // the same signed bet, included three rounds later (the first quiet round)
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.TooLate.selector);
        lights.betUntil(5, 100e18, 103);
        assertEq(lights.lastBet(bettors[0]), 0, "no bet was placed; Alice can pick again");

        // plain bet() has no limit: the same bet joins the next night (the page must not use it)
        vm.prank(bettors[0]);
        a = lights.bet(5, 100e18);
        _at(120);
        _settleAll();
        assertEq(lights.getBet(a).night, 1, "plain bet(): counted in the next night");
    }

    /// Was: signed 70 s before round 104 ends, bulb 6 counts in round 104 and wins; included 24 s later it is in
    /// the last 60 s, counts as round 105, and is refunded instead.
    /// Now: betUntil(6, 100, 104) included 24 s later reverts TooLate.
    function test_T1b_twoBlocksOfWaitingTurnAWinIntoARefund() public {
        _active(100, 107); // bulbs 1-7 in 101-107, lights out 108-109
        _at(97);
        _bet(bettors[1], 20, 100e18); // Bob, bulb 20: stays dark
        uint256 signedAt = G + 104 * 600 - 70;

        uint256 snap = vm.snapshotState();
        vm.warp(signedAt);
        core.setSettled(103);
        assertEq(lights.effectiveRound(), 104, "the round the page shows");
        vm.prank(bettors[0]);
        uint256 a = lights.betUntil(6, 100e18, 104);
        assertEq(lights.getBet(a).betRound, 104);
        _at(115);
        _settleAll();
        assertEq(_claim(a), 198e18);
        assertEq(_cls(a), WIN);
        vm.revertToState(snap);

        vm.warp(signedAt + 24);
        core.setSettled(103);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.TooLate.selector);
        lights.betUntil(6, 100e18, 104);
    }

    // ------------------------------------------------------------ T2: a page reply that can't be read

    /// Builds the reply an upgraded SqueekCore (it is a proxy) would give if RoundRecord gained a `work` field:
    /// a perfectly normal reply in the new shape, one record for round 111, real-sized numbers.
    function _pageInNewShape() internal pure returns (bytes memory) {
        RoundRecordPlus[] memory recs = new RoundRecordPlus[](1);
        recs[0] = RoundRecordPlus({
            roundId: 111,
            work: 500,
            cumulativeWork: 67_523,
            cumulativeBlockUnits: 5_973_689_426_642,
            workPerThousandBlocks: 10_958,
            dataHash: keccak256("round 111")
        });
        return abi.encode(
            RoundPagePlus({
                certifiedThroughRound: 111,
                start: LedgerPosition(67_023, 5_973_189_426_642, 10_958),
                end: LedgerPosition(67_523, 5_973_689_426_642, 10_958),
                rounds: recs
            })
        );
    }

    /// Was: `try CORE.roundPage(...) returns (RoundPage memory p)` reverted in LightsOn itself when the reply was in
    /// another shape, and every bet and collect reads a page first: Alice's settled win (198) was stuck.
    /// Now: pages are read through a call LightsOn makes to itself, so the bad reply is caught.
    function test_T2a_pageReplyInANewShapeBlocksCollecting() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        (uint256 owed, bool ready) = _due(a);
        assertTrue(ready, "the night is settled");
        assertEq(owed, 198e18);

        core.setActive(111, 500); // he runs again; the core records 111 in the new shape
        _at(112);
        vm.mockCall(address(core), abi.encodeWithSelector(MockCore.roundPage.selector), _pageInNewShape());
        uint256 before = sqk.balanceOf(bettors[0]);
        assertEq(lights.claim(_ids(a)), 1, "collect works");
        assertEq(sqk.balanceOf(bettors[0]) - before, 198e18);
        assertEq(lights.getWalker().cursor, 109, "the walker did not read the page it can't read");
    }

    /// Was: the way out reverted too (flagStall and void read a page), and so did every new bet: 600 SQK locked.
    /// Now: a new bet works, flagStall says NotStalled until the page has been unreadable for 144 rounds, then works,
    /// and void 24 h later returns every waiting bet and the bonus pot.
    function test_T2b_pageReplyInANewShapeAlsoBlocksTheExitAndNewBets() public {
        _at(97);
        uint256 l = _bet(bettors[0], 9, 100e18);
        _active(100, 102); // nobody wins: 100 rolls into the bonus pot
        _at(110);
        _settleAll();
        uint256 o = _bet(bettors[1], 3, 500e18); // the open night
        assertEq(lights.bonusPot(), 100e18);

        core.setActive(111, 500);
        _at(112);
        vm.mockCall(address(core), abi.encodeWithSelector(MockCore.roundPage.selector), _pageInNewShape());
        vm.prank(bettors[2]);
        uint256 n = lights.bet(4, 50e18);
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();

        vm.warp(G + (109 + 145) * 600 + 100); // 145 rounds after the last round the walker read (109)
        core.setSettled(uint64(lights.currentRound() - 1)); // the core keeps settling; LightsOn just can't read it
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        core.setSettled(uint64(lights.currentRound() - 1));
        lights.void();
        assertTrue(lights.voided());
        assertEq(_claim(o), 500e18);
        assertEq(_claim(n), 50e18);
        assertEq(_claim(l), 100e18, "the bonus pot goes back to its bet");
        assertEq(sqk.balanceOf(address(lights)), 0, "nothing locked");
    }

    // ------------------------------------------------------------ T3: a pause was a stall at once

    /// Was: stalled() was true the moment the core paused, so void() worked 24 h after the pause BEGAN, and a
    /// pause of a little over a day refunded Alice's lit bulb.
    /// Now (the spec): the core must stop settling for 144 rounds before it can be flagged, and void() comes 24 h
    /// after that. A 30 h pause ends normally: Alice collects 198. A pause that really lasts can still be voided,
    /// about 48 h after it began.
    function test_T3_aDayLongPauseEndsTheGameADayEarly() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104); // bulbs 1-4, lights out 105-106
        _at(103);
        lights.poke(10);
        core.setPaused(true); // nothing is settled while paused (EnforcedPause on submitRounds)
        uint256 t0 = block.timestamp;
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();

        vm.warp(t0 + 1 days + 1);
        assertEq(lights.currentRound() - 1 - core.settled(), 144, "a day in: exactly 144 rounds behind");
        assertFalse(lights.stalled());
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();
        vm.expectRevert(LightsOn.TooEarly.selector);
        lights.void();

        uint256 snap = vm.snapshotState();
        // the core unpauses 30 h in and catches up; the night pays
        vm.warp(t0 + 30 hours);
        core.setPaused(false);
        core.setSettled(uint64(lights.currentRound() - 1));
        _settleAll();
        assertEq(_claim(a), 198e18, "Alice collects under the 144-round rule");
        vm.revertToState(snap);

        // the pause goes on: 145 rounds behind, flag, 24 h, void (the open night is refunded, as the spec says)
        vm.warp(t0 + 1 days + 600);
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        lights.void();
        assertTrue(lights.voided());
        assertGe(block.timestamp - t0, 2 days, "about 48 h after the pause began");
        assertEq(_claim(a), 100e18);
    }

    // ------------------------------------------------------------ T4: the walker trusted a page's shape only

    function _rec(uint64 r, uint64 cum) internal pure returns (RoundRecord memory) {
        return RoundRecord({
            roundId: r,
            cumulativeWork: cum,
            cumulativeBlockUnits: uint96(cum) * 1e6,
            workPerThousandBlocks: 10_000,
            dataHash: keccak256(abi.encode(r))
        });
    }

    function _mockPage(uint64 from, uint64 through, uint64 cert, uint64 endCum, RoundRecord[] memory recs) internal {
        RoundPage memory p;
        p.certifiedThroughRound = cert;
        p.start = LedgerPosition(0, 0, 10_000);
        p.end = LedgerPosition(endCum, uint96(endCum) * 1e6, 10_000);
        p.rounds = recs;
        vm.mockCall(address(core), abi.encodeCall(MockCore.roundPage, (from, through, uint256(16))), abi.encode(p));
    }

    /// Was: a page that lists 104 with no work in it (its cumulative work equals 103's) was accepted, and bulb 4
    /// "lit" while he slept. Now the walker refuses the page (each record must add work) and reads nothing; the
    /// honest page is then read as 3 bulbs.
    function test_T4a_walkerAcceptsARecordWithNoWork() public {
        _at(97);
        _bet(bettors[0], 4, 100e18); // the walker reads (0, 96] here
        RoundRecord[] memory recs = new RoundRecord[](5);
        recs[0] = _rec(100, 500);
        recs[1] = _rec(101, 1000);
        recs[2] = _rec(102, 1500);
        recs[3] = _rec(103, 2000);
        recs[4] = _rec(104, 2000); // no work: 104 was quiet
        _mockPage(96, 109, 109, 2000, recs);
        _at(110);
        assertEq(lights.poke(1), 0, "the page is refused");
        assertEq(lights.getWalker().cursor, 96);
        assertEq(lights.nightCount(), 0);

        vm.clearMockedCalls();
        _active(100, 103);
        lights.poke(1);
        assertEq(lights.lit(0), 3, "the honest page: 3 bulbs");
    }

    /// Was: a page that certifies through 109 but leaves out 102 and 103 (its end position still counts their
    /// work) was accepted: the lights "went out" in 102 with 1 bulb. Now the end position must be the last
    /// record's, so the page is refused.
    function test_T4b_walkerAcceptsAPageThatLeavesOutRunningRounds() public {
        _at(97);
        _bet(bettors[0], 3, 100e18);
        RoundRecord[] memory recs = new RoundRecord[](2);
        recs[0] = _rec(100, 500);
        recs[1] = _rec(101, 1000);
        _mockPage(96, 109, 109, 2000, recs); // end = 2000: 1000 of work is in no record
        _at(110);
        assertEq(lights.poke(1), 0, "the page is refused");
        assertEq(lights.getWalker().cursor, 96);

        vm.clearMockedCalls();
        _active(100, 103);
        lights.poke(1);
        assertEq(lights.lit(0), 3, "the honest page: 3 bulbs");
    }

    // ------------------------------------------------------------ T5: the start round is taken on trust

    /// The constructor takes the walker's start round on trust (it is not changed: a check there would need the core
    /// to have settled the start round at deploy, which local test chains don't). Deployed mid-ride (start round
    /// 104 in a ride that left in 100), the walker calls 105 the departure and counts 5 of the 10 bulbs.
    /// The deploy check in docs/lights-contract.md catches it before anyone bets: the start round and the round
    /// before it must both be quiet, which `isIdle` answers. Started at 99 (98-99 quiet) the night counts all 10.
    function test_T5_walkerStartedDuringARideCountsTheWrongBulbs() public {
        _active(100, 110); // the real ride: bulbs 1-10 in 101-110, lights out 111-112
        _at(105);
        assertFalse(lights.isIdle(104) && lights.isIdle(103), "104 is inside a ride: the deploy check fails");
        assertTrue(lights.isIdle(99) && lights.isIdle(98), "98-99 are quiet: 99 passes the deploy check");

        LightsOn wrong = new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(sqk), genesisTime: G, station: 36, startRound: 104})
        );
        lights = new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(sqk), genesisTime: G, station: 36, startRound: 99})
        );
        _fund(bettors[0], 0);
        _fund(bettors[1], 0);
        uint256 a = _bet(bettors[0], 8, 100e18);
        _bet(bettors[1], 12, 100e18);
        _at(120);
        _settleAll();
        wrong.poke(10);
        emit log_named_uint("bulbs counted when started at 104", wrong.lit(0));
        assertEq(wrong.lit(0), 5, "started mid-ride: wrong");
        assertEq(lights.lit(0), 10, "started after a blackout: right");
        assertEq(_cls(a), WIN);
    }

    // ------------------------------------------------------------ T6: the catch-up before AlreadyBet is short

    /// Was: after a day and a half of running that nobody read, Bob's next bet (for a later night) was refused
    /// with AlreadyBet, because bet() catches up only 1 + 4 pages.
    /// Now: it is refused with PokeFirst (the walker is behind the core, so it can't tell yet), and after poke(100)
    /// the same bet works. The page calls poke first when it sees PokeFirst.
    function test_T6_returningBettorRefusedAfterALongBusySpell() public {
        _active(100, 299);
        core.setActive(302, 500); // a short ride after: leaves 302, bulbs in 303-304, lights out 305-306
        core.setActive(303, 500);
        core.setActive(304, 500);
        _at(300);
        _bet(bettors[0], 2, 50e18);
        _at(330);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.PokeFirst.selector);
        lights.bet(3, 50e18);
        lights.poke(100);
        assertEq(lights.getWalker().cursor, 329);
        vm.prank(bettors[0]);
        lights.bet(3, 50e18);

        // once the walker is caught up, a bet in the same night is still AlreadyBet
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(4, 50e18);
    }
}
