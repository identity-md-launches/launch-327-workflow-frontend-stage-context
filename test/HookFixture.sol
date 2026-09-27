// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {NFTD} from "../src/NFTD.sol";
import {NFTHolderDiscountHook} from "../src/NFTHolderDiscountHook.sol";
import {MockCollection} from "./mocks/Collections.sol";

abstract contract HookFixture is Test {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x44;
    uint160 internal constant PRICE_1_1 = 1 << 96;
    address internal constant TRADER = address(0xBEEF);
    address internal constant HOLDER = address(0xA11CE);
    address internal constant NONHOLDER = address(0xB0B);
    bytes32 internal constant FEE_EVENT = keccak256("FeeCharged(bytes32,address,bool,address,uint256)");
    bytes32 internal constant SWAP_EVENT =
        keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    IPoolManager internal manager;
    NFTHolderDiscountHook internal hook;
    NFTD internal token;
    MockCollection internal collection;
    PoolSwapTest internal router;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolKey internal key;

    function setUp() public virtual {
        manager = IPoolManager(address(new PoolManager(address(this))));
        token = new NFTD();
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(NFTHolderDiscountHook).creationCode, abi.encode(manager));
        hook = new NFTHolderDiscountHook{salt: salt}(manager);
        assertEq(address(hook), predicted);
        router = new PoolSwapTest(manager);
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(address(hook)));
        manager.initialize(key, PRICE_1_1);
        vm.etch(hook.COLLECTION(), address(new MockCollection()).code);
        collection = MockCollection(hook.COLLECTION());
        collection.mint(HOLDER, 1);
        vm.deal(address(this), 1_000_000 ether);
        vm.deal(TRADER, 10_000 ether);
        token.transfer(TRADER, 100_000 ether);
        token.approve(address(liquidityRouter), type(uint256).max);
        vm.prank(TRADER);
        token.approve(address(router), type(uint256).max);
    }

    function seed(PoolKey memory pool, int24 lower, int24 upper, int256 liquidity) internal returns (BalanceDelta) {
        return liquidityRouter.modifyLiquidity{value: 100 ether}(
            pool, ModifyLiquidityParams(lower, upper, liquidity, bytes32(0)), ""
        );
    }

    function swapParams(bool zeroForOne, bool exactInput, uint256 amount) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: exactInput ? -int256(amount) : int256(amount),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    struct TradeSnapshot {
        uint256 fees0;
        uint256 fees1;
        uint256 ethBalance;
        uint256 tokenBalance;
    }

    struct Observation {
        int128 raw0;
        int128 raw1;
        uint256 fee;
        bool foundSwap;
        bool foundFee;
    }

    function trade(PoolKey memory pool, bool zeroForOne, bool exactInput, uint256 amount, address origin)
        internal
        returns (BalanceDelta result, uint256 fee)
    {
        TradeSnapshot memory before;
        (before.fees0, before.fees1) = hook.accrued(pool.toId());
        before.ethBalance = TRADER.balance;
        before.tokenBalance = token.balanceOf(TRADER);
        vm.recordLogs();
        vm.prank(TRADER, origin);
        result = router.swap{value: zeroForOne ? 10 ether : 0}(
            pool, swapParams(zeroForOne, exactInput, amount), PoolSwapTest.TestSettings(false, false), ""
        );
        bool unspecified1 = exactInput == zeroForOne;
        Observation memory observed = readSwapLogs(pool, unspecified1, origin);
        fee = observed.fee;
        {
            int256 rawUnspecified = unspecified1 ? int256(observed.raw1) : int256(observed.raw0);
            uint256 magnitude = uint256(rawUnspecified < 0 ? -rawUnspecified : rawUnspecified);
            assertEq(fee, (magnitude * hook.feeBpsFor(origin) + 9999) / 10000, "wrong rounded fee");
            assertLe(fee, magnitude);
        }
        assertEq(int256(result.amount0()), int256(observed.raw0) - int256(unspecified1 ? 0 : fee));
        assertEq(int256(result.amount1()), int256(observed.raw1) - int256(unspecified1 ? fee : 0));
        assertEq(int256(TRADER.balance) - int256(before.ethBalance), int256(result.amount0()));
        assertEq(int256(token.balanceOf(TRADER)) - int256(before.tokenBalance), int256(result.amount1()));
        (uint256 after0, uint256 after1) = hook.accrued(pool.toId());
        assertEq(after0 - before.fees0, unspecified1 ? 0 : fee);
        assertEq(after1 - before.fees1, unspecified1 ? fee : 0);
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
    }

    function readSwapLogs(PoolKey memory pool, bool unspecified1, address origin)
        private
        returns (Observation memory observed)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == SWAP_EVENT) {
                (observed.raw0, observed.raw1,,,,) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                observed.foundSwap = true;
            }
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == FEE_EVENT) {
                (address loggedOrigin, bool discounted, Currency currency, uint256 paid) =
                    abi.decode(logs[i].data, (address, bool, Currency, uint256));
                assertEq(logs[i].topics[1], PoolId.unwrap(pool.toId()));
                assertEq(loggedOrigin, origin);
                assertEq(discounted, hook.feeBpsFor(origin) == 50);
                assertEq(Currency.unwrap(currency), Currency.unwrap(unspecified1 ? pool.currency1 : pool.currency0));
                observed.fee = paid;
                observed.foundFee = true;
            }
        }
        assertTrue(observed.foundSwap && observed.foundFee, "missing fee or swap event");
    }

    function assertClaims(PoolKey memory pool) internal view {
        (uint256 amount0, uint256 amount1) = hook.accrued(pool.toId());
        assertEq(manager.balanceOf(address(hook), pool.currency0.toId()), amount0);
        assertEq(manager.balanceOf(address(hook), pool.currency1.toId()), amount1);
    }

    receive() external payable {}
}
