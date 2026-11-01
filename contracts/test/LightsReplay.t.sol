// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {LightsBase} from "./LightsBase.t.sol";
import {LightsOn} from "../src/LightsOn.sol";
import {LightsMath} from "../src/LightsMath.sol";

/// Replays Squeektoshi's real rounds 1-780 (data/rounds.json) through MockCore and LightsOn, with scripted bettors
/// on every one of the 19 real nights, including the false starts at 478 and 539 that roll a bonus pot forward.
contract LightsReplayTest is LightsBase {
    struct Active {
        uint256 cumulative;
        uint256 id;
        uint256 work;
    }

    struct RefNight {
        uint256 start;
        uint256 c; // 0 = STATION
        uint64 stops;
        uint256 spanEnd;
        uint256 lastBet; // last round whose bets join it: C - 1, or spanEnd at a STATION end
    }

    uint256 internal settledThrough;
    mapping(uint256 => bool) internal isActive;
    RefNight[] internal refs;

    uint256 internal deposited;
    mapping(uint256 => uint256) internal stakedIn; // reference night => stakes placed for it
    uint256 internal quietRoundBets; // bets sent in the blackout rounds of the night before
    uint256[] internal quietRoundBulb1; // the bulb-1 bets of those crowds

    function setUp() public override {
        _deploy(36);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../data/rounds.json"));
        settledThrough = vm.parseJsonUint(json, ".settledThrough");
        Active[] memory act = abi.decode(vm.parseJson(json, ".active"), (Active[]));
        uint256 cum;
        for (uint256 i; i < act.length; ++i) {
            core.setActive(uint64(act[i].id), uint64(act[i].work));
            cum += act[i].work;
            assertEq(cum, act[i].cumulative, "rounds.json cumulative work is consistent");
            isActive[act[i].id] = true;
        }
        _buildReference();
    }

    /// The rules read round by round, written independently of the contract's page walker.
    function _buildReference() internal {
        uint256 start;
        uint64 stops;
        uint256 idle;
        for (uint256 r = 1; r <= settledThrough; ++r) {
            if (start != 0 && r >= start + 36) {
                refs.push(RefNight({start: start, c: 0, stops: stops, spanEnd: start + 35, lastBet: start + 35}));
                start = 0;
            }
            if (isActive[r]) {
                if (start == 0) {
                    start = r;
                    stops = 1;
                } else {
                    stops |= uint64(1 << (r - start));
                }
                idle = 0;
            } else if (start != 0 && ++idle == 2) {
                refs.push(RefNight({start: start, c: r - 1, stops: stops, spanEnd: r, lastBet: r - 2}));
                start = 0;
                idle = 0;
            }
        }
    }

    // ------------------------------------------------------------ nights

    function test_referenceMatchesTheKnownRides() public view {
        uint256[2][19] memory known = [
            [uint256(45), 62],
            [uint256(78), 81],
            [uint256(99), 104],
            [uint256(189), 198],
            [uint256(210), 218],
            [uint256(220), 223],
            [uint256(240), 244],
            [uint256(333), 336],
            [uint256(341), 359],
            [uint256(373), 376],
            [uint256(478), 479],
            [uint256(481), 503],
            [uint256(515), 519],
            [uint256(539), 540],
            [uint256(622), 645],
            [uint256(656), 659],
            [uint256(665), 667],
            [uint256(670), 672],
            [uint256(767), 777]
        ];
        assertEq(refs.length, 19);
        for (uint256 i; i < 19; ++i) {
            assertEq(refs[i].start, known[i][0], "start");
            assertEq(refs[i].c, known[i][1], "C");
            assertEq(_bulbsLit(refs[i].stops) == 0, i == 10 || i == 13, "false starts at 478 and 539");
        }
    }

    /// The data agent's data/rides.json (computed separately in node) agrees night by night, bulbs included.
    function test_ridesJsonAgrees() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../data/rides.json"));
        assertEq(vm.parseJsonUint(json, "$.settledThrough"), settledThrough, "same rounds snapshot");
        for (uint256 i; i < refs.length; ++i) {
            string memory p = string.concat("$.rides[", vm.toString(i), "]");
            assertEq(vm.parseJsonUint(json, string.concat(p, ".start")), refs[i].start, "start");
            assertEq(vm.parseJsonUint(json, string.concat(p, ".C")), refs[i].c, "C");
            assertEq(vm.parseJsonUint(json, string.concat(p, ".stopCount")), _bulbsLit(refs[i].stops), "bulbs lit");
            uint256[] memory lits = vm.parseJsonUintArray(json, string.concat(p, ".stops"));
            for (uint256 k; k < lits.length; ++k) {
                assertEq(_litRoundOf(refs[i].start, refs[i].stops, k + 1), lits[k], "round bulb k lit in");
            }
        }
    }

    function test_walkerAloneMatchesReference() public {
        _at(settledThrough + 1);
        uint256 pages = lights.poke(1000);
        _assertNightsMatchReference();
        console2.log("pages to walk rounds 1..780:", pages);
    }

    function _assertNightsMatchReference() internal view {
        assertEq(lights.nightCount(), refs.length, "same number of nights, false starts included");
        for (uint256 i; i < refs.length; ++i) {
            LightsOn.Night memory n = lights.getNight(i);
            assertEq(n.start, refs[i].start, "start");
            assertEq(n.c, refs[i].c, "C");
            assertEq(n.stops, refs[i].stops, "stops");
            assertEq(n.spanEnd, refs[i].spanEnd, "span");
            assertEq(n.lastBetRound, refs[i].lastBet, "bets up to C - 1");
        }
    }

    // ------------------------------------------------------------ scripted bettors

    /// Every real night with scripted bettors (even nights use bettors 0-11, odd nights 12-23):
    /// - a crowd of 8 three rounds before the departure (bulbs 1, 2, 3, 5, 8, 13, 21, 24; one 10,000 SQK whale and
    ///   one 10 SQK minimum bet), or in the first quiet round of the night before's blackout (C) when he left again
    ///   within 3 rounds of it: from v2 those bets belong to this night;
    /// - 2 bets in the departure round (bulb 1, refunded by the two-rounds rule, and bulb 2);
    /// - 2 bets 3 rounds in: one on the next bulb (refunded if it lights in the next round) and one on the
    ///   next-but-one, the closest bulb the page offers.
    /// The false starts at 478 and 539 lose every bet, so their stakes become the bonus pot of 481 and 622.
    function test_replayEveryRealNightWithScriptedBettors() public {
        for (uint256 r = 1; r <= settledThrough + 1; ++r) {
            _at(r);
            lights.poke(20);
            for (uint256 i; i < refs.length; ++i) {
                _scriptRound(i, r);
            }
            if (r % 12 == 0) lights.settle(200);
            if (r == 482) _assertFalseStartRolled(10, 11, r);
            if (r == 543) _assertFalseStartRolled(13, 14, r);
        }
        _settleAll();
        _assertNightsMatchReference();
        uint256 firstOpen = _checkAllNights();
        assertEq(firstOpen, lights.betCount(), "every bet is in a closed night");

        // the two false starts handed their whole pot to the next night, which paid it out
        _assertPotMoved(10, 11);
        _assertPotMoved(13, 14);

        uint256 paid;
        uint256[3] memory byClass;
        uint256 litButLess; // v2: winners that got back less than their stake
        for (uint256 id; id < lights.betCount(); ++id) {
            uint8 cls = _cls(id);
            ++byClass[cls];
            uint256 got = _claim(id);
            if (cls == LightsMath.WIN && got < lights.getBet(id).stake) ++litButLess;
            paid += got;
        }
        assertEq(paid + sqk.totalBurned() + lights.bonusPot(), deposited, "every wei paid, burned or carried");
        assertEq(sqk.balanceOf(address(lights)), lights.bonusPot());
        assertGt(byClass[LightsMath.REFUND], 19, "every departure-round bet on bulb 1 was refunded");
        assertGt(byClass[LightsMath.WIN], 0);
        assertGt(byClass[LightsMath.LOSE], 0);
        // 220, 481 and 670 depart 2-3 rounds after the night before's C: their crowds bet in that C
        assertEq(quietRoundBets, 24, "three crowds of 8 sent in a blackout round");
        assertEq(quietRoundBulb1.length, 3);
        for (uint256 k; k < quietRoundBulb1.length; ++k) {
            LightsOn.Bet memory b = lights.getBet(quietRoundBulb1[k]);
            assertEq(b.bulb, 1);
            assertEq(b.betRound, lights.getNight(b.night - 1).c, "sent in the night before's C");
            assertEq(_cls(quietRoundBulb1[k]), LightsMath.WIN, "and its bulb 1 counted for this night");
        }
        console2.log("bets sent in a blackout round, joined the next night", quietRoundBets);

        console2.log("nights", lights.nightCount(), "bets", lights.betCount());
        console2.log("refund / win / lose", byClass[0], byClass[1], byClass[2]);
        console2.log("winners that got back less than their stake", litButLess);
        console2.log("SQK bet", deposited / 1e18, "burned (wei)", sqk.totalBurned());
        console2.log("bonus pot 478 -> 481 (SQK)", lights.getNight(11).bonusIn / 1e18);
        console2.log("bonus pot 539 -> 622 (SQK)", lights.getNight(14).bonusIn / 1e18);
    }

    function _scriptRound(uint256 i, uint256 r) internal {
        RefNight memory n = refs[i];
        uint256 prevLast = i == 0 ? 0 : refs[i - 1].lastBet;
        // the earliest round whose bets join this night, at most 3 before the departure
        uint256 pre = n.start >= 3 && n.start - 3 > prevLast ? n.start - 3 : prevLast + 1;
        if (r == pre) {
            if (i > 0 && refs[i - 1].c != 0 && pre <= refs[i - 1].c + 1) {
                quietRoundBets += 8;
                quietRoundBulb1.push(lights.betCount()); // the crowd's first bet is on bulb 1
            }
            _crowd(i);
        }
        if (r == n.start) {
            _place(i, 8, 1, 25e18 + i * 1e18);
            _place(i, 9, 2, 40e18 + i);
        }
        if (r == n.start + 3 && r <= n.lastBet) {
            uint256 litNow = _litBy(n, r); // bulbs lit up to and including the round in progress
            _place(i, 10, _cap(litNow + 1), 30e18 + i * 3);
            _place(i, 11, _cap(litNow + 2), 60e18 + i * 7);
        }
    }

    function _crowd(uint256 i) internal {
        uint8[8] memory bulbs = [1, 2, 3, 5, 8, 13, 21, 24];
        for (uint256 j; j < 8; ++j) {
            uint256 stake = j == 6 ? 10_000e18 : j == 0 ? 10e18 : 10e18 + (i * 13 + j * 7) * 1e18 + j;
            _place(i, j, bulbs[j], stake);
        }
    }

    function _place(uint256 i, uint256 who, uint256 bulb, uint256 stake) internal {
        // alternate bettor sets, so a crowd sent in the night before's blackout round is not that night's bettors
        _bet(bettors[who + (i % 2) * 12], uint8(bulb), stake);
        deposited += stake;
        stakedIn[i] += stake;
    }

    function _assertFalseStartRolled(uint256 fs, uint256 next, uint256 r) internal {
        lights.settle(1000);
        assertEq(lights.nextSettle(), fs + 1, "the false start is settled, the next night is still open");
        LightsOn.Night memory n = lights.getNight(fs);
        assertEq(n.result, LightsMath.ROLLED);
        assertEq(n.loseStake, stakedIn[fs], "every bet on the false start lost");
        assertGt(lights.bonusPot(), 0);
        assertEq(lights.bonusPot(), n.loseStake + n.bonusIn, "and rolled into the bonus pot");
        (uint256 start,,) = lights.openNight();
        assertEq(start, refs[next].start < r ? refs[next].start : 0, "the next night is open, or not started yet");
    }

    function _assertPotMoved(uint256 fs, uint256 next) internal view {
        LightsOn.Night memory a = lights.getNight(fs);
        LightsOn.Night memory b = lights.getNight(next);
        assertGt(b.bonusIn, 0);
        assertEq(b.bonusIn, uint256(a.loseStake) + a.bonusIn, "bonusOut of the false start == bonusIn of the next");
        assertEq(b.result, LightsMath.PAID, "the next night paid the pot out");
        assertEq(b.burned, (uint256(b.loseStake) + b.bonusIn) * 200 / 10_000);
        assertGe(lights.consumedBefore(), next);
    }

    function _litBy(RefNight memory n, uint256 r) internal pure returns (uint256 k) {
        for (uint256 x = n.start + 1; x <= r; ++x) {
            if ((n.stops >> (x - n.start)) & 1 == 1) ++k;
        }
    }

    function _cap(uint256 b) internal pure returns (uint256) {
        return b > 24 ? 24 : b;
    }
}
