// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CommonBase} from "forge-std/Base.sol";
import {LightsBase} from "./LightsBase.t.sol";
import {LightsOn} from "../src/LightsOn.sol";
import {LightsMath} from "../src/LightsMath.sol";
import {DataPath} from "./DataPath.sol";

/// Settlement vectors for data/lights-vectors.json (settlement v2). Each night is one stops pattern (departure at
/// round 100), so `lit` and every bet's `litRound` and `litBefore` come from the same rounds and cannot disagree.
/// Expected values are never typed in: they come from LightsMath.settle, the code LightsOn runs in settle/claim.
abstract contract LightsVectorCases is CommonBase {
    uint256 internal constant SQK = 1e18;
    uint256 internal constant START = 100;

    struct BetCase {
        uint256 stake;
        uint256 bulb;
        uint256 betRound;
    }

    struct Case {
        string name;
        string note;
        uint64 stops; // bit i set: round START + i was active
        uint256 bonusIn;
        uint256 prevC; // 0, or the night before blacked out in prevC and prevC + 1 (both before START)
        BetCase[] bets;
    }

    Case[] internal _cases;

    /// Departure plus n bulbs in a row.
    function _run(uint256 n) internal pure returns (uint64) {
        return uint64((uint256(1) << (n + 1)) - 1);
    }

    function _new(string memory name, string memory note, uint64 stops, uint256 bonusIn) internal {
        Case storage x = _cases.push();
        x.name = name;
        x.note = note;
        x.stops = stops;
        x.bonusIn = bonusIn;
    }

    /// The night before departs in c - 2, lights bulb 1 in c - 1 and blacks out in c and c + 1.
    function _prevNight(uint256 c) internal {
        _cases[_cases.length - 1].prevC = c;
    }

    function _b(uint256 stake, uint256 bulb, uint256 betRound) internal {
        _cases[_cases.length - 1].bets.push(BetCase({stake: stake, bulb: bulb, betRound: betRound}));
    }

    function _buildCases() internal {
        delete _cases;

        _new(
            "normal-night",
            "lit 5: the pot is all four stakes (700), 2% of the 300 lost burns (6), the two lit bulbs share 694 by stake x bulb (200 : 900)",
            _run(5),
            0
        );
        _b(100 * SQK, 2, 97);
        _b(300 * SQK, 3, 97);
        _b(100 * SQK, 6, 97);
        _b(200 * SQK, 8, 97);

        _new(
            "all-winners",
            "every bulb lit, no bonus pot: nothing burns and the winners share their own 360 by stake x bulb, so bulb 1 gets back less than its stake",
            _run(5),
            0
        );
        _b(100 * SQK, 1, 97);
        _b(250 * SQK, 4, 97);
        _b(10 * SQK, 5, 98);

        _new(
            "all-losers-rollover", "lit 3, every bulb higher: all stakes become the next night's bonus pot", _run(3), 0
        );
        _b(100 * SQK, 7, 97);
        _b(500 * SQK, 9, 97);
        _b(40 * SQK, 24, 99);

        _new(
            "false-start-with-bonus-pot",
            "one round, then asleep: lit 0, the stakes and the 600 pot roll on",
            1,
            600 * SQK
        );
        _b(100 * SQK, 1, 97);
        _b(250 * SQK, 2, 97);
        _b(10 * SQK, 24, 98);

        _new(
            "bonus-pot-won",
            "a 600 pot from a rolled night: pot 600 staked + 600, burn 2% of (400 lost + 600) = 20, 1180 split 200 : 400",
            _run(5),
            600 * SQK
        );
        _b(100 * SQK, 2, 97);
        _b(100 * SQK, 4, 97);
        _b(400 * SQK, 12, 97);

        _new(
            "bonus-pot-only-winners",
            "nobody lost but a 1000 pot came in: 2% of the pot burns, the winners share 1180 by stake x bulb",
            _run(5),
            1000 * SQK
        );
        _b(100 * SQK, 1, 97);
        _b(100 * SQK, 3, 97);

        _new("empty-night-carries-pot", "no bets: the 300 pot rolls on untouched", _run(3), 300 * SQK);

        _new(
            "late-bet-two-rounds-rule",
            "bets in round 103: bulb 3 (lit 103) and bulb 4 (lit 104 = N+1) are refunded, bulb 5 (lit 105 = N+2) counts with weight 100 x (5 - 2 lit before 103)",
            _run(10),
            0
        );
        _b(200 * SQK, 20, 97);
        _b(100 * SQK, 1, 99);
        _b(100 * SQK, 3, 103);
        _b(100 * SQK, 4, 103);
        _b(100 * SQK, 5, 103);

        _new(
            "departure-round-bulb-1",
            "bulb 1 lights in 101: a bet sent in 99 counts, a bet sent in the departure round 100 is refunded",
            _run(4),
            0
        );
        _b(100 * SQK, 1, 99);
        _b(80 * SQK, 9, 99);
        _b(100 * SQK, 1, 100);
        _b(100 * SQK, 2, 100);

        _new(
            "breaks-shift-the-bulbs",
            "quiet 102 and 105 are breaks: bulbs light in 101, 103, 104, 106; bulb 2 counts from 101 but not from 102; bulb 3 sent in 102 weighs 100 x (3 - 1)",
            uint64(1 | 1 << 1 | 1 << 3 | 1 << 4 | 1 << 6),
            0
        );
        _b(150 * SQK, 6, 97);
        _b(100 * SQK, 2, 101);
        _b(100 * SQK, 2, 102);
        _b(100 * SQK, 3, 102);

        _new(
            "refund-in-a-rolled-night",
            "nobody won; the late bet on bulb 3 (lit 103 = N+1) did not count and is refunded, the rest roll",
            _run(3),
            0
        );
        _b(100 * SQK, 5, 97);
        _b(200 * SQK, 6, 97);
        _b(70 * SQK, 3, 102);

        _new(
            "dust-stakes",
            "wei-sized stakes and pot (below the 10 SQK minimum: math only); floors stay exact",
            _run(4),
            13
        );
        _b(1, 1, 97);
        _b(2, 2, 97);
        _b(3, 4, 97);
        _b(5, 5, 97);
        _b(7, 9, 97);
        _b(11, 3, 98);

        _new("odd-stakes", "stakes and pot that do not divide: the last winner takes the rounding", _run(5), SQK + 1);
        _b(13333333333333333333, 1, 97);
        _b(47 * SQK + 1, 3, 97);
        _b(99999999999999999999, 4, 97);
        _b(71 * SQK + 3, 7, 97);
        _b(23 * SQK + 7, 2, 98);
        _b(11 * SQK + 11, 9, 98);

        _new(
            "whale-wins",
            "10,000 SQK on bulb 8 (lit 8) takes most of the pot; the 10 SQK on bulb 1 lit too but gets back 1.26",
            _run(8),
            0
        );
        _b(10_000 * SQK, 8, 97);
        _b(10 * SQK, 1, 97);
        _b(20 * SQK, 9, 97);
        _b(35 * SQK, 10, 98);
        _b(50 * SQK, 12, 98);

        _new(
            "whale-loses",
            "10,000 SQK on bulb 7 stays dark (lit 6): 2% of it burns and three small winners share 9,885",
            _run(6),
            0
        );
        _b(10_000 * SQK, 7, 97);
        _b(10 * SQK, 2, 97);
        _b(25 * SQK, 5, 97);
        _b(50 * SQK, 6, 98);

        _new(
            "station-night",
            "36 running rounds (STATION): lit 35, all 24 bulbs at 10,000 win and share 240,490 by bulb: bulb 1 gets back 801.6, bulb 24 19,239.2",
            type(uint64).max >> 28,
            500 * SQK
        );
        for (uint256 k = 1; k <= 24; ++k) {
            _b(10_000 * SQK, k, 97);
        }

        _new(
            "twenty-four-bulbs-half-lit",
            "10,000 on each bulb, lit 12: bulbs 1-12 share the whole 237,600 by bulb, so bulbs 1-3 get back less than their stake",
            _run(12),
            0
        );
        for (uint256 k = 1; k <= 24; ++k) {
            _b(10_000 * SQK, k, 97);
        }

        _new(
            "higher-bulb-bigger-share",
            "equal stakes on bulbs 1, 5 and 10 (lit 10) share 496 as 1 : 5 : 10 (31, 155, 310)",
            _run(10),
            0
        );
        _b(100 * SQK, 1, 97);
        _b(100 * SQK, 5, 97);
        _b(100 * SQK, 10, 97);
        _b(100 * SQK, 11, 98);
        _b(100 * SQK, 12, 98);

        _new(
            "single-bet-wins-alone",
            "one bet whose bulb lit, nobody to win from: the whole pot is its own stake",
            _run(3),
            0
        );
        _b(42 * SQK, 2, 97);

        _new("single-bet-dark", "one bet whose bulb stayed dark: it becomes the bonus pot", _run(3), 0);
        _b(42 * SQK, 9, 97);

        // ---- added for settlement v2

        _new(
            "marathon-short-bulb-gets-back-less",
            "a marathon (lit 15): 1,000 on bulb 1 lit, but the long bulbs take most of the pot and it gets back 289.8",
            _run(15),
            0
        );
        _b(1000 * SQK, 1, 97);
        _b(100 * SQK, 2, 97);
        _b(200 * SQK, 12, 97);
        _b(100 * SQK, 14, 98);
        _b(50 * SQK, 20, 98);

        _new(
            "late-bet-lit-before",
            "bulb 8 sent before the start weighs 100 x 8; the same bet sent in 104 (3 lit before) weighs 100 x 5, and bulb 9 sent in 106 (5 lit) 100 x 4",
            _run(10),
            0
        );
        _b(100 * SQK, 8, 97);
        _b(100 * SQK, 15, 97);
        _b(100 * SQK, 8, 104);
        _b(100 * SQK, 9, 106);

        _new(
            "quiet-round-bet-joins-next-night",
            "the night before blacked out in 98 and 99 (C = 98) and he left again in 100: bets sent in 98 and 99 belong to this night and bulb 1 (lit 101) counts; bulb 1 sent in the departure round is refunded",
            _run(4),
            0
        );
        _prevNight(98);
        _b(100 * SQK, 1, 98);
        _b(100 * SQK, 2, 99);
        _b(60 * SQK, 6, 99);
        _b(100 * SQK, 1, 100);

        _new(
            "no-losers-redistribution",
            "lit 6, nobody lost, no pot: nothing burns, the late refund is set aside, and three winners share their 300 as 100 : 300 : 500 (bulb 6 was sent after bulb 1 lit)",
            _run(6),
            0
        );
        _b(100 * SQK, 1, 97);
        _b(100 * SQK, 3, 97);
        _b(100 * SQK, 2, 101);
        _b(100 * SQK, 6, 102);
    }

    // ------------------------------------------------------------ expectations

    function _bulbsLitOf(uint64 stops) internal pure returns (uint256 n) {
        for (uint256 i = 1; i < 64; ++i) {
            if ((stops >> i) & 1 == 1) ++n;
        }
    }

    function _litRoundIn(uint64 stops, uint256 k) internal pure returns (uint256) {
        uint256 seen;
        for (uint256 i = 1; i < 64; ++i) {
            if ((stops >> i) & 1 == 1 && ++seen == k) return START + i;
        }
        return 0;
    }

    /// Bulbs lit in rounds before `betRound` (0 for a bet sent before the departure or in it).
    function _litBeforeIn(uint64 stops, uint256 betRound) internal pure returns (uint256 n) {
        for (uint256 i = 1; i < 64 && START + i < betRound; ++i) {
            if ((stops >> i) & 1 == 1) ++n;
        }
    }

    function _inputs(Case storage x) internal view returns (LightsMath.BetIn[] memory ins) {
        ins = new LightsMath.BetIn[](x.bets.length);
        for (uint256 i; i < ins.length; ++i) {
            BetCase storage b = x.bets[i];
            ins[i] = LightsMath.BetIn({
                stake: b.stake,
                bulb: b.bulb,
                betRound: b.betRound,
                litRound: _litRoundIn(x.stops, b.bulb),
                litBefore: _litBeforeIn(x.stops, b.betRound)
            });
        }
    }

    struct Expect {
        uint256[] payouts;
        uint256 burned;
        uint256 bonusOut;
        uint8[] classes;
        uint8 result;
    }

    function _expect(Case storage x) internal view returns (Expect memory e) {
        (e.payouts, e.burned, e.bonusOut, e.classes, e.result) =
            LightsMath.settle(200, _bulbsLitOf(x.stops), x.bonusIn, _inputs(x));
    }

    // ------------------------------------------------------------ JSON

    function _vectorsJson() internal returns (string memory out) {
        _buildCases();
        out = "[\n";
        for (uint256 i; i < _cases.length; ++i) {
            out = string.concat(out, _caseJson(_cases[i]), i + 1 < _cases.length ? ",\n" : "\n");
        }
        out = string.concat(out, "]\n");
    }

    function _q(string memory s) internal pure returns (string memory) {
        return string.concat("\"", s, "\"");
    }

    function _qn(uint256 v) internal pure returns (string memory) {
        return _q(vm.toString(v));
    }

    function _caseJson(Case storage x) internal view returns (string memory s) {
        Expect memory e = _expect(x);
        s = string.concat(
            "  {\n    \"name\": ",
            _q(x.name),
            ",\n    \"note\": ",
            _q(x.note),
            ",\n    \"burnBps\": 200,\n    \"lit\": ",
            vm.toString(_bulbsLitOf(x.stops)),
            ",\n    \"bonusIn\": ",
            _qn(x.bonusIn),
            ",\n    \"bets\": ",
            _betsJson(x),
            ",\n    \"expect\": {\n      \"payouts\": ",
            _payoutsJson(e.payouts)
        );
        s = string.concat(
            s,
            ",\n      \"burned\": ",
            _qn(e.burned),
            ",\n      \"bonusOut\": ",
            _qn(e.bonusOut),
            ",\n      \"result\": ",
            _q(_resultName(e.result)),
            ",\n      \"classes\": ",
            _classesJson(e.classes),
            "\n    }\n  }"
        );
    }

    function _betsJson(Case storage x) internal view returns (string memory s) {
        if (x.bets.length == 0) return "[]";
        s = "[\n";
        for (uint256 i; i < x.bets.length; ++i) {
            BetCase storage b = x.bets[i];
            uint256 lr = _litRoundIn(x.stops, b.bulb);
            s = string.concat(
                s,
                "      { \"stake\": ",
                _qn(b.stake),
                ", \"bulb\": ",
                vm.toString(b.bulb),
                ", \"betRound\": ",
                vm.toString(b.betRound),
                ", \"litRound\": ",
                lr == 0 ? "null" : vm.toString(lr),
                ", \"litBefore\": ",
                vm.toString(_litBeforeIn(x.stops, b.betRound)),
                i + 1 < x.bets.length ? " },\n" : " }\n"
            );
        }
        s = string.concat(s, "    ]");
    }

    function _payoutsJson(uint256[] memory p) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < p.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ", ", _qn(p[i]));
        }
        s = string.concat(s, "]");
    }

    function _classesJson(uint8[] memory c) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < c.length; ++i) {
            string memory name = c[i] == LightsMath.WIN ? "win" : c[i] == LightsMath.LOSE ? "lose" : "refund";
            s = string.concat(s, i == 0 ? "" : ", ", _q(name));
        }
        s = string.concat(s, "]");
    }

    function _resultName(uint8 r) internal pure returns (string memory) {
        return r == LightsMath.PAID ? "paid" : "rolled";
    }
}

