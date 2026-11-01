// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {LightsBase} from "./LightsBase.t.sol";
import {LightsOn} from "../src/LightsOn.sol";
import {LightsMath} from "../src/LightsMath.sol";
import {MockCore, MockSQK} from "./mocks/Mocks.sol";

/// Drives LightsOn with random bets, rounds, pokes, settles, claims and core hiccups.
contract LightsHandler is Test {
    uint256 internal constant G = 1793022600;

    LightsOn public lights;
    MockCore public core;
    address[] public actors;
    uint256 public round = 60;
    uint256 public refused; // AlreadyBet refusals seen

    constructor(LightsOn l, MockCore c, address[] memory a) {
        lights = l;
        core = c;
        actors = a;
        _enter(round);
    }

    function _enter(uint256 r) internal {
        vm.warp(G + (r - 1) * 600 + 100);
        core.setSettled(uint64(r - 1));
        core.setReverting(false);
    }

    /// One round passes; about 3 in 4 are active, so breaks, blackouts, false starts and STATION ends all happen.
    function step(uint8 seed) external {
        if (seed % 4 != 0) core.setActive(uint64(round), 400);
        ++round;
        _enter(round);
    }

    function stepMany(uint8 seed, uint8 n) external {
        n = uint8(bound(n, 1, 12));
        for (uint256 i; i < n; ++i) {
            if (uint256(keccak256(abi.encode(seed, i))) % 4 != 0) core.setActive(uint64(round), 400);
            ++round;
            _enter(round);
        }
    }

    function lateInRound() external {
        uint256 t = G + round * 600 - 30;
        if (block.timestamp < t) vm.warp(t);
    }

    /// The core lags a round or fails for the rest of this round; the next step restores it.
    function hiccup(bool revertIt) external {
        if (revertIt) core.setReverting(true);
        else if (round > 2) core.setSettled(uint64(round - 2));
    }

    /// Up to three bettors at once, mostly on low bulbs so nights have winners as well as losers.
    function bet(uint256 seed, uint8 count) external {
        for (uint256 i; i < bound(count, 1, 3); ++i) {
            uint256 x = uint256(keccak256(abi.encode(seed, i)));
            address a = actors[x % actors.length];
            uint8 bulb = uint8(x % 3 == 0 ? 1 + (x >> 8) % 24 : 1 + (x >> 8) % 6);
            uint256 stake = (x >> 16) % 5 == 0 ? 10e18 : 10e18 + (x >> 32) % 9_990e18;
            vm.prank(a);
            try lights.bet(bulb, stake) {}
            catch (bytes memory err) {
                // AlreadyBet, or PokeFirst while the walker has not caught up with the core
                bytes4 e = bytes4(err);
                assertTrue(
                    e == LightsOn.AlreadyBet.selector || e == LightsOn.PokeFirst.selector,
                    "only AlreadyBet or PokeFirst may refuse a valid bet"
                );
                ++refused;
            }
        }
    }

    function poke(uint8 pages) external {
        lights.poke(bound(pages, 1, 3));
    }

    function settle(uint8 work) external {
        lights.settle(bound(work, 1, 20));
    }

    function claim(uint256 betSeed) external {
        uint256 n = lights.betCount();
        if (n == 0) return;
        uint256[] memory ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            ids[i] = uint256(keccak256(abi.encode(betSeed, i))) % n;
        }
        lights.claim(ids);
    }
}

