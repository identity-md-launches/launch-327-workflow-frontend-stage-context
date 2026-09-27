// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {NFTHolderDiscountHook} from "../src/NFTHolderDiscountHook.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

/// @dev Adversarial manager ONLY for handshake and very large accounting boundary tests.
/// Real-manager integration and invariants live in the other suites.
contract CallbackProbe is Test {
    uint256 public burned0;
    uint256 public burned1;
    bool public failDonation;

    function setFailDonation(bool fail) external {
        failDonation = fail;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        NFTHolderDiscountHook hook = NFTHolderDiscountHook(msg.sender);
        PoolKey memory key = abi.decode(data, (PoolKey));
        expectRejected(hook, abi.encodeCall(hook.donateFees, (key)), NFTHolderDiscountHook.DonationInProgress.selector);
        PoolKey memory wrong = key;
        wrong.fee += 1;
        expectRejected(
            hook,
            abi.encodeCall(hook.unlockCallback, (abi.encode(wrong))),
            NFTHolderDiscountHook.UnexpectedUnlock.selector
        );
        bytes memory result = hook.unlockCallback(data);
        expectRejected(
            hook, abi.encodeCall(hook.unlockCallback, (data)), NFTHolderDiscountHook.UnexpectedUnlock.selector
        );
        return result;
    }

    function expectRejected(NFTHolderDiscountHook hook, bytes memory data, bytes4 expected) internal {
        (bool ok, bytes memory reason) = address(hook).call(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(expected));
    }

    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(uint256(1000)); // nonzero in-range liquidity
    }

    function mint(address, uint256, uint256) external {}

    function burn(address, uint256 id, uint256 amount) external {
        if (id == 0) burned0 += amount;
        else burned1 += amount;
    }

    function donate(PoolKey calldata, uint256 amount0, uint256 amount1, bytes calldata)
        external
        view
        returns (BalanceDelta)
    {
        require(!failDonation, "donation failed");
        assertLe(amount0, uint256(int256(type(int128).max)));
        assertLe(amount1, uint256(int256(type(int128).max)));
        return toBalanceDelta(-int128(int256(amount0)), -int128(int256(amount1)));
    }
}

contract DonationGuardsTest is Test {
    CallbackProbe internal probe;
    NFTHolderDiscountHook internal hook;
    PoolKey internal key;

    function setUp() public {
        probe = new CallbackProbe();
        (, bytes32 salt) =
            HookMiner.find(address(this), 0x44, type(NFTHolderDiscountHook).creationCode, abi.encode(address(probe)));
        hook = new NFTHolderDiscountHook{salt: salt}(IPoolManager(address(probe)));
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(1)), 3000, 60, IHooks(address(hook)));
    }

    function test_unlockIsBoundToDataCannotReenterOrReplay() public {
        hook.donateFees(key);
        hook.donateFees(key); // guard resets for later calls
        vm.expectRevert(NFTHolderDiscountHook.UnexpectedUnlock.selector);
        vm.prank(address(probe));
        hook.unlockCallback(abi.encode(key));
    }

    function accrue(bool currency1, int128 raw) internal {
        vm.prank(address(probe), address(0xB0B));
        hook.afterSwap(
            address(this),
            key,
            SwapParams(currency1, -1, 1),
            currency1 ? toBalanceDelta(0, raw) : toBalanceDelta(raw, 0),
            ""
        );
    }

    function test_largeAccrualDonatesInSignedDeltaBatches() public {
        for (uint256 i; i < 102; i++) {
            accrue(true, type(int128).max);
            accrue(false, type(int128).max);
        }
        (uint256 before0, uint256 before1) = hook.accrued(key.toId());
        uint256 max = uint256(int256(type(int128).max));
        assertGt(before0, max);
        assertGt(before1, max);
        hook.donateFees(key);
        (uint256 left0, uint256 left1) = hook.accrued(key.toId());
        assertEq(left0, before0 - max);
        assertEq(left1, before1 - max);
        assertEq(probe.burned0(), max);
        assertEq(probe.burned1(), max);
        hook.donateFees(key);
        (left0, left1) = hook.accrued(key.toId());
        assertEq(left0 + left1, 0);
        assertEq(probe.burned0(), before0);
        assertEq(probe.burned1(), before1);
    }

    function test_failedDonationRestoresAccrualAndUnlockGuard() public {
        accrue(true, 1000);
        probe.setFailDonation(true);
        vm.expectRevert("donation failed");
        hook.donateFees(key);
        (, uint256 amount1) = hook.accrued(key.toId());
        assertEq(amount1, 10);
        assertEq(probe.burned1(), 0);
        probe.setFailDonation(false);
        hook.donateFees(key);
        (, amount1) = hook.accrued(key.toId());
        assertEq(amount1, 0);
        assertEq(probe.burned1(), 10);
    }
}
