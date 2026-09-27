// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookFixture} from "./HookFixture.sol";
import {NFTD} from "../src/NFTD.sol";
import {NFTHolderDiscountHook} from "../src/NFTHolderDiscountHook.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";

contract HookHandler is Test {
    NFTHolderDiscountHook internal hook;
    PoolSwapTest internal router;
    PoolKey[2] internal keys;

    constructor(NFTHolderDiscountHook hook_, PoolSwapTest router_, NFTD token, PoolKey memory a, PoolKey memory b) {
        hook = hook_;
        router = router_;
        keys[0] = a;
        keys[1] = b;
        token.approve(address(router), type(uint256).max);
    }

    function swap(bool secondPool, bool buy, bool exactInput, bool holder, uint96 rawAmount) external {
        uint256 amount = bound(rawAmount, 1000, 0.05 ether);
        SwapParams memory params = SwapParams(
            buy,
            exactInput ? -int256(amount) : int256(amount),
            buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        vm.prank(address(this), holder ? address(0xA11CE) : address(0xB0B));
        router.swap{value: buy ? 1 ether : 0}(
            keys[secondPool ? 1 : 0], params, PoolSwapTest.TestSettings(false, false), ""
        );
    }

    function donate(bool secondPool) external {
        hook.donateFees(keys[secondPool ? 1 : 0]);
    }

    receive() external payable {}
}

contract HookInvariantTest is HookFixture {
    using TransientStateLibrary for IPoolManager;

    PoolKey internal second;
    HookHandler internal handler;
    uint256 internal totalETH;
    uint256 internal totalNFTD;

    function setUp() public override {
        super.setUp();
        seed(key, -600, 600, 1000 ether);
        second = key;
        second.fee = 10_000;
        manager.initialize(second, PRICE_1_1);
        seed(second, -600, 600, 1000 ether);
        handler = new HookHandler(hook, router, token, key, second);
        token.transfer(address(handler), 10_000 ether);
        vm.deal(address(handler), 1000 ether);
        totalETH = address(handler).balance + address(manager).balance;
        totalNFTD = token.balanceOf(address(handler)) + token.balanceOf(address(manager));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = HookHandler.swap.selector;
        selectors[1] = HookHandler.donate.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_claimsEqualAccruedAcrossPools() public view {
        (uint256 first0, uint256 first1) = hook.accrued(key.toId());
        (uint256 second0, uint256 second1) = hook.accrued(second.toId());
        assertEq(manager.balanceOf(address(hook), key.currency0.toId()), first0 + second0);
        assertEq(manager.balanceOf(address(hook), key.currency1.toId()), first1 + second1);
    }

    function invariant_noUnsettledDeltasOrHookCustody() public view {
        assertEq(manager.getNonzeroDeltaCount(), 0);
        assertFalse(manager.isUnlocked());
        assertEq(manager.currencyDelta(address(hook), key.currency0), 0);
        assertEq(manager.currencyDelta(address(hook), key.currency1), 0);
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function invariant_underlyingFundsAndTokenSupplyConserved() public view {
        assertEq(address(handler).balance + address(manager).balance, totalETH);
        assertEq(token.balanceOf(address(handler)) + token.balanceOf(address(manager)), totalNFTD);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }
}