/// Prints the vectors file. Local in-memory EVM only, nothing is sent:
///   forge script test/LightsVectors.t.sol:LightsVectorsPrint --offline --json
/// The `logs[0]` of that output is written to ../data/lights-vectors.json byte for byte.
contract LightsVectorsPrint is Script, LightsVectorCases {
    function run() external {
        console2.log(_vectorsJson());
    }
}

contract LightsVectorsTest is LightsBase, LightsVectorCases {
    function _file() internal view returns (string memory) {
        return vm.readFile(DataPath.file("lights-vectors.json"));
    }

    function test_vectorsFileMatchesSettlementCode() public {
        assertEq(_file(), _vectorsJson(), "stale: regenerate with LightsVectorsPrint (see docs/lights-contract.md)");
    }

    function test_atLeastFifteenVectorsWithTheRequiredShapes() public {
        _buildCases();
        assertGe(_cases.length, 24);
        string memory json = _file();
        string[11] memory required = [
            "normal-night",
            "all-winners",
            "all-losers-rollover",
            "false-start-with-bonus-pot",
            "late-bet-two-rounds-rule",
            "dust-stakes",
            "whale-wins",
            "marathon-short-bulb-gets-back-less",
            "late-bet-lit-before",
            "quiet-round-bet-joins-next-night",
            "no-losers-redistribution"
        ];
        for (uint256 r; r < required.length; ++r) {
            bool found;
            for (uint256 i; i < _cases.length; ++i) {
                if (
                    keccak256(bytes(vm.parseJsonString(json, string.concat("$[", vm.toString(i), "].name"))))
                        == keccak256(bytes(required[r]))
                ) found = true;
            }
            assertTrue(found, required[r]);
        }
    }

    /// Spot checks worked out by hand (and by an independent BigInt reading of the spec).
    function test_handWorkedVectors() public view {
        string memory json = _file();
        // normal-night: pot 700, burn 6 (2% of the 300 lost), 694 split 200 : 900
        assertEq(_u(json, "$[0].expect.burned"), 6e18);
        assertEq(_u(json, "$[0].expect.payouts[0]"), 126181818181818181818);
        assertEq(_u(json, "$[0].expect.payouts[1]"), 567818181818181818182);
        assertEq(_u(json, "$[0].expect.payouts[2]"), 0);
        // all-winners: nothing burns, 360 shared 100 : 1000 : 50
        assertEq(_u(json, "$[1].expect.burned"), 0);
        assertEq(_u(json, "$[1].expect.payouts[0]"), 31304347826086956521);
        assertEq(vm.parseJsonString(json, "$[1].expect.result"), "paid");
        // false start with a 600 pot: 960 rolls on
        assertEq(_u(json, "$[3].expect.bonusOut"), 960e18);
        assertEq(vm.parseJsonUint(json, "$[3].lit"), 0);
        // bonus-pot-won: pot 1200, burn 20, 1180 split 1 : 2
        assertEq(_u(json, "$[4].expect.payouts[0]"), 393333333333333333333);
        assertEq(_u(json, "$[4].expect.payouts[1]"), 786666666666666666667);
        // late bets: refunded exactly; bulb 5 sent in 103 weighs 100 x 3
        assertEq(_u(json, "$[7].expect.payouts[2]"), 100e18);
        assertEq(_u(json, "$[7].expect.payouts[3]"), 100e18);
        assertEq(vm.parseJsonString(json, "$[7].expect.classes[4]"), "win");
        assertEq(vm.parseJsonUint(json, "$[7].bets[4].litBefore"), 2);
        assertEq(_u(json, "$[7].expect.payouts[4]"), 297e18);
        // marathon: bulb 1 lit and gets back 289.8 of its 1,000
        assertEq(vm.parseJsonString(json, "$[20].name"), "marathon-short-bulb-gets-back-less");
        assertEq(_u(json, "$[20].expect.payouts[0]"), 289.8e18);
        // late bets with bulbs lit before them
        assertEq(vm.parseJsonUint(json, "$[21].bets[2].litBefore"), 3);
        assertEq(vm.parseJsonUint(json, "$[21].bets[3].litBefore"), 5);
        assertEq(_u(json, "$[21].expect.payouts[0]"), 187294117647058823529);
        assertEq(_u(json, "$[21].expect.payouts[2]"), 117058823529411764706);
        assertEq(_u(json, "$[21].expect.payouts[3]"), 93647058823529411765);
        // quiet-round bets: in this night, before its start
        assertEq(vm.parseJsonUint(json, "$[22].bets[0].betRound"), 98);
        assertEq(vm.parseJsonString(json, "$[22].expect.classes[0]"), "win");
        assertEq(_u(json, "$[22].expect.payouts[0]"), 86266666666666666666);
        assertEq(vm.parseJsonString(json, "$[22].expect.classes[3]"), "refund");
        // no losers: 300 shared 100 : 300 : 500, nothing burned
        assertEq(_u(json, "$[23].expect.burned"), 0);
        assertEq(_u(json, "$[23].expect.payouts[0]"), 33333333333333333333);
        assertEq(_u(json, "$[23].expect.payouts[1]"), 100e18);
        assertEq(_u(json, "$[23].expect.payouts[2]"), 100e18);
        assertEq(_u(json, "$[23].expect.payouts[3]"), 166666666666666666667);
    }

    function _u(string memory json, string memory path) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, path));
    }

    /// Every vector a real bettor can reach (stakes 10..10,000 SQK, any pot from one rolled bet) is replayed
    /// through the full contract: MockCore rounds, bets at their rounds, walker, paged settle and claims.
    function test_contractReproducesEveryReachableVector() public {
        _buildCases();
        uint256 replayed;
        for (uint256 i; i < _cases.length; ++i) {
            if (_reachable(_cases[i])) {
                _replay(_cases[i]);
                ++replayed;
            }
        }
        assertGe(replayed, _cases.length - 2, "all but the dust and odd-pot vectors");
    }

    function _reachable(Case storage x) internal view returns (bool) {
        if (x.bonusIn != 0 && (x.bonusIn < 10e18 || x.bonusIn > 10_000e18)) return false;
        if (x.bets.length > 30) return false;
        for (uint256 i; i < x.bets.length; ++i) {
            if (x.bets[i].stake < 10e18 || x.bets[i].stake > 10_000e18) return false;
        }
        return true;
    }

    function _replay(Case storage x) internal {
        _deploy(36);
        uint256 night;
        if (x.bonusIn != 0) {
            // a false start at 60 whose one bet becomes exactly the pot
            core.setActive(60, 10);
            _at(55);
            _bet(bettors[39], 24, x.bonusIn);
            night = 1;
        }
        if (x.prevC != 0) {
            // a night without bets that blacks out in prevC and prevC + 1; bets sent in those rounds join this one
            core.setActive(uint64(x.prevC - 2), 300);
            core.setActive(uint64(x.prevC - 1), 300);
            ++night;
        }
        for (uint256 r; r < 64; ++r) {
            if ((x.stops >> r) & 1 == 1) core.setActive(uint64(START + r), 300);
        }
        uint256[] memory ids = new uint256[](x.bets.length);
        for (uint256 i; i < x.bets.length; ++i) {
            _at(x.bets[i].betRound);
            ids[i] = _bet(bettors[i], uint8(x.bets[i].bulb), x.bets[i].stake);
        }
        _at(START + 40);
        _settleAll();
        assertEq(lights.nightCount(), night + 1, x.name);
        if (x.prevC != 0) {
            assertEq(lights.getNight(night - 1).c, x.prevC, x.name);
            assertEq(lights.getNight(night - 1).lastBetRound, x.prevC - 1, x.name);
            assertEq(lights.getNight(night - 1).betEnd, x.bonusIn != 0 ? 1 : 0, "no vector bet in the night before");
        }
        assertEq(lights.getNight(night).start, START, x.name);
        assertEq(lights.lit(night), _bulbsLitOf(x.stops), x.name);
        assertEq(lights.getNight(night).bonusIn, x.bonusIn, x.name);
        Expect memory e = _expect(x);
        assertEq(lights.getNight(night).burned, e.burned, x.name);
        assertEq(lights.getNight(night).result, e.result, x.name);
        assertEq(lights.bonusPot(), e.bonusOut, x.name);
        LightsMath.BetIn[] memory ins = _inputs(x);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(lights.getBet(ids[i]).night, night, x.name);
            assertEq(lights.getBet(ids[i]).litBefore, ins[i].litBefore, x.name);
            assertEq(_cls(ids[i]), e.classes[i], x.name);
            assertEq(_claim(ids[i]), e.payouts[i], x.name);
        }
        assertEq(sqk.balanceOf(address(lights)), e.bonusOut + lights.unburned(), x.name);
    }
}
