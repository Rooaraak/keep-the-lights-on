// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "../LightsBase.t.sol";
import {LightsOn} from "../../src/LightsOn.sol";
import {MockCore} from "../mocks/Mocks.sol";

/// Money audit (11-01), issues F1-F3. These tests FAILED on the audited LightsOn.sol; after the fixes they are
/// regression tests and pass. Each keeps the auditor's story and checks the rules (docs/lights-on-spec.md) now hold.
///   forge test --offline --match-path 'test/audit_money/*' --match-contract MoneyFindingsTest -vv
contract MoneyFindingsTest is LightsBase {
    uint256 internal constant WEEK_OF_ROUNDS = 7 * 144;

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    /// The core stops settling (it pauses) and stays paused until 145 rounds have ended since its last settled
    /// round: a stall under the spec.
    function _pauseForAStall() internal {
        core.setPaused(true);
        uint256 r = uint256(core.settled()) + 146;
        vm.warp(G + (r - 1) * 600 + 100);
        assertTrue(lights.stalled(), "paused for 145 rounds");
    }

    /// The core unpauses and settles every round that has ended.
    function _recover() internal {
        core.setPaused(false);
        core.setSettled(uint64(lights.currentRound() - 1));
    }

    // ------------------------------------------------------------ F1: an old stall flag never expired

    /// Was: day 0 a moment's pause was flagged; a week later a one-block pause let Bob void at once, because the
    /// week-old flag counted as the 24 h wait. Alice got 100 back instead of the 1,080 she won.
    /// Now: a moment's pause is not a stall (it must last 144 rounds), and an old flag from a real stall that
    /// ended is cleared by void() instead of ending the game.
    function test_F1_oldStallFlagLetsAOneBlockPauseEndTheGame() public {
        _at(97);
        core.setPaused(true);
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall(); // a moment's pause can't be flagged at all
        _pauseForAStall(); // a real stall this time: 145 rounds without settling
        lights.flagStall();
        _recover(); // the core is fine again; nobody calls void()
        assertFalse(lights.stalled(), "the core is fine again");
        assertGt(lights.stallFlaggedAt(), 0, "the flag is still up");

        uint256 r = lights.currentRound() + WEEK_OF_ROUNDS;
        _at(r);
        uint256 alice = _bet(bettors[0], 2, 100e18);
        uint256 bob = _bet(bettors[1], 20, 1000e18);
        _active(r + 3, r + 13); // he starts in r + 3 and lights bulbs 1-10
        _at(r + 14);
        lights.poke(10);
        (, uint256 litSoFar,) = lights.openNight();
        assertEq(litSoFar, 10, "Alice's bulb 2 lit eight rounds ago");

        // Bob's try: the core pauses for one block and he calls void() on the week-old flag
        core.setPaused(true);
        vm.prank(bettors[1]);
        lights.void();
        assertFalse(lights.voided(), "a one-block pause does not end the game");
        assertEq(lights.stallFlaggedAt(), 0, "the old flag is cleared instead");
        vm.prank(bettors[1]);
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();
        core.setPaused(false);

        _at(r + 17); // he stops: r + 14 and r + 15 are quiet
        _settleAll();
        uint256 got = _claim(alice);
        emit log_named_decimal_uint("Alice collects", got, 18);
        assertEq(got, 1080e18, "pot 1,100, burn 20, Alice is the only lit bulb");
        assertEq(_claim(bob), 0, "Bob's bulb 20 stayed dark");
    }

    /// The flag also goes stale if the core settles anything after it, even if it then stops again: a flag only
    /// counts for the stall it was raised for. The second stall needs its own flag and its own 24 h.
    function test_F1b_aFlagFromAnEarlierStallDoesNotCountForALaterOne() public {
        _at(97);
        _bet(bettors[0], 2, 100e18);
        _pauseForAStall();
        lights.flagStall();
        uint256 flaggedAt = block.timestamp;
        uint256 mark = lights.stallMark();
        assertEq(mark, 96, "the last round the core had settled");

        vm.warp(flaggedAt + 1 hours);
        _recover(); // settles everything that ended, then stops again at once
        core.setPaused(true);
        uint256 settledAgain = core.settled();
        assertGt(settledAgain, mark);

        // 25 h after the flag the core is 144+ rounds behind again, but only 24 h of the new stall have passed
        vm.warp(G + (settledAgain + 145) * 600 + 100);
        assertTrue(lights.stalled());
        assertGe(block.timestamp, flaggedAt + 1 days);
        lights.void();
        assertFalse(lights.voided(), "the flag was for the earlier stall");
        assertEq(lights.stallFlaggedAt(), 0);

        lights.flagStall(); // a fresh flag for this stall
        assertEq(lights.stallMark(), settledAgain);
        vm.warp(block.timestamp + 1 days);
        lights.poke(10);
        lights.void();
        assertTrue(lights.voided(), "24 h after its own flag, still stalled: the game ends");
    }

    /// A flag raised while the core was behind does not count for a moment when the core can't be read. Here the
    /// core recovers and records a whole night, nobody bets, collects or pokes for a week (so the walker is a week
    /// behind), and then the core can't be read for one block. Without the "same kind of stall" rule the old flag
    /// plus the week-old walker would have let a loser end the game and refund the night Alice won.
    function test_F1c_aFlagFromALagStallDoesNotCountForAMomentTheCoreCantBeRead() public {
        _at(97);
        uint256 alice = _bet(bettors[0], 2, 100e18);
        uint256 bob = _bet(bettors[1], 20, 1000e18);
        _active(100, 110); // he runs while the core is paused; it records the rounds when it comes back
        _pauseForAStall();
        lights.flagStall();
        assertFalse(lights.stallUnreadable(), "flagged because the core was behind");
        _recover();

        _at(lights.currentRound() + WEEK_OF_ROUNDS);
        assertEq(lights.getWalker().cursor, 96, "nobody touched the game for a week");
        core.setReverting(true); // one block in which the core can't be read
        assertTrue(lights.stalled(), "the walker is a week behind and the core can't be read");
        vm.prank(bettors[1]);
        lights.void();
        assertFalse(lights.voided(), "a flag for a lag stall does not count for an unreadable moment");
        assertEq(lights.stallFlaggedAt(), 0, "the flag is cleared");
        core.setReverting(false);

        _settleAll();
        assertEq(_claim(alice), 1080e18, "Alice's night pays as it ended");
        assertEq(_claim(bob), 0);
    }

    // ------------------------------------------------------------ F2: a core reply that cannot be read

    function _stateInSevenWords() internal {
        vm.mockCall(
            address(core),
            abi.encodeWithSelector(MockCore.state.selector),
            abi.encode(uint64(109), uint64(0), uint96(0), uint64(0), uint96(0), uint32(0), false)
        );
    }

    /// Was: an upgrade makes state() answer with 7 words instead of 8; `try` didn't catch the decode failure, so
    /// claim() (which walks the core first) reverted and a settled win could never be collected.
    /// Now: the core is read through a call LightsOn makes to itself, so the bad reply fails inside it and is caught.
    function test_F2a_coreReplyThatCannotBeReadBlocksCollecting() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        (uint256 owed, bool ready) = _due(a);
        assertTrue(ready, "the night is settled");
        assertEq(owed, 198e18, "Alice is owed 198");

        _stateInSevenWords();
        uint256 before = sqk.balanceOf(bettors[0]);
        assertEq(lights.claim(_ids(a)), 1, "collect works");
        assertEq(sqk.balanceOf(bettors[0]) - before, 198e18);
        vm.prank(bettors[2]);
        lights.bet(5, 50e18); // so does a new bet (it waits; the walker can't move)
    }

    /// Was: the way out (flagStall, then void 24 h later) reverted too, so 600 SQK was locked for good.
    /// Now: flagStall answers NotStalled while the bad replies are new, works once they have lasted 144 rounds, and
    /// void 24 h later returns the open night's 500 and the 100 bonus pot to their bets.
    function test_F2b_coreReplyThatCannotBeReadAlsoBlocksTheVoidExit() public {
        _at(97);
        uint256 l = _bet(bettors[0], 9, 100e18);
        _active(100, 102); // nobody wins: 100 rolls into the bonus pot
        _at(110);
        _settleAll();
        uint256 o = _bet(bettors[1], 3, 500e18); // the open night
        assertEq(lights.bonusPot(), 100e18);

        _stateInSevenWords();
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();
        vm.warp(G + (109 + 145) * 600 + 100); // 145 rounds after the last round the walker read (109)
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        lights.void();
        assertTrue(lights.voided());
        assertEq(_claim(o), 500e18);
        assertEq(_claim(l), 100e18, "the bonus pot goes back to the bet it came from");
        assertEq(sqk.balanceOf(address(lights)), 0, "nothing locked");
    }

    /// Was: a proxy pointed at an address with no code (or a core with no code) made claim revert.
    function test_F2c_coreWithNoCodeBlocksCollecting() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        vm.etch(address(core), bytes(""));
        uint256 before = sqk.balanceOf(bettors[0]);
        assertEq(lights.claim(_ids(a)), 1, "collect works with no code at the core");
        assertEq(sqk.balanceOf(bettors[0]) - before, 198e18);
        assertFalse(lights.stalled(), "not a stall until it lasts 144 rounds");
        vm.warp(G + (109 + 145) * 600 + 100);
        assertTrue(lights.stalled(), "no code for 145 rounds: a stall");
    }

    // ------------------------------------------------------------ F3: void did not read the ended night first

    /// Was: the core had recorded the blackout of Alice's night, nobody had read it, the core paused, and void()
    /// refunded the night: Alice got 100 back instead of 198, and the loser his 100.
    /// Now: void() refuses (SettleFirst) while the core can still serve rounds the walker has not read. Once they
    /// are read and the night is settled, it pays as it ended.
    function test_F3_voidRefundsANightTheCoreAlreadyShowsEnded() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        uint256 b = _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(111); // the core has recorded every round through 110; nothing has walked them
        _pauseForAStall(); // it stops settling (it still answers) for 145 rounds
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);

        vm.prank(bettors[1]);
        vm.expectRevert(LightsOn.SettleFirst.selector);
        lights.void();
        lights.poke(10); // reads 97-110: the night closed with bulbs 1-4 lit
        vm.expectRevert(LightsOn.SettleFirst.selector);
        lights.void();
        lights.settle(100);
        lights.void();
        assertTrue(lights.voided());
        uint256 got = _claim(a);
        emit log_named_decimal_uint("Alice collects", got, 18);
        assertEq(got, 198e18, "the ended night pays as it ended");
        assertEq(_claim(b), 0, "the loser lost");
    }
}
