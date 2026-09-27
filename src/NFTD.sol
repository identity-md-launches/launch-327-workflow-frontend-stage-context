// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Holder Discount: a fixed, eighteen-decimal supply minted once to its deployer.
/// @dev The launch factory receives the entire supply. There are no privileged or minting entrypoints.
contract NFTD is ERC20 {
    constructor() ERC20("Holder Discount", "NFTD") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}
