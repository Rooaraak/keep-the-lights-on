// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Shapes verified against Sepolia on 2026-10-31 (docs/claims-check.md).

struct LedgerPosition {
    uint64 cumulativeWork;
    uint96 cumulativeBlockUnits;
    uint32 workPerThousandBlocks;
}

struct RoundRecord {
    uint64 roundId;
    uint64 cumulativeWork;
    uint96 cumulativeBlockUnits;
    uint32 workPerThousandBlocks;
    bytes32 dataHash;
}

struct RoundPage {
    uint64 certifiedThroughRound;
    LedgerPosition start;
    LedgerPosition end;
    RoundRecord[] rounds;
}

interface ISqueekCore {
    function state()
        external
        view
        returns (
            uint64 settledThroughRound,
            uint64 cumulativeWork,
            uint96 cumulativeBlockUnits,
            uint64 blockHeight,
            uint96 blockProgress,
            uint32 workPerThousandBlocks,
            uint256 authorizationNonce,
            bool paused
        );

    /// Active rounds only; maxRecords <= 16; reverts InvalidRoundPageBounds() if through > settled or after > through.
    function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords)
        external
        view
        returns (RoundPage memory);
}

interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISQK is IERC20Min {
    function burn(uint256 amount) external;
}

interface IGenesis {
    function ownerOf(uint256 tokenId) external view returns (address);
    function level(uint256 tokenId) external view returns (uint8);
}

interface IStaking {
    function depositor(address collection, uint256 tokenId) external view returns (address);
}
