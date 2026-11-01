// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "../LightsBase.t.sol";
import {LightsOn} from "../../src/LightsOn.sol";
import {MockCore} from "../mocks/Mocks.sol";
import {RoundPage} from "../../src/ISqueek.sol";

/// A healthy core whose roundPage is expensive: it burns a fixed amount of gas, then answers like MockCore.
/// Used only to show how stalled() reads an out-of-gas page (A4). The real core's page is cheap today.
contract SlowCore {
    MockCore public immutable inner;
    uint256 public spin;

    constructor() {
        inner = new MockCore();
    }

    function setSpin(uint256 s) external {
        spin = s;
    }

    function state() external view returns (uint64, uint64, uint96, uint64, uint96, uint32, uint256, bool) {
        return inner.state();
    }

    function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords)
        external
        view
        returns (RoundPage memory)
    {
        uint256 n = spin;
        bytes32 h;
        assembly {
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                mstore(0, h)
                mstore(32, i)
                h := keccak256(0, 64)
            }
        }
        require(h != bytes32(uint256(1)), "never");
        return inner.roundPage(afterRound, throughRound, maxRecords);
    }
}

/// Attack and stuck-state audit (11-01), issues A1-A4. These tests FAILED on the audited LightsOn.sol. A1 and A4 are
/// fixed and their tests are regression tests. A2 and A3 are not contract changes (see docs/lights-contract.md,
/// audit findings): their tests now check the behaviour the page relies on instead. All pass. Run:
///   forge test --offline --match-path 'test/audit_attacks/*' --match-contract AttackFindingsTest -vv
contract AttackFindingsTest is LightsBase {
    uint8 internal constant REFUND = 0;
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;
    uint256 internal constant DAY_OF_ROUNDS = 144;

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
    }

    // ------------------------------------------------------------ A1: no exit if he never runs again

    /// Was: night 0 is a false start (Alice's 100 rolls into the bonus pot), Bob (50) and Carol (70) bet for the next
    /// night, and he never runs again while the core keeps recording quiet rounds. The core is healthy, so there
    /// was no stall, no void and no cancel: 220 SQK could never leave.
    /// Now (a new rule): once the walker has read 7 days (1,008 rounds) with no running round,
    /// anyone can call void() at once (no flag needed: the walker read every one of those rounds). Waiting bets and
    /// the bonus pot go back. If he runs before that, nothing changes.
    function test_A1_ifHeNeverRunsAgainTheBetsAndBonusPotCanNeverLeave() public {
        _at(97);
        uint256 alice = _bet(bettors[0], 3, 100e18);
        _active(100, 100); // a false start: he leaves in 100 and is asleep from 101
        _at(104);
        _settleAll();
        assertEq(lights.lit(0), 0, "false start");
        assertEq(lights.bonusPot(), 100e18, "Alice's 100 rides in the bonus pot");
        uint256 bob = _bet(bettors[1], 2, 50e18);
        uint256 carol = _bet(bettors[2], 5, 70e18);

        // 1,008 quiet rounds after his last running round (100): not yet more than 7 days
        _at(100 + 1008 + 1);
        lights.poke(1000);
        assertFalse(lights.asleepTooLong());
        vm.expectRevert(LightsOn.TooEarly.selector);
        lights.void();
        assertFalse(lights.stalled(), "the core is healthy");

        // one more quiet round: 7 days without running
        _at(100 + 1008 + 2);
        assertFalse(lights.asleepTooLong(), "the walker must read the rounds first");
        lights.poke(1000);
        assertTrue(lights.asleepTooLong());
        lights.void();
        assertTrue(lights.voided());
        uint256 done = lights.claim(_ids3(alice, bob, carol));
        assertEq(done, 3);
        emit log_named_decimal_uint("SQK still inside the game", sqk.balanceOf(address(lights)), 18);
        assertEq(sqk.balanceOf(address(lights)), 0, "220 SQK back to its bets");
        assertEq(sqk.balanceOf(bettors[0]), 1_000_000e18, "Alice's rolled 100 came back");
    }

    /// If he runs again within the 7 days, the game goes on: the week is counted from his last running round.
    function test_A1b_aLongSleepThatEndsInTimeChangesNothing() public {
        _at(97);
        _bet(bettors[0], 3, 100e18);
        _active(100, 100);
        _at(104);
        _settleAll();
        core.setActive(1000, 500); // he wakes up after about 6 days
        _at(1109);
        lights.poke(1000);
        assertFalse(lights.asleepTooLong(), "he ran in round 1000");
        vm.expectRevert(LightsOn.TooEarly.selector);
        lights.void();
        _at(1000 + 1008 + 2);
        lights.poke(1000);
        assertTrue(lights.asleepTooLong(), "7 days after round 1000");
    }

    // ------------------------------------------------------------ A2: paid-back bets on a bulb that already lit

    /// Not changed in the contract, on purpose. He leaves in 100 and lights bulbs 1-10; in round 106 the game knows
    /// bulbs 1-5 are lit and still takes bets on bulb 1. Each is paid back in full by the two-rounds rule, so nobody
    /// loses anything; they only add counting work (about 11,000 gas each) that anyone can do with settle().
    /// Refusing them would be wrong: whether round 106 is the night's first quiet round (C) is only known after
    /// it, and a bet sent in C belongs to the NEXT night, where bulb 1 is a fair pick that can win (shown below).
    function test_A2_paidBackBetsOnAnAlreadyLitBulbPileUpBeforeAnyoneCanCollect() public {
        _at(97);
        uint256 alice = _bet(bettors[0], 3, 100e18);
        _bet(bettors[1], 20, 100e18);
        _active(100, 110);
        _at(106);
        lights.poke(10);
        (, uint256 litSoFar,) = lights.openNight();
        assertEq(litSoFar, 5, "the game already knows bulbs 1-5 are lit");

        uint256 accepted;
        uint256 firstLitBet = lights.betCount();
        for (uint256 i; i < 40; ++i) {
            address s = address(uint160(0xBAD000 + i));
            _fund(s, 10e18);
            vm.prank(s);
            try lights.bet(1, 10e18) {
                ++accepted;
            } catch {}
        }
        assertEq(accepted, 40, "accepted, and each is only ever paid back");

        _at(114); // the blackout (111-112) is recorded
        uint256 g = gasleft();
        lights.claim(_ids(alice));
        g -= gasleft();
        emit log_named_uint("Alice's first collect after the blackout, gas", g);
        assertLt(g, 1_000_000, "a nuisance, not a halt");
        _settleAll();
        assertEq(_claim(alice), 198e18, "Alice's result did not move: the refunded bets are not in the pot");
        for (uint256 i; i < accepted; ++i) {
            assertEq(_cls(firstLitBet + i), REFUND);
            assertEq(_claim(firstLitBet + i), 10e18, "each of these bets is paid back in full");
        }

        // why the contract can't refuse them: the same kind of bet, sent in what turns out to be round C, is in the
        // next night and wins there
        core.setActive(116, 500); // night 1 leaves in 116, bulbs 1-2 in 117-118, lights out 119-120
        core.setActive(117, 500);
        core.setActive(118, 500);
        _at(119);
        lights.poke(10);
        (, litSoFar,) = lights.openNight();
        assertEq(litSoFar, 2);
        vm.prank(bettors[6]);
        uint256 inC = lights.bet(1, 100e18); // bulb 1 is lit in night 1, but 119 turns out to be its C
        _bet(bettors[7], 20, 100e18); // a loser, in the same night as inC
        core.setActive(124, 500); // night 2 leaves in 124, bulb 1 lights in 125
        core.setActive(125, 500);
        _at(130);
        _settleAll();
        assertEq(lights.getBet(inC).night, 2, "a bet sent in C is in the next night");
        assertEq(_cls(inC), WIN, "a bulb-1 bet sent in C wins in the next night");
        assertEq(_claim(inC), 198e18);
    }

    // ------------------------------------------------------------ A3: out of gas when a round is recorded mid-way

    /// Not a contract change. A bet also moves the walker and the settler, so its gas depends on what the core
    /// recorded between the wallet's estimate and the block: here the blackout lands 32 s after the estimate and
    /// the same bet needs more than double. The page therefore sends every bet with a fixed gas limit of at least
    /// BET_GAS_LIMIT (the sender pays only for the gas used). This checks the worst case found stays below it.
    uint256 internal constant BET_GAS_LIMIT = 1_500_000;

    function test_A3_aBetCanRunOutOfGasWhenTheBlackoutIsRecordedOnTheWay() public {
        _at(97);
        for (uint256 i; i < 6; ++i) {
            _bet(bettors[i], uint8(2 + i), 100e18);
        }
        _active(100, 104);
        _at(106);
        lights.poke(10); // read through 105: one quiet round so far

        vm.warp(G + 106 * 600 + 20);
        core.setSettled(105);
        uint256 snap = vm.snapshotState();
        vm.prank(bettors[20]);
        uint256 g0 = gasleft();
        lights.bet(5, 100e18);
        uint256 estimate = g0 - gasleft();
        vm.revertToState(snap);

        vm.warp(G + 106 * 600 + 52);
        core.setSettled(106);
        snap = vm.snapshotState();
        vm.prank(bettors[20]);
        g0 = gasleft();
        lights.bet(5, 100e18);
        uint256 needed = g0 - gasleft();
        vm.revertToState(snap);

        uint256 limit = (estimate + 21_000) * 3 / 2 - 21_000; // a wallet's 50% margin on the whole transaction
        vm.prank(bettors[20]);
        (bool ok,) = address(lights).call{gas: limit}(abi.encodeCall(LightsOn.bet, (5, 100e18)));
        emit log_named_uint("gas the wallet estimated (round 106 not recorded yet)", estimate);
        emit log_named_uint("gas the same bet needs 32 s later", needed);
        emit log_named_uint("gas limit with a 50% margin", limit);
        assertFalse(ok, "an estimate with a 50% margin is not enough: the page must not rely on it");
        assertLt(needed + 21_000, BET_GAS_LIMIT);
        vm.prank(bettors[20]);
        (ok,) = address(lights).call{gas: BET_GAS_LIMIT - 21_000}(abi.encodeCall(LightsOn.bet, (5, 100e18)));
        assertTrue(ok, "with the page's fixed limit the bet goes through");
    }

    // ------------------------------------------------------------ A4: an out-of-gas page read counted as a stall

    /// Was: stalled() treated a failed roundPage call as a broken core, and an out-of-gas call is a failed call, so
    /// on a core whose page costs more than about 1.6M gas anyone could flag (and void) a healthy game by picking
    /// the gas limit. Now every read of the core gets exactly CORE_GAS (1,000,000), and flagStall/void refuse to
    /// run (NeedMoreGas) without STALL_GAS, so a failed read is the core's own failure. A core whose page costs
    /// more than CORE_GAS can't be read by the walker either: for everyone it is a stall after 144 rounds.
    function test_A4_info_anOutOfGasPageReadCountsAsAStall() public {
        SlowCore slow = new SlowCore();
        slow.setSpin(5_000);
        lights = new LightsOn(
            LightsOn.Config({core: address(slow), sqk: address(sqk), genesisTime: G, station: 36, startRound: 0})
        );
        MockCore inner = slow.inner();

        vm.warp(G + 96 * 600 + 100);
        inner.setSettled(95);
        assertEq(lights.poke(10), 1, "an honest poke reads through 95");
        inner.setSettled(96); // the core records 96; nobody has read it yet
        uint256 pageGas = gasleft();
        slow.roundPage(95, 96, 16);
        pageGas -= gasleft();
        emit log_named_uint("gas of one page read on this core", pageGas);
        assertGt(pageGas, 400_000, "an expensive page");
        assertLt(pageGas, 900_000, "but under CORE_GAS");
        assertFalse(lights.stalled(), "with enough gas the core reads fine");

        for (uint256 g = 30_000; g <= 4_000_000; g += 25_000) {
            (bool ok,) = address(lights).call{gas: g}(abi.encodeCall(LightsOn.flagStall, ()));
            assertFalse(ok, "no gas limit flags a healthy core");
        }
        assertEq(lights.stallFlaggedAt(), 0);

        // a page dearer than CORE_GAS: the walker can't read it either, so it is a stall for everyone after 144 rounds
        slow.setSpin(40_000);
        vm.warp(G + 120 * 600 + 100);
        inner.setSettled(119);
        assertEq(lights.poke(10), 0, "the walker can't read it");
        assertFalse(lights.stalled());
        vm.warp(G + (96 + 145) * 600 + 100);
        assertTrue(lights.stalled(), "unreadable for 145 rounds");
    }
}
