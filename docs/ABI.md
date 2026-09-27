# Contract ABI integration

The complete compiler-generated JSON ABI arrays are
[`abi/NFTD.json`](abi/NFTD.json) and
[`abi/NFTHolderDiscountHook.json`](abi/NFTHolderDiscountHook.json). They include
inherited functions, errors, and events. Regenerate after source or dependency changes:

```sh
forge inspect src/NFTD.sol:NFTD abi --json > docs/abi/NFTD.json
forge inspect src/NFTHolderDiscountHook.sol:NFTHolderDiscountHook abi --json > docs/abi/NFTHolderDiscountHook.json
```

## NFTD

The constructor has zero arguments. Standard ERC-20 methods are `name`, `symbol`,
`decimals`, `totalSupply`, `balanceOf`, `allowance`, `approve`, `transfer`, and
`transferFrom`. Transfers are exact, without a tax or burn. Infinite allowances are
not decremented. Standard `Transfer` and `Approval` events and OpenZeppelin IERC6093
errors are included. No owner, mint, burn, proxy, permit, or admin method is exposed.

## NFTHolderDiscountHook

`PoolId` is ABI `bytes32`, `Currency` is ABI `address` (`address(0)` means native ETH).
`PoolKey` is a tuple, in this order:

```text
(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
poolId = keccak256(abi.encode(poolKey))
```

| Entry point | Meaning |
| --- | --- |
| `constructor(address manager)` | The single immutable PoolManager argument |
| `poolManager() → address` | Immutable manager |
| `COLLECTION() → address` | Fixed discount NFT collection |
| `FULL_FEE_BPS() → uint256` | 100 |
| `DISCOUNTED_FEE_BPS() → uint256` | 50 |
| `COLLECTION_GAS_LIMIT() → uint256` | 50000 |
| `feeBpsFor(address account) → uint256` | Indicative fee for this account as transaction origin; failures return 100 |
| `accrued(bytes32 poolId) → (uint256 amount0, uint256 amount1)` | Undonated fee claims for this pool, in raw currency units |
| `donateFees(PoolKey key)` | Permissionless nonpayable donation; must start outside any manager unlock |
| `getHookPermissions() → Permissions` | Fourteen booleans in canonical v4 order; only afterSwap and afterSwapReturnDelta are true |
| `unlockCallback(bytes data) → bytes` | Manager-only internal donation protocol; never call from a wallet |
| `afterSwap(address sender, PoolKey key, SwapParams params, int256 delta, bytes hookData) → (bytes4, int128)` | Manager-only callback, returns fee in the unspecified currency |

`SwapParams` is `(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)`.
`BalanceDelta` is a packed `int256` with signed amount0 in the high 128 bits and
signed amount1 in the low 128 bits. Integrators should use v4's delta helpers. All
other inherited hook callbacks exist in the ABI but are disabled in permissions and
revert if called by the manager; every callback rejects other callers.

## Events and errors

```solidity
event FeeCharged(bytes32 indexed poolId, address origin, bool discounted, address currency, uint256 fee);
event FeesDonated(bytes32 indexed poolId, uint256 amount0, uint256 amount1);
```

`FeeCharged` uses the original pre-hook swap delta to determine the fee and emits
even when it rounds to zero. `discounted` indicates the rate selected, not whether
integer rounding made the actual fee smaller. `FeesDonated` reports claims burned
and distributed in that call, including zero for empty donations. Reverted swaps
and donations have no surviving logs or accounting effects.

Build lifetime metrics from logs starting at the deployment block, filtered by
hook address **and poolId**, handling chain reorgs and avoiding duplicate logs.
Accrual resets on donation and is not a lifetime counter. Aggregate fees separately
by currency: never add raw ETH and NFTD amounts. Define the displayed discounted
share as discounted `FeeCharged` event count divided by all `FeeCharged` event count
(including zero-fee swaps), or clearly label another chosen definition. An indexer
can run entirely in the later static frontend using bounded RPC log queries.

Application errors are `InvalidPool()`, `NoLiquidity()`, `DonationInProgress()`, and
`UnexpectedUnlock()`. Inherited errors include `NotPoolManager()` and
`HookNotImplemented()`. PoolManager may reject nested unlocks or invalid/uninitialized
pools, and `BaseHook` rejects constructor addresses whose permission bits disagree.
Collection failures are deliberately not exposed as swap errors; they select 100 bps.
