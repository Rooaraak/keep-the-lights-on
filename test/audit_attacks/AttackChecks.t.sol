// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {LightsBase} from "../LightsBase.t.sol";
import {LightsOn} from "../../src/LightsOn.sol";

/// An ERC-20 like MockSQK that calls back into a chosen contract on every transfer, transferFrom and burn, the
/// way a token with hooks would. The real SQK has no hooks (a plain 4,023-byte contract, no proxy slot); this
/// checks the game would hold even if it did.
contract HookSQK {
    uint256 public totalSupply;
    uint256 public totalBurned;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public hookTarget;
    bytes public hookData;
    bool internal _inHook;
    bool[] public hookOk;
    bytes4[] public hookErr;

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function hookCount() external view returns (uint256) {
        return hookOk.length;
    }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        _hook();
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        require(allowance[from][msg.sender] >= v, "allowance");
        allowance[from][msg.sender] -= v;
        _move(from, to, v);
        _hook();
        return true;
    }

    function burn(uint256 v) external {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        totalSupply -= v;
        totalBurned += v;
        _hook();
    }

    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v;
        balanceOf[to] += v;
    }

    function _hook() internal {
        if (hookData.length == 0 || _inHook) return;
        _inHook = true;
        (bool ok, bytes memory ret) = hookTarget.call(hookData);
        _inHook = false;
        bytes4 sel;
        if (ret.length >= 4) {
            assembly {
                sel := mload(add(ret, 32))
            }
        }
        hookOk.push(ok);
        hookErr.push(sel);
    }
}

