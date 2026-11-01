// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LightsBase} from "./LightsBase.t.sol";
import {LightsOn} from "../src/LightsOn.sol";
import {LightsMath} from "../src/LightsMath.sol";
import {MockCore, MockSQK} from "./mocks/Mocks.sol";

contract LightsOnTest is LightsBase {
    uint8 internal constant REFUND = 0;
    uint8 internal constant WIN = 1;
    uint8 internal constant LOSE = 2;
    uint8 internal constant PAID = 1;
    uint8 internal constant ROLLED = 3;

    // ------------------------------------------------------------ config and betting rules

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(LightsOn.BadConfig.selector);
        new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(sqk), genesisTime: G, station: 3, startRound: 0})
        );
        vm.expectRevert(LightsOn.BadConfig.selector);
        new LightsOn(
            LightsOn.Config({core: address(core), sqk: address(sqk), genesisTime: G, station: 65, startRound: 0})
        );
        vm.expectRevert(LightsOn.BadConfig.selector);
        new LightsOn(LightsOn.Config({core: address(0), sqk: address(sqk), genesisTime: G, station: 36, startRound: 0}));
    }

    function test_noAdminSurface() public view {
        // constants, not settings
        assertEq(lights.MIN_BET(), 10e18);
        assertEq(lights.MAX_BET(), 10_000e18);
        assertEq(lights.MAX_BULB(), 24);
        assertEq(lights.BURN_BPS(), 200);
        assertEq(lights.STATION(), 36);
        assertEq(address(lights.CORE()), address(core));
    }

    function test_betLimitsAndPull() public {
        _at(97);
        vm.startPrank(bettors[0]);
        vm.expectRevert(LightsOn.BadBulb.selector);
        lights.bet(0, 100e18);
        vm.expectRevert(LightsOn.BadBulb.selector);
        lights.bet(25, 100e18);
        vm.expectRevert(LightsOn.BadAmount.selector);
        lights.bet(3, 10e18 - 1);
        vm.expectRevert(LightsOn.BadAmount.selector);
        lights.bet(3, 10_000e18 + 1);
        vm.stopPrank();

        uint256 before = sqk.balanceOf(bettors[0]);
        vm.expectEmit(true, true, false, true, address(lights));
        emit LightsOn.BetPlaced(0, bettors[0], 1, 10e18, 97);
        _bet(bettors[0], 1, 10e18);
        _bet(bettors[1], 24, 10_000e18);
        assertEq(sqk.balanceOf(bettors[0]), before - 10e18, "SQK pulled with transferFrom");
        assertEq(sqk.balanceOf(address(lights)), 10_010e18);
        LightsOn.Bet memory b = lights.getBet(1);
        assertEq(b.owner, bettors[1]);
        assertEq(b.bulb, 24);
        assertEq(b.stake, 10_000e18);
        assertEq(b.betRound, 97);
        assertEq(b.status, lights.WAITING());
        assertEq(lights.lastBet(bettors[1]), 2);
    }

    function test_betNeedsAllowance() public {
        _at(97);
        address stranger = address(0xCAFE);
        sqk.mint(stranger, 100e18);
        vm.prank(stranger);
        vm.expectRevert(bytes("allowance"));
        lights.bet(3, 50e18);
    }

    function test_betBeforeGenesisReverts() public {
        vm.warp(G - 1000);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.BeforeGenesis.selector);
        lights.bet(3, 50e18);
    }

    function test_guardBandMovesALateBetToTheNextRound() public {
        _late(97);
        assertEq(lights.currentRound(), 97);
        uint256 id = _bet(bettors[0], 3, 50e18);
        assertEq(lights.getBet(id).betRound, 98, "last 60 s count as the next round");
        vm.warp(G + 97 * 600 - 61);
        id = _bet(bettors[1], 3, 50e18);
        assertEq(lights.getBet(id).betRound, 97, "61 s before the end is still this round");
    }

    function test_oneBetPerAddressPerNight() public {
        _active(100, 105); // C = 106, the night ends at 107; bets up to 105 are in it, 106 and 107 in the next
        _at(97);
        _bet(bettors[0], 3, 50e18);
        _at(98);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(4, 50e18); // still the next night: same night

        _at(103);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(9, 50e18); // the night is open: still the same night

        // C and C + 1: these rounds belong to the next night, but the contract only knows that once 107 is
        // recorded as quiet (he might wake up in it), so a returning bettor is refused until then
        _at(106);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(9, 50e18);
        _at(107);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(9, 50e18);

        // round 108, but the core has not recorded 107 yet: the contract cannot know the night ended
        vm.warp(G + 107 * 600 + 20);
        core.setSettled(106);
        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(9, 50e18);

        core.setSettled(107);
        uint256 id = _bet(bettors[0], 9, 50e18); // the bet itself walks the round that closes the night
        assertEq(lights.nightCount(), 1);
        assertEq(lights.getNight(0).spanEnd, 107);
        assertEq(lights.getNight(0).lastBetRound, 105);
        assertEq(lights.getBet(id).betRound, 108);

        vm.prank(bettors[0]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(2, 50e18); // and now that next night has its bet

        _settleAll();
        assertEq(lights.getNight(0).betEnd, 1, "the 97 bet is in night 0, the 108 bet waits for the next");
    }

    function test_quietSpellWalkerCatchUpBeforeRefusing() public {
        // a false start every third round: many pages of records, and the walker only moves when someone acts
        for (uint256 r = 100; r < 400; r += 3) {
            core.setActive(uint64(r), 300);
        }
        _at(350); // C of the false start at 349, so the bet joins the false start at 352 (its bets end at 352)
        _bet(bettors[0], 2, 50e18);
        assertLt(lights.getWalker().cursor, 200, "the walker is far behind");
        _at(500);
        uint256 id = _bet(bettors[0], 2, 50e18); // one page is not enough; the extra catch-up is
        assertGe(lights.getWalker().lastBetRound, 350);
        assertEq(lights.getBet(id).betRound, 500);
    }

    /// A bet sent in a blackout round is the next night's bet, so it is that night's one bet for the address.
    function test_oneBetPerNightAcrossTheBlackoutRounds() public {
        _active(100, 105); // C = 106
        _at(105);
        _bet(bettors[0], 9, 50e18); // the last round of night 0's bets
        _at(106);
        uint256 inC = _bet(bettors[1], 1, 50e18); // a new bettor in C: the next night
        _at(108); // the night has closed (107 recorded)
        _bet(bettors[0], 2, 50e18); // its 105 bet is in night 0, so this is its next-night bet
        vm.prank(bettors[1]);
        vm.expectRevert(LightsOn.AlreadyBet.selector);
        lights.bet(3, 50e18); // its C bet already is the next night's
        _active(110, 112);
        _at(120);
        _settleAll();
        assertEq(lights.getNight(0).betEnd, 1, "only the 105 bet is in night 0");
        assertEq(lights.getNight(1).betEnd, 3, "the C bet and the 108 bet are in night 1");
        assertEq(lights.getBet(inC).night, 1);
        assertEq(_cls(inC), WIN, "bulb 1 lights in 111, five rounds after the bet");
        _checkAllNights();
    }

    // ------------------------------------------------------------ nights from rounds

    function test_nightShapeDepartureBulbsBreakBlackout() public {
        core.setActive(100, 400); // departure
        core.setActive(101, 400); // bulb 1
        core.setActive(102, 400); // bulb 2
        // 103 quiet: a break
        core.setActive(104, 400); // bulb 3
        core.setActive(105, 400); // bulb 4
        // 106, 107 quiet: blackout, C = 106
        _at(107);
        lights.poke(10);
        assertEq(lights.nightCount(), 0, "107 not recorded yet: the night is still open");
        (uint256 start, uint256 litSoFar, uint256 quiet) = lights.openNight();
        assertEq(start, 100);
        assertEq(litSoFar, 4);
        assertEq(quiet, 1);

        _at(108);
        vm.expectEmit(true, false, false, true, address(lights));
        emit LightsOn.NightClosed(0, 100, 106, 4, 0x37, 107, 105);
        lights.poke(10);
        LightsOn.Night memory n = lights.getNight(0);
        assertEq(n.start, 100);
        assertEq(n.c, 106);
        assertEq(n.spanEnd, 107);
        assertEq(n.lastBetRound, 105, "bets sent in C and C + 1 belong to the next night");
        assertEq(n.stops, 0x37); // bits 0,1,2,4,5
        assertEq(lights.lit(0), 4);
        assertEq(lights.litRound(0, 1), 101);
        assertEq(lights.litRound(0, 2), 102);
        assertEq(lights.litRound(0, 3), 104, "the break lights nothing");
        assertEq(lights.litRound(0, 4), 105);
        assertEq(lights.litRound(0, 5), 0);
        (start,,) = lights.openNight();
        assertEq(start, 0);
    }

    function test_falseStartIsANightThatRollsOver() public {
        _at(197);
        uint256 a = _bet(bettors[0], 1, 100e18);
        uint256 b = _bet(bettors[1], 5, 300e18);
        core.setActive(200, 50); // one round, then asleep
        _at(204);
        _settleAll();
        LightsOn.Night memory n = lights.getNight(0);
        assertEq(n.start, 200);
        assertEq(n.c, 201);
        assertEq(n.spanEnd, 202);
        assertEq(n.lastBetRound, 200);
        assertEq(lights.lit(0), 0, "a false start lights nothing");
        assertEq(n.result, ROLLED);
        assertEq(lights.bonusPot(), 400e18, "every stake rolls into the next night");
        assertEq(_cls(a), LOSE);
        assertEq(_cls(b), LOSE);
        assertEq(sqk.totalBurned(), 0, "nothing burned on a rollover");
        (uint256 pay, bool ready) = _due(a);
        assertEq(pay, 0);
        assertFalse(ready, "a rolled stake is not final while the pot rides");
        assertEq(_claim(a), 0);
        assertEq(lights.getBet(a).status, lights.COUNTED(), "claim skipped it");
    }

    function test_stationEndAndNextNight() public {
        _active(100, 140);
        core.setActive(150, 300);
        _at(97);
        uint256 b24 = _bet(bettors[0], 24, 100e18);
        uint256 b1 = _bet(bettors[1], 1, 100e18);
        _at(135); // the STATION round: no quiet rounds end this night, so the bet stays in it
        uint256 last = _bet(bettors[2], 24, 50e18);
        _at(136);
        uint256 next = _bet(bettors[3], 24, 50e18); // the next night departs in 136
        _at(137); // round 136 recorded
        lights.poke(10);
        assertEq(lights.nightCount(), 1, "STATION closes the night at its 36th round");
        LightsOn.Night memory n = lights.getNight(0);
        assertEq(n.c, 0);
        assertEq(n.spanEnd, 135);
        assertEq(n.lastBetRound, 135);
        assertEq(lights.lit(0), 35);
        (uint256 start,,) = lights.openNight();
        assertEq(start, 136, "the next active round departs again");
        _at(155);
        _settleAll();
        assertEq(lights.getNight(1).start, 136);
        assertEq(lights.getNight(1).c, 141);
        assertEq(lights.lit(1), 4);
        // both bulbs lit, nobody lost, no pot: nothing burns, and the two stakes are shared 24 : 1
        assertEq(lights.getNight(0).result, PAID);
        assertEq(lights.getNight(0).burned, 0);
        assertEq(_claim(b24), 192e18);
        assertEq(_claim(b1), 8e18, "a lit bulb 1 gets back less than its stake");
        assertEq(_cls(last), REFUND, "bulb 24 lit long before the STATION round");
        assertEq(lights.getBet(last).litBefore, 34);
        assertEq(_claim(last), 50e18);
        assertEq(lights.getBet(next).night, 1);
        assertEq(_cls(next), LOSE);
        assertEq(lights.nightCount(), 3);
        assertEq(lights.getNight(2).start, 150);
        assertEq(lights.lit(2), 0, "150 alone was a false start");
    }

    function test_blackoutPairOnTheLastStationRounds() public {
        _active(100, 133); // 134 and 135 quiet: both inside the 36 rounds [100, 135]
        _at(140);
        lights.poke(10);
        assertEq(lights.getNight(0).c, 134, "a blackout, not a STATION end");
        assertEq(lights.getNight(0).spanEnd, 135);
        assertEq(lights.getNight(0).lastBetRound, 133);

        _deploy(36);
        _active(100, 134); // 135 quiet, 136 is outside the night
        _at(140);
        lights.poke(10);
        assertEq(lights.getNight(0).c, 0, "the pair would end outside: STATION end");
        assertEq(lights.getNight(0).spanEnd, 135);
        assertEq(lights.getNight(0).lastBetRound, 135);
        assertEq(lights.lit(0), 34);
    }

    function test_walkerNeverReadsPastCertified() public {
        _active(100, 108);
        vm.warp(G + 109 * 600 + 100); // round 110 in progress
        core.setSettled(103);
        lights.poke(10);
        assertEq(lights.getWalker().cursor, 103, "stops at certifiedThrough");
        (uint256 start, uint256 litSoFar,) = lights.openNight();
        assertEq(start, 100);
        assertEq(litSoFar, 3);

        core.setSettled(130); // a core that claims rounds that have not ended
        lights.poke(10);
        assertEq(lights.getWalker().cursor, 109, "never a round that has not ended");

        // a malformed page (certified past `through`) is not read at all
        _deploy(36);
        _active(100, 108);
        _at(120);
        core.setEvil(1);
        assertEq(lights.poke(10), 0);
        assertEq(lights.getWalker().cursor, 0);
        assertFalse(lights.stalled(), "a bad page is a stall only once it has lasted 144 rounds");
        uint256 snap = vm.snapshotState();
        vm.warp(G + 145 * 600 + 100); // round 146: 145 rounds ended since the walker's cursor (0)
        assertTrue(lights.stalled(), "bad pages for 145 rounds");
        vm.revertToState(snap);
        core.setEvil(2);
        assertEq(lights.poke(10), 0, "records out of order");
        core.setEvil(0);
        assertGt(lights.poke(10), 0);
    }

    function test_walkerPagesOverFullPages() public {
        // 40 active rounds in a row cross pages of 16 records; STATION cuts the night at 36
        _active(100, 139);
        _at(150);
        assertEq(lights.poke(1), 1);
        assertEq(lights.getWalker().cursor, 115, "first page: 16 records, certified up to the 17th minus 1");
        lights.poke(10);
        assertEq(lights.nightCount(), 2);
        assertEq(lights.getNight(1).start, 136);
        assertEq(lights.getNight(1).c, 140);
    }

    function test_isIdle() public {
        core.setActive(101, 10);
        _at(110);
        assertTrue(lights.isIdle(100));
        assertFalse(lights.isIdle(101));
        assertTrue(lights.isIdle(102));
        vm.expectRevert(LightsOn.NotSettled.selector);
        lights.isIdle(110);
    }

    // ------------------------------------------------------------ settlement

    /// 2 winners, 2 losers, numbers by hand: pot 700 (all four stakes), burn 2% of the 300 lost = 6, and the
    /// winners share 694 by stake x bulb (200 : 900).
    function test_normalNightByHand() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        uint256 b = _bet(bettors[1], 3, 300e18);
        uint256 c = _bet(bettors[2], 6, 100e18);
        uint256 d = _bet(bettors[3], 8, 200e18);
        _active(100, 105); // lit 5
        _at(110);
        _settleAll();
        LightsOn.Night memory n = lights.getNight(0);
        assertEq(n.result, PAID);
        assertEq(n.sumW, 1100e18);
        assertEq(n.winStake, 400e18);
        assertEq(n.loseStake, 300e18);
        assertEq(n.burned, 6e18);
        assertEq(sqk.totalBurned(), 6e18, "2% of the losers' stakes burned with SQK.burn");
        assertEq(_claim(a), 126181818181818181818); // 694 * 200 / 1100
        assertEq(_claim(b), 567818181818181818182);
        assertEq(_claim(c), 0);
        assertEq(_claim(d), 0);
        assertEq(sqk.balanceOf(address(lights)), 0, "everything paid or burned");
        _checkAllNights();
    }

    /// v2: no "nobody lost, stakes back" rule. With no losers and no pot, nothing burns and the winners share their
    /// own 360 by weight (100 : 1000 : 50), so the short bulb gets back less than it staked.
    function test_nobodyLostNoPotWinnersRedistribute() public {
        _at(97);
        uint256 a = _bet(bettors[0], 1, 100e18);
        uint256 b = _bet(bettors[1], 4, 250e18);
        uint256 c = _bet(bettors[2], 5, 10e18);
        _active(100, 105);
        _at(110);
        _settleAll();
        assertEq(lights.getNight(0).result, PAID);
        assertEq(lights.getNight(0).burned, 0);
        assertEq(_claim(a), 31304347826086956521); // 360 * 100 / 1150
        assertEq(_claim(b), 313043478260869565218);
        assertEq(_claim(c), 15652173913043478261);
        assertEq(sqk.totalBurned(), 0);
        assertEq(lights.bonusPot(), 0);
        assertEq(sqk.balanceOf(address(lights)), 0);
        _checkAllNights();
    }

    /// A marathon (lit 15): the short bulbs lit but the long ones take most of the pot. Bulb 1 staked 1,000 and gets
    /// 289.8 back. Pot 1,450, burn 2% of the 50 lost = 1, weights 1,000 : 200 : 2,400 : 1,400.
    function test_marathonShortBulbGetsBackLessThanItsStake() public {
        _at(97);
        uint256 a = _bet(bettors[0], 1, 1000e18);
        uint256 b = _bet(bettors[1], 2, 100e18);
        uint256 c = _bet(bettors[2], 12, 200e18);
        _at(98);
        uint256 d = _bet(bettors[3], 14, 100e18);
        uint256 e = _bet(bettors[4], 20, 50e18);
        _active(100, 115);
        _at(120);
        _settleAll();
        assertEq(lights.getNight(0).burned, 1e18);
        assertEq(_cls(a), WIN);
        assertEq(_claim(a), 289.8e18, "lit, and still less than its stake");
        assertEq(_claim(b), 57.96e18);
        assertEq(_claim(c), 695.52e18);
        assertEq(_claim(d), 405.72e18);
        assertEq(_claim(e), 0);
        assertEq(sqk.balanceOf(address(lights)), 0);
        _checkAllNights();
    }

    /// Fix A: the same bulb and stake, sent after 3 bulbs lit, weighs 100 x (8 - 3) instead of 100 x 8.
    function test_lateBetWeighsOnlyTheBulbsStillDark() public {
        _active(100, 110); // lit 10
        _at(97);
        uint256 early = _bet(bettors[0], 8, 100e18);
        uint256 dark = _bet(bettors[1], 15, 100e18);
        _at(104); // bulbs 1-3 lit in 101-103; bulb 8 lights in 108 = N + 4
        uint256 late = _bet(bettors[2], 8, 100e18);
        _at(120);
        _settleAll();
        assertEq(lights.getBet(early).litBefore, 0);
        assertEq(lights.getBet(late).litBefore, 3);
        assertEq(lights.getNight(0).sumW, 1300e18);
        // pot 300, burn 2, 298 split 800 : 500
        assertEq(_claim(early), 183384615384615384615);
        assertEq(_claim(late), 114615384615384615385);
        assertEq(_claim(dark), 0);
        _checkAllNights();
    }

    function test_rolloverThenBonusPotWonNextNight() public {
        _at(97);
        uint256 a = _bet(bettors[0], 7, 100e18);
        uint256 b = _bet(bettors[1], 9, 500e18);
        _active(100, 103); // lit 3: nobody won
        _at(110);
        uint256 c = _bet(bettors[0], 2, 100e18); // night 0 is over, so this is the next night
        uint256 d = _bet(bettors[2], 4, 100e18);
        uint256 e = _bet(bettors[3], 12, 400e18);
        _active(120, 125); // lit 5: c and d win, e loses
        _at(130);
        _settleAll();

        assertEq(lights.getNight(0).result, ROLLED);
        LightsOn.Night memory n1 = lights.getNight(1);
        assertEq(n1.bonusIn, 600e18, "both stakes of night 0");
        assertEq(n1.result, PAID);
        // pot = 600 staked + 600 bonus, burn 2% of (400 lost + 600 bonus) = 20, 1180 split 200 : 400
        assertEq(n1.burned, 20e18);
        assertEq(_claim(c), 393333333333333333333);
        assertEq(_claim(d), 786666666666666666667);
        assertEq(_claim(e), 0);
        assertEq(lights.bonusPot(), 0);
        assertEq(lights.consumedBefore(), 1);
        // the rolled losers' stakes were won: their claims settle at 0
        (uint256 pay, bool ready) = _due(a);
        assertEq(pay, 0);
        assertTrue(ready);
        assertEq(_claim(a), 0);
        assertEq(_claim(b), 0);
        assertEq(lights.getBet(a).status, lights.CLAIMED());
        assertEq(sqk.balanceOf(address(lights)), 0);
        _checkAllNights();
    }

    function test_bonusPotWithOnlyWinnersIsPaidOut() public {
        _at(97);
        _bet(bettors[0], 3, 1000e18);
        core.setActive(100, 10); // false start
        _at(105);
        uint256 a = _bet(bettors[1], 1, 100e18);
        uint256 b = _bet(bettors[2], 3, 100e18);
        _active(110, 115);
        _at(120);
        _settleAll();
        LightsOn.Night memory n = lights.getNight(1);
        assertEq(n.result, PAID, "no losers, but a bonus pot: winners share it");
        assertEq(n.bonusIn, 1000e18);
        assertEq(n.burned, 20e18, "2% of the bonus pot");
        assertEq(_claim(a), 295e18); // 1180 * 100 / 400
        assertEq(_claim(b), 885e18);
        _checkAllNights();
    }

    function test_emptyNightCarriesThePotUntouched() public {
        _at(97);
        _bet(bettors[0], 9, 300e18);
        _active(100, 102); // night 0: lit 2, rolls 300
        _active(110, 115); // night 1: no bets, the pot rolls on
        _at(120);
        uint256 w = _bet(bettors[1], 1, 50e18);
        _active(125, 127); // night 2: lit 2, w wins the pot alone
        _at(135);
        _settleAll();
        assertEq(lights.nightCount(), 3);
        assertEq(lights.getNight(1).result, ROLLED);
        assertEq(lights.getNight(1).bonusIn, 300e18);
        assertEq(lights.getNight(2).bonusIn, 300e18);
        assertEq(_claim(w), 344e18, "its stake + the 300 pot, less 2% of the pot");
        assertEq(sqk.totalBurned(), 6e18);
        _checkAllNights();
    }

    /// The "two rounds ahead" rule, checked bet by bet on one night: departure 100, bulb k lights in round 100+k.
    function test_twoRoundsAheadRule() public {
        _active(100, 110); // lit 10, C = 111
        _at(99);
        uint256 pre = _bet(bettors[0], 1, 100e18); // before he starts: bulb 1 lights in 101 = 99 + 2
        _at(100);
        uint256 dep1 = _bet(bettors[1], 1, 100e18); // departure round: bulb 1 lights in 101 = N + 1
        uint256 dep2 = _bet(bettors[2], 2, 100e18); // bulb 2 lights in 102 = N + 2
        _at(103);
        uint256 inProgress = _bet(bettors[3], 3, 100e18); // lights in the round it was sent in
        uint256 next = _bet(bettors[4], 4, 100e18); // N + 1
        uint256 twoAhead = _bet(bettors[5], 5, 100e18); // N + 2
        uint256 old = _bet(bettors[6], 1, 100e18); // lit long ago
        uint256 dark = _bet(bettors[8], 20, 100e18);
        _late(103);
        uint256 lateBand = _bet(bettors[7], 5, 100e18); // counts as round 104: bulb 5 in 105 = N + 1
        _at(120);
        _settleAll();
        assertEq(_cls(pre), WIN, "pre-start bet on bulb 1");
        assertEq(_cls(dep1), REFUND, "departure-round bet on bulb 1");
        assertEq(_cls(dep2), WIN);
        assertEq(_cls(inProgress), REFUND);
        assertEq(_cls(next), REFUND);
        assertEq(_cls(twoAhead), WIN);
        assertEq(_cls(old), REFUND);
        assertEq(_cls(lateBand), REFUND, "guard band");
        assertEq(_cls(dark), LOSE);
        assertEq(_claim(dep1), 100e18, "a refund is the stake, exactly");
        assertEq(_claim(next), 100e18);
        // weights: pre 100 x 1, dep2 100 x 2, twoAhead 100 x (5 - 2 lit before 103); pot 400, burn 2, pool 398
        assertEq(lights.getBet(twoAhead).litBefore, 2);
        assertEq(lights.getBet(lateBand).litBefore, 3, "the guard band moves the bet to 104");
        assertEq(_claim(pre), 66333333333333333333, "lit, but a short bulb on a long night: less than its stake");
        assertEq(_claim(dep2), 132666666666666666667);
        assertEq(_claim(twoAhead), 199e18);
        _checkAllNights();
    }

    function test_twoRoundsAheadAcrossABreak() public {
        core.setActive(100, 300);
        core.setActive(101, 300); // bulb 1
        // 102 is a break
        core.setActive(103, 300); // bulb 2
        core.setActive(104, 300); // bulb 3
        _at(101);
        uint256 a = _bet(bettors[0], 2, 100e18); // bulb 2 lights in 103 = N + 2
        uint256 b = _bet(bettors[1], 9, 100e18);
        _at(102);
        uint256 c = _bet(bettors[2], 2, 100e18); // N + 1, sent in the break: still this night
        _at(110);
        _settleAll();
        assertEq(_cls(a), WIN);
        assertEq(_cls(b), LOSE);
        assertEq(_cls(c), REFUND);
        assertEq(lights.getBet(c).night, 0, "a single quiet round is a break, not a blackout");
        assertEq(lights.getBet(c).litBefore, 1);
        assertEq(_claim(a), 198e18);
    }

    function test_refundedBetInANightNobodyWon() public {
        _active(100, 103); // lit 3
        _at(97);
        uint256 a = _bet(bettors[0], 5, 100e18);
        uint256 b = _bet(bettors[1], 6, 200e18);
        _at(102);
        uint256 late = _bet(bettors[2], 3, 70e18); // bulb 3 lights in 103 = N + 1
        _at(110);
        _settleAll();
        assertEq(lights.getNight(0).result, ROLLED);
        assertEq(_cls(late), REFUND);
        assertEq(_claim(late), 70e18, "a bet that did not count is refunded even when nobody won");
        assertEq(lights.bonusPot(), 300e18, "only the counted stakes roll");
        assertEq(_cls(a), LOSE);
        assertEq(_cls(b), LOSE);
    }

    /// v2: bets sent in the two quiet rounds that end a night (C and C + 1) belong to the next night.
    function test_betsDuringTheBlackoutPairJoinTheNextNight() public {
        _at(97);
        uint256 w = _bet(bettors[0], 2, 100e18);
        _active(100, 104); // lit 4, C = 105
        _at(105);
        uint256 inC = _bet(bettors[1], 1, 100e18); // in the ending night this would be refunded (bulb 1 lit in 101)
        _at(106);
        uint256 inC1 = _bet(bettors[2], 3, 100e18);
        _at(107);
        uint256 after_ = _bet(bettors[3], 9, 100e18);
        assertEq(lights.nightCount(), 1, "the blackout is known");
        _settleAll();
        assertEq(lights.getNight(0).betEnd, 1, "only the bet sent before C");
        assertEq(lights.getBet(inC).status, lights.WAITING(), "C: the next night");
        assertEq(lights.getBet(inC1).status, lights.WAITING(), "C + 1: the next night");
        assertEq(_claim(w), 100e18, "alone in its night: its own stake back");
        _active(108, 110); // he leaves again right away: departure 108, bulbs in 109 and 110
        _at(115);
        _settleAll();
        assertEq(lights.getNight(1).start, 108);
        assertEq(lights.getNight(1).betEnd, 4);
        assertEq(_cls(inC), WIN, "bulb 1 lights in 109, four rounds after the bet");
        assertEq(lights.getBet(inC).litBefore, 0, "sent before he started");
        assertEq(_cls(inC1), LOSE);
        assertEq(_cls(after_), LOSE);
        assertEq(_claim(inC), 296e18, "pot 300, burn 2% of the 200 lost");
        assertEq(sqk.balanceOf(address(lights)), 0);
        _checkAllNights();
    }

    function test_pagedSettleEqualsOneShot() public {
        _at(95);
        for (uint256 i; i < 13; ++i) {
            _bet(bettors[i], uint8(1 + (i * 5) % 24), 10e18 + i * 37e18 + i);
        }
        _active(100, 108);
        _at(112);
        for (uint256 i; i < 7; ++i) {
            _bet(bettors[i], uint8(2 + i), 33e18 + i);
        }
        core.setActive(115, 10); // false start
        _at(120);
        for (uint256 i = 7; i < 20; ++i) {
            _bet(bettors[i], uint8(1 + i % 6), 15e18 + i * 1e17);
        }
        _active(125, 131);
        _at(140);
        lights.poke(100);
        assertEq(lights.nightCount(), 3);
        uint256 left = (lights.betCount() - lights.betCursor()) + (lights.nightCount() - lights.nextSettle());
        assertGt(left, 10, "the bets' own cranks left work to do");
        uint256 calls;
        while (lights.nextSettle() < lights.nightCount()) {
            lights.settle(1);
            ++calls;
        }
        assertEq(calls, left, "one unit of work per bet and per night");
        _checkAllNights();
        assertEq(lights.getNight(1).result, ROLLED);
        assertGt(lights.getNight(2).bonusIn, 0);
    }

    // ------------------------------------------------------------ claims

    function test_anyoneClaimsMoneyGoesToOwner() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        uint256 before = sqk.balanceOf(bettors[0]);
        uint256[] memory ids = new uint256[](3);
        ids[0] = a;
        ids[1] = a;
        ids[2] = 999;
        vm.prank(address(0xD00D));
        uint256 done = lights.claim(ids);
        assertEq(done, 1, "a double claim and an unknown id are skipped");
        assertEq(sqk.balanceOf(bettors[0]), before + 198e18);
        assertEq(sqk.balanceOf(address(0xD00D)), 0);
    }

    function test_claimBeforeSettlementSkips() public {
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _active(100, 104);
        _at(103);
        assertEq(_claim(a), 0);
        assertEq(lights.getBet(a).status, lights.WAITING());
    }

    // ------------------------------------------------------------ burn

    function test_burnFallsBackToDead() public {
        sqk.setBurnReverts(true);
        _at(97);
        _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        assertEq(sqk.balanceOf(lights.DEAD()), 2e18);
        assertEq(sqk.totalBurned(), 0);
    }

    function test_burnAndDeadBothFail() public {
        sqk.setBurnReverts(true);
        sqk.setDeadTransferFails(true);
        _at(97);
        uint256 a = _bet(bettors[0], 2, 100e18);
        _bet(bettors[1], 9, 100e18);
        _active(100, 104);
        _at(110);
        _settleAll();
        assertEq(lights.unburned(), 2e18);
        _claim(a);
        assertEq(sqk.balanceOf(address(lights)), 2e18, "only the unburned 2% stays");
    }

    // ------------------------------------------------------------ stall and void

    function _stallAndVoid() internal {
        core.setReverting(true);
        assertFalse(lights.stalled(), "just went down: not a stall yet");
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();
        _coreDownForAStall();
        lights.flagStall();
        vm.expectRevert(LightsOn.TooEarly.selector);
        lights.void();
        vm.warp(block.timestamp + 1 days);
        lights.void();
        assertTrue(lights.voided());
    }

    function test_voidRefundsTheOpenNightAndItsBonusPot() public {
        _at(97);
        uint256 l0 = _bet(bettors[0], 9, 100e18);
        uint256 l1 = _bet(bettors[1], 12, 250e18);
        _active(100, 102); // night 0 rolls 350
        _at(110);
        uint256 l2 = _bet(bettors[2], 1, 40e18);
        core.setActive(115, 10); // night 1 is a false start: rolls 390
        _at(120);
        uint256 o0 = _bet(bettors[0], 3, 500e18); // the open night, which will be voided
        uint256 o1 = _bet(bettors[3], 4, 60e18);
        _active(125, 127);
        _at(129);
        _settleAll();
        assertEq(lights.bonusPot(), 390e18);
        (uint256 start,,) = lights.openNight();
        assertEq(start, 125);

        uint256 contractBefore = sqk.balanceOf(address(lights));
        _stallAndVoid();
        assertEq(_claim(o0), 500e18);
        assertEq(_claim(o1), 60e18);
        assertEq(_claim(l0), 100e18, "the bonus pot goes back to the bets it came from");
        assertEq(_claim(l1), 250e18);
        assertEq(_claim(l2), 40e18);
        assertEq(lights.bonusPot(), 0);
        assertEq(contractBefore, 950e18);
        assertEq(sqk.balanceOf(address(lights)), 0, "nothing stuck");
        assertEq(lights.getBet(o0).status, lights.REFUNDED());

        vm.prank(bettors[5]);
        vm.expectRevert(LightsOn.IsVoided.selector);
        lights.bet(3, 50e18);
        assertEq(lights.poke(5), 0);
        assertEq(lights.settle(5), 0);
        vm.expectRevert(LightsOn.IsVoided.selector);
        lights.void();
        vm.expectRevert(LightsOn.IsVoided.selector);
        lights.flagStall();
    }

    function test_voidKeepsSettledNightsAndAWonPot() public {
        _at(97);
        uint256 l0 = _bet(bettors[0], 9, 100e18);
        _active(100, 102); // rolls 100
        _at(110);
        uint256 w = _bet(bettors[1], 1, 100e18);
        _active(115, 117); // w wins the 100 pot
        _at(120);
        uint256 o = _bet(bettors[2], 2, 80e18);
        _settleAll();
        _stallAndVoid();
        assertEq(_claim(w), 100e18 + 98e18, "a settled night pays as settled");
        assertEq(_claim(l0), 0, "its pot was won before the void");
        assertEq(_claim(o), 80e18);
        assertEq(sqk.balanceOf(address(lights)), 0);
    }

    function test_voidNeedsClosedNightsSettledFirst() public {
        _at(95);
        uint256 first;
        for (uint256 i; i < 12; ++i) {
            uint256 id = _bet(bettors[i], uint8(i + 1), 50e18);
            if (i == 0) first = id;
        }
        _active(100, 105);
        _at(110);
        lights.poke(10); // night closed, but nobody has settled its 12 bets
        _coreDownForAStall();
        lights.flagStall();
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(LightsOn.SettleFirst.selector);
        lights.void();
        lights.settle(100);
        lights.void();
        // bulbs 1..5 lit: pot 600, 7 x 50 lost, 7 burned, 593 split by bulb over a weight of 50 x 15; bulb 1 is
        // first and gets back less than its 50
        assertEq(_claim(first), uint256(50e18) * 593e18 / 750e18);
        assertLt(uint256(50e18) * 593e18 / 750e18, 50e18);
        _checkAllNights();
    }

    function test_voidClearsWhenTheCoreRecovers() public {
        _at(97);
        _bet(bettors[0], 2, 100e18);
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();
        _coreDownForAStall();
        lights.flagStall();
        core.setReverting(false);
        vm.warp(block.timestamp + 1 days);
        core.setSettled(uint64(lights.currentRound() - 1));
        lights.void();
        assertFalse(lights.voided());
        assertEq(lights.stallFlaggedAt(), 0);
        assertEq(lights.stallMark(), 0);
        vm.expectRevert(LightsOn.NotStalled.selector);
        lights.flagStall();
    }

    /// The spec: the core is stalled once it has stopped settling, or can't be read, for 144 rounds. A pause, a
    /// revert or a bad page on its own is not a stall.
    function test_stallReasons() public {
        _at(97);
        assertFalse(lights.stalled());
        core.setPaused(true);
        assertFalse(lights.stalled(), "a pause alone is not a stall");
        core.setPaused(false);
        core.setReverting(true);
        assertFalse(lights.stalled(), "a revert alone is not a stall");
        core.setReverting(false);
        vm.warp(G + (96 + 144) * 600 + 100); // round 241: 240 ended, settled 96, exactly 144 behind
        assertFalse(lights.stalled(), "exactly 144 rounds behind is not a stall yet");
        vm.warp(G + (97 + 144) * 600 + 100);
        assertTrue(lights.stalled(), "145 rounds behind");

        // can't be read: counted from the last round the walker read
        _at(300);
        lights.poke(100);
        assertEq(lights.getWalker().cursor, 299);
        vm.mockCall(address(core), abi.encodeWithSelector(MockCore.state.selector), bytes("not eight words"));
        vm.warp(G + (299 + 144) * 600 + 100);
        assertFalse(lights.stalled(), "a reply it can't read, for 144 rounds");
        vm.warp(G + (300 + 144) * 600 + 100);
        assertTrue(lights.stalled(), "a reply it can't read, for 145 rounds");
        vm.clearMockedCalls();
    }
}