contract LightsInvariantTest is LightsBase {
    LightsHandler internal handler;
    address[] internal actors;
    uint256 internal minted;

    function setUp() public override {
        core = new MockCore();
        sqk = new MockSQK();
        // a short STATION so STATION ends happen too
        lights = new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(sqk), genesisTime: G, station: 12, startRound: 0})
        );
        for (uint256 i; i < 12; ++i) {
            address a = address(uint160(0xA11CE0 + i));
            actors.push(a);
            sqk.mint(a, 10_000_000e18);
            minted += 10_000_000e18;
            vm.prank(a);
            sqk.approve(address(lights), type(uint256).max);
        }
        handler = new LightsHandler(lights, core, actors);
        targetContract(address(handler));
    }

    /// Every SQK wei is with a player, held by LightsOn, or burned.
    function invariant_conservation() public view {
        uint256 sum = sqk.balanceOf(address(lights)) + sqk.totalBurned() + sqk.balanceOf(lights.DEAD());
        for (uint256 i; i < actors.length; ++i) {
            sum += sqk.balanceOf(actors[i]);
        }
        assertEq(sum, minted);
    }

    /// LightsOn holds exactly what it owes: stakes not settled yet, unclaimed payouts, and the bonus pot (whose
    /// stakes are still riding), plus anything a broken burn left behind.
    function invariant_holdsExactlyWhatItOwes() public view {
        uint256 owed;
        uint256 riding;
        uint256 n = lights.betCount();
        for (uint256 id; id < n; ++id) {
            LightsOn.Bet memory b = lights.getBet(id);
            if (b.status == lights.WAITING()) {
                owed += b.stake;
            } else if (b.status == lights.COUNTED()) {
                LightsOn.Night memory night = lights.getNight(b.night);
                (uint256 pay, bool ready) = _due(id);
                if (night.result == LightsMath.SETTLING) {
                    owed += b.stake;
                } else if (night.result == LightsMath.ROLLED && b.cls == LightsMath.LOSE && !ready) {
                    riding += b.stake;
                } else {
                    assertTrue(ready);
                    owed += pay;
                }
            }
        }
        assertEq(riding, lights.bonusPot(), "the bonus pot is exactly the rolled stakes no night has won");
        assertEq(sqk.balanceOf(address(lights)), owed + riding + lights.unburned());
    }

    /// Every settled night: paged == pure bet by bet (litBefore read off the stops mask), payouts + burn + bonusOut
    /// == stakes + bonusIn, the bonus pot chains night to night, and a bet whose bulb lit within betRound + 1 is
    /// refunded and never profits.
    function invariant_everySettledNightBalances() public view {
        _checkAllNights();
        if (lights.nightCount() > 0 && lights.getNight(0).result != 0) {
            assertEq(lights.getNight(0).bonusIn, 0, "the first night has no pot");
        }
    }

    /// Paid refunds and wins, read independently of the contract's class: the rule needs only the stops mask. In v2
    /// a lit bulb may get back less than its stake, so the only bound on a winner is the pool it shares.
    function invariant_noProfitFromABulbLitWithinOneRound() public view {
        uint256 n = lights.betCount();
        for (uint256 id; id < n; ++id) {
            LightsOn.Bet memory b = lights.getBet(id);
            if (b.status != lights.COUNTED() && b.status != lights.CLAIMED()) continue;
            LightsOn.Night memory night = lights.getNight(b.night);
            if (night.result == LightsMath.SETTLING) continue;
            uint256 lr = _litRoundOf(night.start, night.stops, b.bulb);
            (uint256 pay,) = _due(id);
            if (lr != 0 && lr <= uint256(b.betRound) + 1) assertEq(pay, b.stake, "refunded, no payout above stake");
            if (lr == 0) assertEq(pay, 0, "a dark bulb never pays");
            if (lr > uint256(b.betRound) + 1) {
                uint256 pool = uint256(night.winStake) + night.loseStake + night.bonusIn - night.burned;
                uint256 w = uint256(b.stake) * (b.bulb - _litBeforeOf(night.start, night.stops, b.betRound));
                assertLe(pay, pool * w / night.sumW + 1, "a winner gets its weight's share of the pool");
            }
        }
    }

    /// One bet per address per night; bets sorted by round; every night's bets inside its window (up to C - 1, or
    /// to its last round at a STATION end).
    function invariant_oneBetPerAddressPerNight() public view {
        uint256 first;
        uint256 prevSpan;
        for (uint256 x; x < lights.nightCount(); ++x) {
            LightsOn.Night memory night = lights.getNight(x);
            assertGt(night.start, prevSpan, "nights never overlap");
            if (night.c != 0) {
                assertEq(night.spanEnd, uint256(night.c) + 1);
                assertEq(night.lastBetRound, uint256(night.c) - 1, "C and C + 1 belong to the next night");
            } else {
                assertEq(night.spanEnd, uint256(night.start) + lights.STATION() - 1);
                assertEq(night.lastBetRound, night.spanEnd);
            }
            prevSpan = night.spanEnd;
            if (night.result == 0) continue;
            for (uint256 i = first; i < night.betEnd; ++i) {
                address o = lights.getBet(i).owner;
                for (uint256 j = i + 1; j < night.betEnd; ++j) {
                    assertTrue(lights.getBet(j).owner != o, "one bet per address per night");
                }
            }
            first = night.betEnd;
        }
        uint256 n = lights.betCount();
        for (uint256 id = 1; id < n; ++id) {
            assertGe(lights.getBet(id).betRound, lights.getBet(id - 1).betRound, "bets sorted by round");
        }
    }

    /// At the end of every run the core dies: flagStall, 24 h, settle, void, claim everything. Nothing may be left.
    function afterInvariant() public {
        uint256 nights = lights.nightCount();
        uint256[4] memory results;
        for (uint256 x; x < nights; ++x) {
            ++results[lights.getNight(x).result];
        }
        console2.log("bets", lights.betCount(), "nights", nights);
        console2.log("paid / rolled", results[1], results[3]);
        console2.log("unsettled nights", results[0], "AlreadyBet refusals", handler.refused());
        console2.log("bonus pot riding (SQK)", lights.bonusPot() / 1e18, "burned (SQK)", sqk.totalBurned() / 1e18);

        _coreDownForAStall();
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        lights.settle(type(uint256).max);
        lights.void();
        uint256[] memory ids = new uint256[](lights.betCount());
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = i;
        }
        lights.claim(ids);
        assertEq(lights.bonusPot(), 0, "the stranded pot went back to its bets");
        assertEq(sqk.balanceOf(address(lights)), lights.unburned(), "no stuck funds after a void");
        assertEq(lights.claim(ids), 0);
    }
}
