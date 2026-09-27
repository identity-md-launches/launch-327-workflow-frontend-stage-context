// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A minimal position-NFT ownership mock, installed at COLLECTION with vm.etch.
contract MockCollection {
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 id) external {
        require(to != address(0) && ownerOf[id] == address(0));
        ownerOf[id] = to;
        balanceOf[to]++;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(msg.sender == from && ownerOf[id] == from && to != address(0));
        ownerOf[id] = to;
        balanceOf[from]--;
        balanceOf[to]++;
    }
}

contract RevertingCollection {
    fallback() external {
        revert("unavailable");
    }
}

contract GasBurningCollection {
    fallback() external {
        assembly {
            for {} 1 {} {}
        }
    }
}

contract MalformedCollection {
    uint256 private immutable length;

    constructor(uint256 length_) {
        length = length_;
    }

    fallback() external {
        uint256 size = length;
        assembly {
            mstore(0, 1)
            return(0, size)
        }
    }
}
