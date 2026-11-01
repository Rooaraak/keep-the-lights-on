// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {LightsBase} from "./LightsBase.t.sol";
import {LightsOn} from "../src/LightsOn.sol";

/// Gas per action. Run with --isolate so every call is its own transaction:
///   forge test --offline --isolate --match-contract LightsGasTest -vv
contract LightsGasTest is LightsBase {
    function _log(string memory what) internal view {
        console2.log(what, vm.lastCallGas().gasTotalUsed);
    }

    function test_gasPerAction() public {
        _at(97);
        lights.poke(10); // walker caught up, so the bets' own cranks find nothing to read
        vm.prank(bettors[0]);
        lights.bet(2, 100e18);
        _log("bet (first bet ever, walker idle):");
        vm.prank(bettors[1]);
        lights.bet(5, 100e18);
        _log("bet (walker idle):");
        for (uint256 i = 2; i < 10; ++i) {
            _bet(bettors[i], uint8(1 + i * 2), 100e18 + i);
        }

        _active(100, 115); // 16 active rounds, C = 116, lit 15
        _at(117);
        lights.poke(1);
        _log("poke, 1 page with 16 records:");
        _at(118);
        lights.poke(1);
        _log("poke, 1 page that closes the night:");
        lights.settle(5);
        _log("settle 5 bets:");
        lights.settle(100);
        _log("settle 5 bets + settle the night + SQK burn:");

        uint256[] memory one = new uint256[](1);
        one[0] = 0;
        lights.claim(one);
        _log("claim 1 winning bet:");
        uint256[] memory many = new uint256[](8);
        for (uint256 i; i < 8; ++i) {
            many[i] = i + 1;
        }
        lights.claim(many);
        _log("claim 8 bets in one tx (6 winners, 2 losers):");

        // a returning bettor: its last bet's night has closed
        vm.prank(bettors[0]);
        lights.bet(3, 100e18);
        _log("bet (returning bettor, walker idle):");
    }

    function test_gasBetThatSettlesANight() public {
        _at(97);
        for (uint256 i; i < 3; ++i) {
            _bet(bettors[i], uint8(i + 2), 100e18);
        }
        _at(98);
        _bet(bettors[3], 9, 100e18); // the loser
        _active(100, 104); // lit 4: bulbs 2, 3 and 4 win
        _at(110);
        vm.prank(bettors[5]);
        lights.bet(2, 100e18);
        _log("bet that also walks 1 page, counts 4 bets (its 4 units of work):");
        vm.prank(bettors[6]);
        lights.bet(2, 100e18);
        _log("bet that also settles the night + SQK burn:");
    }

    function test_gasRolloverClaims() public {
        _at(97);
        uint256 loser = _bet(bettors[0], 9, 100e18);
        core.setActive(100, 10); // false start: rolls
        _at(105);
        uint256 w = _bet(bettors[1], 1, 100e18);
        _active(110, 112);
        _at(120);
        lights.poke(10);
        lights.settle(100);
        uint256[] memory ids = new uint256[](1);
        ids[0] = w;
        lights.claim(ids);
        _log("claim a winner of a bonus pot:");
        ids[0] = loser;
        lights.claim(ids);
        _log("claim a rolled stake that a later night won (pays 0):");
    }

    /// The page's gas limits for the way out (docs/lights-contract.md): flagStall and void each fit in 2,200,000
    /// (the stall check needs STALL_GAS left), and with much less they refuse (NeedMoreGas) instead of misreading
    /// the core. Calls with an explicit gas limit, so this holds with or without --isolate.
    function test_gasTheWayOut() public {
        _at(97);
        _bet(bettors[0], 3, 100e18);
        _coreDownForAStall();
        (bool ok,) = address(lights).call{gas: 1_500_000}(abi.encodeCall(LightsOn.flagStall, ()));
        assertFalse(ok, "too little gas: refused");
        assertEq(lights.stallFlaggedAt(), 0);
        (ok,) = address(lights).call{gas: 2_200_000 - 21_000}(abi.encodeCall(LightsOn.flagStall, ()));
        assertTrue(ok, "flagStall fits in 2,200,000");
        vm.warp(block.timestamp + 1 days);
        (ok,) = address(lights).call{gas: 2_200_000 - 21_000}(abi.encodeCall(LightsOn.void, ()));
        assertTrue(ok, "void fits in 2,200,000");
        assertTrue(lights.voided());
    }
}
