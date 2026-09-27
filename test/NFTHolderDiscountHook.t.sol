// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HookFixture} from "./HookFixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {ImmutableState} from "v4-periphery/src/base/ImmutableState.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {NFTHolderDiscountHook} from "../src/NFTHolderDiscountHook.sol";
import {HookFlags} from "../src/HookFlags.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {RevertingCollection, GasBurningCollection, MalformedCollection} from "./mocks/Collections.sol";

contract NFTHolderDiscountHookTest is HookFixture {
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    function setUp() public override {
        super.setUp();
        seed(key, -600, 600, 1000 ether);
    }

    function test_permissionsAndConstructor() public {
        Hooks.Permissions memory p = hook.getHookPermissions();
        Hooks.Permissions memory expected;
        expected.afterSwap = true;
        expected.afterSwapReturnDelta = true;
        assertEq(abi.encode(p), abi.encode(expected));
        assertEq(address(hook.poolManager()), address(manager));
        assertEq(HookFlags.flagsOf(address(hook)), FLAGS);
        assertTrue(HookFlags.matches(address(hook), FLAGS));
        // CREATE's address is deliberately not mined; BaseHook must reject its permission bits.
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        assertFalse(HookFlags.matches(next, FLAGS));
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, next));
        new NFTHolderDiscountHook(manager);
    }

    function test_exactInputBuyNonholder() public {
        trade(key, true, true, 1 ether, NONHOLDER);
        assertClaims(key);
    }

    function test_exactInputBuyHolder() public {
        trade(key, true, true, 1 ether, HOLDER);
        assertClaims(key);
    }

    function test_exactInputSellNonholder() public {
        trade(key, false, true, 1 ether, NONHOLDER);
        assertClaims(key);
    }

    function test_exactInputSellHolder() public {
        trade(key, false, true, 1 ether, HOLDER);
        assertClaims(key);
    }

    function test_exactOutputBuyNonholder() public {
        trade(key, true, false, 1 ether, NONHOLDER);
        assertClaims(key);
    }

    function test_exactOutputBuyHolder() public {
        trade(key, true, false, 1 ether, HOLDER);
        assertClaims(key);
    }

    function test_exactOutputSellNonholder() public {
        trade(key, false, false, 1 ether, NONHOLDER);
        assertClaims(key);
    }

    function test_exactOutputSellHolder() public {
        trade(key, false, false, 1 ether, HOLDER);
        assertClaims(key);
    }

    function testFuzz_allSwapTypes(bool buy, bool exactInput, bool holder, uint96 amount) public {
        trade(key, buy, exactInput, bound(amount, 1000, 2 ether), holder ? HOLDER : NONHOLDER);
        assertClaims(key);
    }

    function test_discountEndsWhenNFTMovesAway() public {
        assertEq(hook.feeBpsFor(HOLDER), 50);
        trade(key, true, true, 1 ether, HOLDER);
        vm.prank(HOLDER);
        collection.transferFrom(HOLDER, NONHOLDER, 1);
        assertEq(hook.feeBpsFor(HOLDER), 100);
        assertEq(hook.feeBpsFor(NONHOLDER), 50);
        trade(key, false, true, 1 ether, HOLDER);
        trade(key, true, false, 1 ether, NONHOLDER);
        assertClaims(key);
    }

    function test_hookDataAndRouterCannotSpoofHolder() public {
        collection.mint(address(router), 2);
        assertEq(hook.feeBpsFor(address(router)), 50);
        vm.recordLogs();
        vm.prank(TRADER, NONHOLDER);
        router.swap{value: 2 ether}(
            key, swapParams(true, true, 1 ether), PoolSwapTest.TestSettings(false, false), abi.encode(HOLDER)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == FEE_EVENT) {
                (address origin, bool discounted,,) = abi.decode(logs[i].data, (address, bool, Currency, uint256));
                assertEq(origin, NONHOLDER);
                assertFalse(discounted);
                found = true;
            }
        }
        assertTrue(found);
    }

    function test_collectionRevertFallsBackWithoutFailingSwap() public {
        vm.etch(hook.COLLECTION(), address(new RevertingCollection()).code);
        assertEq(hook.feeBpsFor(HOLDER), 100);
        trade(key, true, true, 1 ether, HOLDER);
        assertClaims(key);
    }

    function test_collectionGasExhaustionFallsBackWithoutFailingSwap() public {
        vm.etch(hook.COLLECTION(), address(new GasBurningCollection()).code);
        uint256 gasBefore = gasleft();
        uint256 bps = hook.feeBpsFor(HOLDER);
        uint256 gasUsed = gasBefore - gasleft();
        assertEq(bps, 100);
        assertLt(gasUsed, 60_000);
        trade(key, true, false, 1 ether, HOLDER);
        assertClaims(key);
    }

    function test_collectionMalformedReturnFallsBackWithoutFailingSwap() public {
        uint256[6] memory lengths = [uint256(0), 1, 31, 33, 64, 65_536];
        for (uint256 i; i < lengths.length; i++) {
            vm.etch(hook.COLLECTION(), address(new MalformedCollection(lengths[i])).code);
            assertEq(hook.feeBpsFor(HOLDER), 100);
            trade(key, i % 2 == 0, true, 0.01 ether, HOLDER);
        }
        assertClaims(key);
    }

    function test_collectionMissingCodeFallsBack() public {
        vm.etch(hook.COLLECTION(), "");
        assertEq(hook.feeBpsFor(HOLDER), 100);
        trade(key, false, true, 1 ether, HOLDER);
    }

    function test_donateFeesReachesInRangeLPsAndIsPermissionless() public {
        trade(key, true, true, 1 ether, NONHOLDER);
        trade(key, false, true, 1 ether, HOLDER);
        // First collect existing LP trading fees, isolating the subsequent donation's proceeds.
        seed(key, -600, 600, 0);
        (uint256 fees0, uint256 fees1) = hook.accrued(key.toId());
        assertGt(fees0, 0);
        assertGt(fees1, 0);
        (uint256 growth0Before, uint256 growth1Before) = manager.getFeeGrowthGlobals(key.toId());
        uint256 donorBalance = NONHOLDER.balance;
        vm.expectEmit(true, false, false, true, address(hook));
        emit NFTHolderDiscountHook.FeesDonated(key.toId(), fees0, fees1);
        vm.prank(NONHOLDER);
        hook.donateFees(key);
        assertEq(NONHOLDER.balance, donorBalance);
        (uint256 growth0After, uint256 growth1After) = manager.getFeeGrowthGlobals(key.toId());
        assertEq(growth0After - growth0Before, fees0 * (1 << 128) / 1000 ether);
        assertEq(growth1After - growth1Before, fees1 * (1 << 128) / 1000 ether);
        assertClaims(key);
        (uint256 a0, uint256 a1) = hook.accrued(key.toId());
        assertEq(a0, 0);
        assertEq(a1, 0);
        BalanceDelta collected = seed(key, -600, 600, 0);
        assertApproxEqAbs(uint256(uint128(collected.amount0())), fees0, 1);
        assertApproxEqAbs(uint256(uint128(collected.amount1())), fees1, 1);
        // Duplicate donation neither remints nor redistributes the old fees.
        hook.donateFees(key);
        assertClaims(key);
        assertEq(manager.currencyDelta(address(hook), key.currency0), 0);
        assertEq(manager.currencyDelta(address(hook), key.currency1), 0);
    }

    function test_noLiquidityPreservesClaimsUntilLaterDonation() public {
        trade(key, true, true, 1 ether, NONHOLDER);
        trade(key, false, true, 1 ether, HOLDER);
        (uint256 fees0, uint256 fees1) = hook.accrued(key.toId());
        seed(key, -600, 600, -1000 ether);
        assertEq(manager.getLiquidity(key.toId()), 0);
        vm.expectRevert(NFTHolderDiscountHook.NoLiquidity.selector);
        hook.donateFees(key);
        assertClaims(key);
        (uint256 a0, uint256 a1) = hook.accrued(key.toId());
        assertEq(a0, fees0);
        assertEq(a1, fees1);
        seed(key, -600, 600, 1000 ether);
        hook.donateFees(key);
        assertEq(manager.balanceOf(address(hook), 0), 0);
        assertEq(manager.balanceOf(address(hook), key.currency1.toId()), 0);
    }

    function test_poolsSharingCurrenciesKeepSeparateAccrual() public {
        PoolKey memory other = key;
        other.fee = 10_000;
        manager.initialize(other, PRICE_1_1);
        seed(other, -600, 600, 1000 ether);
        trade(key, true, true, 1 ether, HOLDER);
        trade(other, true, true, 2 ether, NONHOLDER);
        trade(other, false, true, 1 ether, NONHOLDER);
        (uint256 first0, uint256 first1) = hook.accrued(key.toId());
        (uint256 second0, uint256 second1) = hook.accrued(other.toId());
        assertEq(manager.balanceOf(address(hook), 0), first0 + second0);
        assertEq(manager.balanceOf(address(hook), key.currency1.toId()), first1 + second1);
        hook.donateFees(key);
        assertEq(manager.balanceOf(address(hook), 0), second0);
        assertEq(manager.balanceOf(address(hook), key.currency1.toId()), second1);
        assertClaims(other);
        hook.donateFees(other);
        assertClaims(other);
    }

    function test_erc20PairCanAttachWithoutAdminOrTokenConstructor() public {
        MockERC20 other = new MockERC20("Other", "OTH", 10_000 ether);
        address a = address(other) < address(token) ? address(other) : address(token);
        address b = address(other) < address(token) ? address(token) : address(other);
        PoolKey memory pair = PoolKey(Currency.wrap(a), Currency.wrap(b), 3000, 60, IHooks(address(hook)));
        manager.initialize(pair, PRICE_1_1);
        other.approve(address(liquidityRouter), type(uint256).max);
        seed(pair, -600, 600, 1000 ether);
        other.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.prank(address(this), HOLDER);
        router.swap(pair, swapParams(true, true, 1 ether), PoolSwapTest.TestSettings(false, false), "");
        vm.prank(address(this), NONHOLDER);
        router.swap(pair, swapParams(false, false, 1 ether), PoolSwapTest.TestSettings(false, false), "");
        assertClaims(pair);
        hook.donateFees(pair);
        assertClaims(pair);
    }

    function test_callbacksRefuseUntrustedCallersAndUnsolicitedManagerUnlock() public {
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.afterSwap(TRADER, key, swapParams(true, true, 1 ether), toBalanceDelta(-1 ether, 1 ether), "");
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(key));
        vm.expectRevert(NFTHolderDiscountHook.UnexpectedUnlock.selector);
        vm.prank(address(manager));
        hook.unlockCallback(abi.encode(key));
        PoolKey memory wrong = key;
        wrong.hooks = IHooks(address(0));
        vm.expectRevert(NFTHolderDiscountHook.InvalidPool.selector);
        hook.donateFees(wrong);
        assertClaims(key);
    }

    function test_failedSettlementRollsBackFeeClaimsAndPrice() public {
        (uint160 priceBefore,,,) = manager.getSlot0(key.toId());
        vm.prank(TRADER);
        token.approve(address(router), 0);
        vm.expectRevert();
        vm.prank(TRADER, HOLDER);
        router.swap(key, swapParams(false, true, 1 ether), PoolSwapTest.TestSettings(false, false), "");
        (uint160 priceAfter,,,) = manager.getSlot0(key.toId());
        assertEq(priceAfter, priceBefore);
        (uint256 a0, uint256 a1) = hook.accrued(key.toId());
        assertEq(a0, 0);
        assertEq(a1, 0);
        assertClaims(key);
    }

    function test_partialFillChargesActualOutputAndRespectsPriceLimit() public {
        uint160 limit = TickMath.getSqrtPriceAtTick(-10);
        vm.prank(TRADER, NONHOLDER);
        BalanceDelta delta = router.swap{value: 10 ether}(
            key, SwapParams(true, -10 ether, limit), PoolSwapTest.TestSettings(false, false), ""
        );
        assertGt(int256(delta.amount0()), -10 ether);
        (uint160 price,,,) = manager.getSlot0(key.toId());
        assertEq(price, limit);
        (uint256 a0, uint256 fee) = hook.accrued(key.toId());
        assertEq(a0, 0);
        uint256 gross = uint256(uint128(delta.amount1())) + fee;
        assertEq(fee, (gross + 99) / 100);
        assertClaims(key);
    }

    function testFuzz_feeRoundingAndSignedBoundary(int128 unspecified, bool inCurrency1, bool holder) public {
        // Isolate arithmetic at all int128 boundaries; integration cases above verify actual mint settlement.
        vm.mockCall(address(manager), abi.encodeWithSelector(IPoolManager.mint.selector), "");
        bool exactInput = unspecified >= 0;
        bool buy = exactInput == inCurrency1;
        BalanceDelta delta = inCurrency1 ? toBalanceDelta(0, unspecified) : toBalanceDelta(unspecified, 0);
        vm.prank(address(manager), holder ? HOLDER : NONHOLDER);
        (bytes4 selector, int128 fee) = hook.afterSwap(TRADER, key, swapParams(buy, exactInput, 1), delta, "");
        int256 wide = int256(unspecified);
        uint256 magnitude = uint256(wide < 0 ? -wide : wide);
        assertEq(selector, BaseHook.afterSwap.selector);
        assertEq(int256(fee), int256((magnitude * (holder ? 50 : 100) + 9999) / 10000));
        assertGe(fee, 0);
        assertLe(uint256(uint128(fee)), magnitude);
    }

    function test_feeRoundingAtZeroDustAndInt128Minimum() public {
        testFuzz_feeRoundingAndSignedBoundary(0, true, false);
        testFuzz_feeRoundingAndSignedBoundary(1, true, true);
        testFuzz_feeRoundingAndSignedBoundary(-1, false, false);
        testFuzz_feeRoundingAndSignedBoundary(type(int128).min, false, true);
        testFuzz_feeRoundingAndSignedBoundary(type(int128).max, true, false);
    }

    function test_runtimeCodeHasNoEscapeHatch() public view {
        bytes memory runtime = address(hook).code;
        assertGt(runtime.length, 0);
        assertLe(runtime.length, 24_576);
        for (uint256 i; i < runtime.length; i++) {
            uint8 op = uint8(runtime[i]);
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            else assertTrue(op != 0xff && op != 0xf4 && op != 0xf2);
        }
    }
}

contract LaunchRehearsalTest is HookFixture {
    using StateLibrary for IPoolManager;

    function test_oneSidedNFTDSeedFirstBuyThenSell() public {
        assertEq(address(manager).balance, 0);
        BalanceDelta deposited = seed(key, -600, -60, 1000 ether);
        assertEq(deposited.amount0(), 0, "seed must not require ETH");
        assertLt(deposited.amount1(), 0);
        assertEq(address(manager).balance, 0, "pool must start ETH-less");
        assertEq(manager.getLiquidity(key.toId()), 0, "opening price above the seed range");
        vm.expectRevert(NFTHolderDiscountHook.NoLiquidity.selector);
        hook.donateFees(key);
        (BalanceDelta bought,) = trade(key, true, true, 1 ether, HOLDER);
        assertGt(bought.amount1(), 0);
        assertGt(address(manager).balance, 0);
        assertGt(manager.getLiquidity(key.toId()), 0);
        assertClaims(key);
        trade(key, false, true, uint256(uint128(bought.amount1())) / 2, NONHOLDER);
        assertClaims(key);
        hook.donateFees(key);
        assertClaims(key);
    }
}