/// Attack and stuck-state audit, checks that HOLD on the current LightsOn.sol (every test here passes): attacks
/// that were tried and failed. Run:
///   forge test --offline --match-path 'test/audit_attacks/*' --match-contract AttackChecksTest -vv
contract AttackChecksTest is LightsBase {
    uint8 internal constant REFUND = 0;
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    // ------------------------------------------------------------ reentry through token hooks

    /// A token that calls back in the middle of a bet, a collect and a burn: a second bet, collect or settle from
    /// inside is refused (Reentrant); a poke from inside the burn is allowed, closes the next night early, and
    /// still changes no number. Both nights match the pure rule and the game ends empty.
    function test_reentryThroughTokenHooksIsRefusedOrChangesNothing() public {
        HookSQK hk = new HookSQK();
        lights = new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(hk), genesisTime: G, station: 36, startRound: 0})
        );
        for (uint256 i; i < 6; ++i) {
            hk.mint(bettors[i], 1_000_000e18);
            vm.prank(bettors[i]);
            hk.approve(address(lights), type(uint256).max);
        }

        _at(97);
        hk.setHook(address(lights), abi.encodeCall(LightsOn.bet, (5, 10e18)));
        uint256 alice = _bet(bettors[0], 2, 100e18);
        hk.setHook(address(lights), abi.encodeCall(LightsOn.settle, (100)));
        _bet(bettors[1], 9, 100e18);
        hk.setHook(address(lights), abi.encodeCall(LightsOn.claim, (_ids(0))));
        _bet(bettors[2], 12, 100e18);
        for (uint256 i; i < 3; ++i) {
            assertFalse(hk.hookOk(i), "a bet, settle or collect from inside a bet is refused");
            assertEq(hk.hookErr(i), LightsOn.Reentrant.selector);
        }
        hk.setHook(address(0), "");

        _active(100, 104); // night 0: bulbs 1-4, lights out 105-106
        _active(110, 130); // night 1: bulbs 1-20, lights out 131-132
        _at(106); // bets in the second quiet round join the next night
        _bet(bettors[3], 3, 100e18);
        _bet(bettors[4], 24, 100e18);
        _at(134);
        lights.poke(1); // one page: night 0 closes, night 1 is still open as far as the walker knows
        assertEq(lights.nightCount(), 1);

        hk.setHook(address(lights), abi.encodeCall(LightsOn.poke, (10)));
        lights.settle(1000); // night 0 burns; the hook's poke closes night 1 in the middle of it
        assertTrue(hk.hookOk(3), "a poke from inside the burn is allowed");
        assertEq(lights.nightCount(), 2, "and it closed night 1");
        assertEq(lights.nextSettle(), 1, "night 1 waits for the next settle");
        lights.settle(1000);

        hk.setHook(address(lights), abi.encodeCall(LightsOn.claim, (_ids(alice))));
        lights.claim(_ids(alice));
        assertFalse(hk.hookOk(hk.hookCount() - 1), "a collect from inside a collect is refused");
        assertEq(hk.hookErr(hk.hookCount() - 1), LightsOn.Reentrant.selector);
        hk.setHook(address(0), "");

        _checkAllNights();
        for (uint256 id; id < lights.betCount(); ++id) {
            lights.claim(_ids(id));
        }
        assertEq(hk.balanceOf(address(lights)), 0, "every wei left the game");
        assertEq(hk.totalBurned(), lights.getNight(0).burned + lights.getNight(1).burned);
    }

    // ------------------------------------------------------------ gas-limit tricks

    /// The burn is a try/catch with a fallback, a pattern an attacker can sometimes game by sending just enough
    /// gas for the burn to fail and the rest to finish (then the burn goes to dEaD or is skipped). Every gas limit
    /// from 20,000 to 200,000 was tried on the call that settles a night: it either reverts and changes nothing,
    /// or burns the full 2% through SQK.burn. It never lands in the fallback.
    function test_theBurnCannotBeDodgedByPickingTheGas() public {
        _at(97);
        _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 300e18);
        _active(100, 104);
        _at(110);
        lights.poke(10);
        lights.settle(2); // both bets counted, the night not settled yet
        assertEq(lights.getNight(0).result, 0);

        uint256 worked;
        for (uint256 g = 20_000; g <= 200_000; g += 250) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(lights).call{gas: g}(abi.encodeCall(LightsOn.settle, (1)));
            assertEq(lights.unburned(), 0, "never left unburned");
            assertEq(sqk.balanceOf(DEAD), 0, "never sent to dEaD instead");
            if (ok) {
                ++worked;
                assertEq(lights.getNight(0).burned, 6e18, "2% of the 300 lost");
                assertEq(sqk.totalBurned(), 6e18, "burned for real");
            } else {
                assertEq(lights.getNight(0).result, 0, "a failed call changes nothing");
            }
            vm.revertToState(snap);
        }
        assertGt(worked, 0);
    }

    /// The same trick on flagStall: make the page read inside stalled() run out of gas so it looks like a broken
    /// core. With a page that costs what MockCore's costs, no gas limit from 5,000 to 600,000 flags a healthy core.
    /// It needs a page read above ~63 x 26,000 = 1.6M gas (AttackFindings A4); the real core's costs ~124,000.
    function test_flagStallCannotBeForcedByPickingTheGas() public {
        _active(100, 110);
        _at(112);
        lights.poke(10);
        vm.warp(G + 112 * 600 + 100);
        core.setSettled(112); // a round the walker has not read, so stalled() reads a page
        assertFalse(lights.stalled());
        for (uint256 g = 5_000; g <= 600_000; g += 250) {
            (bool ok,) = address(lights).call{gas: g}(abi.encodeCall(LightsOn.flagStall, ()));
            assertFalse(ok && lights.stallFlaggedAt() != 0, "a healthy core was flagged by picking the gas");
        }
        assertEq(lights.stallFlaggedAt(), 0);
    }

    // ------------------------------------------------------------ odd arguments

    /// Zero, huge, empty, out-of-range and repeated arguments to poke, settle and collect do nothing harmful:
    /// nothing reverts, nobody is paid twice, and the night pays exactly what it should.
    function test_oddArgumentsChangeNothing() public {
        lights.poke(type(uint256).max);
        lights.settle(type(uint256).max);
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        uint256 b = _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        assertEq(lights.settle(0), 0);
        assertEq(lights.poke(0), 0);
        assertEq(lights.claim(new uint256[](0)), 0);
        uint256[] memory junk = new uint256[](5);
        (junk[0], junk[1], junk[2], junk[3], junk[4]) = (type(uint256).max, 999, a, a, b);
        uint256 before = sqk.balanceOf(bettors[0]);
        assertEq(lights.claim(junk), 2, "a and b once each; the rest skipped");
        assertEq(sqk.balanceOf(bettors[0]) - before, 198e18, "paid once");
        lights.poke(type(uint256).max);
        lights.settle(type(uint256).max);
        assertEq(lights.claim(junk), 0);
        _checkAllNights();
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    // ------------------------------------------------------------ allowance and other people's bets

    /// Alice allows the game unlimited SQK. Nobody else can use that: the game only takes from the sender, and
    /// only the amount of the sender's own bet. Mallory can collect for Alice (front-running her collect), but the
    /// money goes to Alice, and Alice's own collect afterwards just does nothing.
    function test_nobodyCanSpendSomeoneElsesAllowanceOrTakeTheirWin() public {
        address alice = bettors[0];
        address mallory = bettors[5];
        _at(97);
        uint256 a0 = sqk.balanceOf(alice);
        uint256 m0 = sqk.balanceOf(mallory);
        uint256 a = _bet(alice, 2, 100e18);
        assertEq(a0 - sqk.balanceOf(alice), 100e18, "the bet took exactly its amount");
        _bet(mallory, 9, 250e18);
        assertEq(sqk.balanceOf(alice), a0 - 100e18, "Mallory's bet took nothing from Alice");
        assertEq(m0 - sqk.balanceOf(mallory), 250e18);
        _active(100, 104);
        _at(110);

        vm.prank(mallory);
        assertEq(lights.claim(_ids(a)), 1);
        assertEq(sqk.balanceOf(alice), a0 - 100e18 + 345e18, "Alice's win went to Alice");
        assertEq(sqk.balanceOf(mallory), m0 - 250e18, "Mallory got nothing");
        vm.prank(alice);
        assertEq(lights.claim(_ids(a)), 0, "Alice's own collect does nothing and does not fail");
    }

    // ------------------------------------------------------------ big nights and long gaps

    /// 600 bets from 600 addresses in one night (the most a page-less spam could add in a night costs the
    /// sender 600 x 10 SQK). Counting is paged, so each step fits easily in a block: settle(400) twice, then a
    /// collect of 200 bets. Every bet matches the pure rule.
    function test_aBigNightSettlesInStepsThatFitInABlock() public {
        _at(97);
        uint256 first = lights.betCount();
        for (uint256 i; i < 600; ++i) {
            address s = address(uint160(0xB16000 + i));
            _fund(s, 10e18);
            vm.prank(s);
            lights.bet(uint8(i % 24 + 1), 10e18);
        }
        _active(100, 112);
        _at(116);
        lights.poke(10);
        uint256 g = gasleft();
        lights.settle(400);
        uint256 g1 = g - gasleft();
        g = gasleft();
        lights.settle(400);
        uint256 g2 = g - gasleft();
        uint256[] memory ids = new uint256[](200);
        for (uint256 i; i < 200; ++i) {
            ids[i] = first + i;
        }
        g = gasleft();
        assertEq(lights.claim(ids), 200);
        uint256 g3 = g - gasleft();
        emit log_named_uint("settle(400), gas", g1);
        emit log_named_uint("settle(400) that finishes the night, gas", g2);
        emit log_named_uint("collect 200 bets, gas", g3);
        assertLt(g1, 15_000_000);
        assertLt(g2, 15_000_000);
        assertLt(g3, 15_000_000);
        _checkAllNights();
    }

    /// Night 0 (10 bets) closes and is only partly counted; then he runs for 141 rounds in a row (four STATION
    /// nights, 9 pages of records) while nobody plays. Dave, whose first bet waits in night 1, comes back: his
    /// bet reads 1 page, counts 4 bets, then reads 4 more pages to see that night 1 ended (5 full pages + 4
    /// units, the most one bet ever does). It stays far under a block, and so does the next collect (2 pages and
    /// 32 units, which finish night 0 and settle the next ones).
    function test_theMostWorkOneBetOrCollectCanBeMadeToDo() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        for (uint256 i = 1; i < 10; ++i) {
            _bet(bettors[i], uint8(10 + i), 100e18);
        }
        _active(100, 104);
        _at(108);
        _bet(bettors[20], 2, 100e18); // closes night 0 and counts 4 of its 10 bets; Dave's bet is in night 1
        _active(110, 250);
        _at(260);
        vm.prank(bettors[20]);
        uint256 g = gasleft();
        lights.bet(3, 100e18);
        uint256 gBet = g - gasleft();
        assertEq(lights.getWalker().cursor, 189, "5 pages of 16 records read");
        g = gasleft();
        lights.claim(_ids(a));
        uint256 gClaim = g - gasleft();
        emit log_named_uint("returning bet that reads 5 pages, gas", gBet);
        emit log_named_uint("collect that reads 2 pages and counts 32 units, gas", gClaim);
        assertLt(gBet, 2_000_000);
        assertLt(gClaim, 3_000_000);
    }

    // ------------------------------------------------------------ a whale

    /// He leaves in 100 and lights bulbs 1-8. In round 105 a whale sends 10,000 SQK from six addresses on bulbs
    /// 1-6 (four already lit, two lighting in 105 and 106). The two-rounds rule pays every one of them back in
    /// full, and Alice's and Bob's results do not move by one wei. Money alone can't change how many bulbs light
    /// or buy a bulb that is about to light.
    function test_aWhaleCannotBuyALitBulbOrMoveTheNight() public {
        _at(97);
        uint256 alice = _bet(bettors[0], 3, 100e18);
        uint256 bob = _bet(bettors[1], 15, 100e18);
        _active(100, 108);
        _at(105);
        lights.poke(10);

        uint256 snap = vm.snapshotState();
        _at(112);
        _settleAll();
        uint256 aliceHonest = _claim(alice);
        uint256 bobHonest = _claim(bob);
        vm.revertToState(snap);
        _at(105);

        uint256 firstWhale = lights.betCount();
        for (uint256 i; i < 6; ++i) {
            _bet(bettors[10 + i], uint8(1 + i), 10_000e18);
        }
        _at(112);
        _settleAll();
        assertEq(lights.lit(0), 8);
        assertEq(_claim(alice), aliceHonest, "Alice's result did not move");
        assertEq(_claim(bob), bobHonest, "Bob's result did not move");
        for (uint256 i; i < 6; ++i) {
            assertEq(_cls(firstWhale + i), REFUND);
            assertEq(_claim(firstWhale + i), 10_000e18, "the whale only gets its stake back");
        }
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    // ------------------------------------------------------------ events the page reads

    /// The page rebuilds the game from logs. Over a false start (Alice's 100 rolls into the bonus pot) and a
    /// paid night with a winner, a loser and a late bet paid back, the logs alone add up to the wei: every SQK
    /// that came in through BetPlaced left through Claimed or Burned, and NightClosed / NightSettled say exactly
    /// what getNight says.
    function test_theLogsAloneAddUpToTheWei() public {
        vm.recordLogs();
        _at(97);
        _bet(bettors[0], 2, 100e18); // night 0: a false start, so this rolls
        _active(100, 100);
        _at(103);
        _bet(bettors[1], 2, 100e18); // night 1 (after night 0's lights out in 101-102)
        _bet(bettors[2], 10, 50e18);
        _active(105, 110); // night 1: bulbs 1-5 in 106-110, lights out 111-112
        _at(108);
        _bet(bettors[3], 4, 20e18); // bulb 4 lights in 109 = round sent + 1: paid back
        _at(114);
        _settleAll();
        for (uint256 id; id < lights.betCount(); ++id) {
            lights.claim(_ids(id));
        }

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 tBet = keccak256("BetPlaced(uint256,address,uint8,uint256,uint256)");
        bytes32 tClaim = keccak256("Claimed(uint256,address,uint256)");
        bytes32 tRefund = keccak256("Refunded(uint256,address,uint256)");
        bytes32 tBurn = keccak256("Burned(uint256,bool)");
        bytes32 tClosed = keccak256("NightClosed(uint256,uint256,uint256,uint256,uint64,uint256,uint256)");
        bytes32 tSettled = keccak256("NightSettled(uint256,uint8,uint256,uint256,uint256,uint256)");
        uint256 inflow;
        uint256 outflow;
        uint256 nClosed;
        uint256 nSettled;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(lights)) continue;
            bytes32 t = l.topics[0];
            if (t == tBet) {
                (, uint256 amount,) = abi.decode(l.data, (uint8, uint256, uint256));
                inflow += amount;
            } else if (t == tClaim || t == tRefund) {
                outflow += abi.decode(l.data, (uint256));
            } else if (t == tBurn) {
                (uint256 amount,) = abi.decode(l.data, (uint256, bool));
                outflow += amount;
            } else if (t == tClosed) {
                uint256 x = uint256(l.topics[1]);
                (uint256 start, uint256 c, uint256 litN,, uint256 spanEnd, uint256 lastBetRound) =
                    abi.decode(l.data, (uint256, uint256, uint256, uint64, uint256, uint256));
                LightsOn.Night memory n = lights.getNight(x);
                assertEq(start, n.start);
                assertEq(c, n.c);
                assertEq(litN, lights.lit(x));
                assertEq(spanEnd, n.spanEnd);
                assertEq(lastBetRound, n.lastBetRound);
                ++nClosed;
            } else if (t == tSettled) {
                uint256 x = uint256(l.topics[1]);
                (uint8 result, uint256 pot, uint256 burned, uint256 bonusIn,) =
                    abi.decode(l.data, (uint8, uint256, uint256, uint256, uint256));
                LightsOn.Night memory n = lights.getNight(x);
                assertEq(result, n.result);
                assertEq(pot, uint256(n.winStake) + n.loseStake + n.bonusIn);
                assertEq(burned, n.burned);
                assertEq(bonusIn, n.bonusIn);
                ++nSettled;
            }
        }
        assertEq(nClosed, 2);
        assertEq(nSettled, 2);
        assertEq(inflow, 270e18);
        assertEq(outflow, inflow, "what came in through BetPlaced left through Claimed or Burned");
        assertEq(lights.getNight(1).bonusIn, 100e18, "night 1 won Alice's rolled 100");
    }
}
