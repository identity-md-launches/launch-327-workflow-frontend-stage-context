// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {NFTD} from "../src/NFTD.sol";

contract NFTDTest is Test {
    NFTD internal token;
    address internal constant USER = address(0xCAFE);
    address internal constant SPENDER = address(0xBEEF);
    uint256 internal constant SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        token = new NFTD();
    }

    function test_metadataAndEntireFixedSupplyAtDeployer() public view {
        assertEq(token.name(), "Holder Discount");
        assertEq(token.symbol(), "NFTD");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(address(this)), SUPPLY);
    }

    function testFuzz_transferConservesSupply(uint256 amount) public {
        amount = bound(amount, 0, SUPPLY);
        assertTrue(token.transfer(USER, amount));
        assertEq(token.balanceOf(USER), amount);
        assertEq(token.balanceOf(address(this)), SUPPLY - amount);
        assertEq(token.totalSupply(), SUPPLY);
        vm.prank(USER);
        token.transfer(USER, amount);
        assertEq(token.balanceOf(USER), amount);
    }

    function test_allowanceSpendingAndUnlimitedApproval() public {
        token.approve(SPENDER, 10 ether);
        vm.prank(SPENDER);
        assertTrue(token.transferFrom(address(this), USER, 4 ether));
        assertEq(token.allowance(address(this), SPENDER), 6 ether);
        assertEq(token.balanceOf(USER), 4 ether);
        token.approve(SPENDER, type(uint256).max);
        vm.prank(SPENDER);
        token.transferFrom(address(this), USER, 1 ether);
        assertEq(token.allowance(address(this), SPENDER), type(uint256).max);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_invalidTransfersAndApprovals() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.transfer(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidSpender.selector, address(0)));
        token.approve(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, USER, 0, 1));
        vm.prank(USER);
        token.transfer(SPENDER, 1);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, SPENDER, 0, 1));
        vm.prank(SPENDER);
        token.transferFrom(address(this), USER, 1);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_noAdminMintOrUpgradeEntrypoints() public {
        string[12] memory signatures = [
            "mint(address,uint256)",
            "mint(uint256)",
            "mint()",
            "issue(uint256)",
            "setOwner(address)",
            "transferOwnership(address)",
            "upgradeTo(address)",
            "initialize(address)",
            "unpause()",
            "setMinter(address)",
            "burn(uint256)",
            "owner()"
        ];
        for (uint256 i; i < signatures.length; i++) {
            bytes memory data = abi.encodeWithSignature(signatures[i], USER, uint256(1));
            (bool deployerOk,) = address(token).call(data);
            assertFalse(deployerOk);
            vm.prank(USER);
            (bool userOk,) = address(token).call(data);
            assertFalse(userOk);
        }
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(address(this)), SUPPLY);
    }

    function test_runtimeHasNoEscapeOpcodes() public view {
        bytes memory runtime = address(token).code;
        assertGt(runtime.length, 0);
        for (uint256 i; i < runtime.length; i++) {
            uint8 op = uint8(runtime[i]);
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            else assertTrue(op != 0xff && op != 0xf4 && op != 0xf2);
        }
    }
}
