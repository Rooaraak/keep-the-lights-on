// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// Where the shared data files (rounds, rides, vectors) are: data/ next to the Foundry project when it is the
/// repository root (the public layout), or ../data when the project is contracts/ (this repository's own layout).
library DataPath {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function file(string memory name) internal view returns (string memory) {
        string memory here = string.concat(vm.projectRoot(), "/data/", name);
        if (vm.exists(here)) return here;
        return string.concat(vm.projectRoot(), "/../data/", name);
    }
}
