// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RoundPage, RoundRecord, LedgerPosition} from "../../src/ISqueek.sol";

/// SqueekCore stand-in with the on-chain roundPage semantics from docs/claims-check.md:
/// active rounds only, at most 16 records, one revert for every bad bound (including through > settled), and
/// certifiedThrough = (first active round that did not fit) - 1, or throughRound if everything fit.
contract MockCore {
    error InvalidRoundPageBounds();

    uint64 public settled;
    bool public paused;
    bool public reverting;
    uint8 public evil; // 1: certify past through, 2: records out of order

    uint64[] public activeList; // ascending
    mapping(uint64 => uint64) public workOf;
    mapping(uint64 => uint64) public cumulativeOf; // cumulative work after an active round

    function setActive(uint64 r, uint64 w) public {
        uint256 n = activeList.length;
        require(w > 0 && (n == 0 || r > activeList[n - 1]), "ascending");
        uint64 prevCum = n == 0 ? 0 : cumulativeOf[activeList[n - 1]];
        activeList.push(r);
        workOf[r] = w;
        cumulativeOf[r] = prevCum + w;
    }

    function setActiveRange(uint64 from, uint64 to) external {
        for (uint64 r = from; r <= to; ++r) {
            setActive(r, 500);
        }
    }

    function setSettled(uint64 s) external {
        settled = s;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function setEvil(uint8 e) external {
        evil = e;
    }

    function activeCount() external view returns (uint256) {
        return activeList.length;
    }

    function state() external view returns (uint64, uint64, uint96, uint64, uint96, uint32, uint256, bool) {
        require(!reverting, "core down");
        return (settled, _position(settled).cumulativeWork, 0, 0, 0, 10_000, 0, paused);
    }

    function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords)
        external
        view
        returns (RoundPage memory p)
    {
        require(!reverting, "core down");
        if (maxRecords > 16 || afterRound > throughRound || throughRound > settled) revert InvalidRoundPageBounds();

        uint256 i = _firstAbove(afterRound);
        RoundRecord[] memory recs = new RoundRecord[](maxRecords);
        uint256 count;
        uint64 cert = throughRound;
        while (i < activeList.length && activeList[i] <= throughRound) {
            uint64 r = activeList[i];
            if (count == maxRecords) {
                cert = r - 1;
                break;
            }
            recs[count++] = RoundRecord({
                roundId: r,
                cumulativeWork: cumulativeOf[r],
                cumulativeBlockUnits: uint96(cumulativeOf[r]) * 1e6,
                workPerThousandBlocks: 10_000,
                dataHash: keccak256(abi.encode(r))
            });
            ++i;
        }
        assembly {
            mstore(recs, count)
        }
        if (evil == 1) cert = throughRound + 1;
        if (evil == 2 && count >= 2) (recs[0], recs[1]) = (recs[1], recs[0]);
        p.certifiedThroughRound = cert;
        p.start = _position(afterRound);
        p.end = _position(cert);
        p.rounds = recs;
    }

    function _firstAbove(uint64 r) internal view returns (uint256 lo) {
        uint256 hi = activeList.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (activeList[mid] <= r) lo = mid + 1;
            else hi = mid;
        }
    }

    function _position(uint64 r) internal view returns (LedgerPosition memory pos) {
        uint256 i = _firstAbove(r);
        if (i == 0) return LedgerPosition(0, 0, 10_000);
        uint64 cum = cumulativeOf[activeList[i - 1]];
        return LedgerPosition(cum, uint96(cum) * 1e6, 10_000);
    }
}

/// Minimal SQK: ERC-20 with burn(uint256) and totalBurned, plus switches to break burn or transfer-to-dEaD.
contract MockSQK {
    string public constant name = "Squeek";
    string public constant symbol = "SQK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public totalBurned;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public burnReverts;
    bool public deadTransferFails;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function setBurnReverts(bool b) external {
        burnReverts = b;
    }

    function setDeadTransferFails(bool b) external {
        deadTransferFails = b;
    }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        if (deadTransferFails && to == address(0xdEaD)) revert("dead blocked");
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - v;
        _move(from, to, v);
        return true;
    }

    function burn(uint256 v) external {
        require(!burnReverts, "burn off");
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        totalSupply -= v;
        totalBurned += v;
        emit Transfer(msg.sender, address(0), v);
    }

    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v;
        balanceOf[to] += v;
        emit Transfer(from, to, v);
    }
}

contract MockGenesis {
    error ERC721NonexistentToken(uint256 tokenId);

    mapping(uint256 => address) internal _owner;
    mapping(uint256 => uint8) internal _level;

    function mint(address to, uint256 id, uint8 lvl) external {
        _owner[id] = to;
        _level[id] = lvl;
    }

    function setOwner(uint256 id, address to) external {
        _owner[id] = to;
    }

    function ownerOf(uint256 id) external view returns (address o) {
        o = _owner[id];
        if (o == address(0)) revert ERC721NonexistentToken(id);
    }

    function level(uint256 id) external view returns (uint8) {
        if (_owner[id] == address(0)) revert ERC721NonexistentToken(id);
        return _level[id];
    }
}

contract MockStaking {
    MockGenesis public immutable genesis;
    mapping(address => mapping(uint256 => address)) public depositor;

    constructor(MockGenesis g) {
        genesis = g;
    }

    /// Test helper: custody moves to staking, depositor recorded (as deposit() does on-chain).
    function stakeFor(address account, uint256 id) external {
        genesis.setOwner(id, address(this));
        depositor[address(genesis)][id] = account;
    }
}
