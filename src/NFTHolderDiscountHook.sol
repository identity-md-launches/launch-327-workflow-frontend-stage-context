// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

/// @notice Collects a 1% swap fee, halved for holders of the Sepolia v4 Positions NFT.
/// @dev Only afterSwap and afterSwapReturnDelta are enabled. Fees stay in PoolManager as claims
/// until anyone donates them to this pool's currently in-range LPs. No owner or withdrawals exist.
/// Eligibility uses tx.origin ONLY to lower a fee, never for authorisation. Contract/ERC-4337
/// wallets are judged by the relayer/bundler EOA; an NFT-holding relayer discounts all its users.
/// EIP-7702 accounts can borrow an NFT within their own transaction. hookData is unauthenticated
/// and ignored; the callback sender is a router, not an authenticated end user.
contract NFTHolderDiscountHook is BaseHook, IUnlockCallback {
    using StateLibrary for IPoolManager;

    address public constant COLLECTION = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    uint256 public constant FULL_FEE_BPS = 100;
    uint256 public constant DISCOUNTED_FEE_BPS = 50;
    uint256 public constant COLLECTION_GAS_LIMIT = 50_000;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant MAX_DONATION = uint256(uint128(type(int128).max));

    struct Fees {
        uint256 amount0;
        uint256 amount1;
    }

    mapping(PoolId poolId => Fees) public accrued;
    bool private donating;
    bytes32 private pendingDonation;

    error InvalidPool();
    error NoLiquidity();
    error DonationInProgress();
    error UnexpectedUnlock();

    event FeeCharged(PoolId indexed poolId, address origin, bool discounted, Currency currency, uint256 fee);
    event FeesDonated(PoolId indexed poolId, uint256 amount0, uint256 amount1);

    /// @param manager Sepolia PoolManager: 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543.
    /// @dev BaseHook validates the mined address bits; the constructor has exactly one argument.
    constructor(IPoolManager manager) BaseHook(manager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.afterSwap = true;
        permissions.afterSwapReturnDelta = true;
    }

    /// @notice Returns 50 bps for a holder, otherwise 100 bps, including every collection read failure.
    /// @dev A bounded output buffer avoids copying hostile returndata. Only exactly 32 returned
    /// bytes are accepted, even when the call reports success. No ERC-721 callback is invoked.
    function feeBpsFor(address account) public view returns (uint256) {
        bytes memory input = abi.encodeWithSelector(bytes4(0x70a08231), account);
        address collection = COLLECTION;
        bool valid;
        uint256 nftBalance;
        assembly ("memory-safe") {
            valid := staticcall(COLLECTION_GAS_LIMIT, collection, add(input, 32), mload(input), 0, 32)
            valid := and(valid, eq(returndatasize(), 32))
            nftBalance := mload(0)
        }
        return valid && nftBalance != 0 ? DISCOUNTED_FEE_BPS : FULL_FEE_BPS;
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        // Exact input: output is unspecified. Exact output: input is unspecified.
        bool currency1Unspecified = (params.amountSpecified < 0) == params.zeroForOne;
        int256 unspecified = currency1Unspecified ? int256(delta.amount1()) : int256(delta.amount0());
        // Widen before negating: int128.min is a valid delta.
        uint256 amount = uint256(unspecified < 0 ? -unspecified : unspecified);
        uint256 bps = feeBpsFor(tx.origin);
        uint256 fee = (amount * bps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
        if (fee > amount) fee = amount;

        PoolId id = key.toId();
        Currency currency = currency1Unspecified ? key.currency1 : key.currency0;
        if (fee != 0) {
            if (currency1Unspecified) accrued[id].amount1 += fee;
            else accrued[id].amount0 += fee;
            // mint creates our debt now; the positive return delta cancels it after this callback.
            // No token transfer or ETH payment occurs here, including on the first native-ETH buy.
            poolManager.mint(address(this), currency.toId(), fee);
        }
        emit FeeCharged(id, tx.origin, bps == DISCOUNTED_FEE_BPS, currency, fee);
        // At most 1% of |int128.min|, so this cast cannot overflow.
        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    /// @notice Permissionlessly donates this pool's accrued fees to its currently in-range LPs.
    /// @dev Reverts NoLiquidity when no LP is in range, preserving claims. Called outside another
    /// manager unlock. Extremely large accrual is drained in int128.max-sized batches per currency
    /// to respect PoolManager's signed delta limit; call again for the remainder. No assets are sent
    /// to the caller. Unsolicited claims transferred directly to the hook are not accrued donations.
    function donateFees(PoolKey calldata key) external {
        if (address(key.hooks) != address(this)) revert InvalidPool();
        if (donating) revert DonationInProgress();
        bytes memory data = abi.encode(key);
        donating = true;
        pendingDonation = keccak256(data);
        poolManager.unlock(data);
        donating = false;
        pendingDonation = bytes32(0);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Accepts only the manager during, and with the exact data of, our own donation unlock.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        if (!donating || pendingDonation != keccak256(data)) revert UnexpectedUnlock();
        pendingDonation = bytes32(0);
        PoolKey memory key = abi.decode(data, (PoolKey));
        PoolId id = key.toId();
        if (poolManager.getLiquidity(id) == 0) revert NoLiquidity();

        Fees storage fees = accrued[id];
        uint256 amount0 = fees.amount0 > MAX_DONATION ? MAX_DONATION : fees.amount0;
        uint256 amount1 = fees.amount1 > MAX_DONATION ? MAX_DONATION : fees.amount1;
        fees.amount0 -= amount0;
        fees.amount1 -= amount1;
        if (amount0 != 0) poolManager.burn(address(this), key.currency0.toId(), amount0);
        if (amount1 != 0) poolManager.burn(address(this), key.currency1.toId(), amount1);
        // Burning credits our deltas; donate consumes exactly those credits, closing the unlock.
        if (amount0 != 0 || amount1 != 0) poolManager.donate(key, amount0, amount1, "");
        emit FeesDonated(id, amount0, amount1);
        return "";
    }
}
