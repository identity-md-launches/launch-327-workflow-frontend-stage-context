# Holder Discount — NFTD

This contract-stage contribution implements the fixed-supply NFTD token and
`NFTHolderDiscountHook` for the approved Sepolia launch. The repository contains
Foundry tests, vendored dependencies, and ABI exports. It is ready for the separate
manifest and independent review assignments; no live deployment has been performed.

## Build and verify

```sh
forge build
forge test
forge fmt --check
```

`foundry.toml` pins Solidity **0.8.26**, Cancun, optimizer runs **200**, and
`bytecode_hash = "none"`. All Solidity dependencies are ordinary files in `lib/`.
Their commits, archive hashes, selected paths, and upstream URLs are recorded in
[`docs/dependencies.json`](docs/dependencies.json). The pinned compiler and Foundry
are tooling prerequisites; compilation and tests require no network, RPC, secrets,
environment configuration, FFI, or filesystem cheatcodes. Dependencies retain their
upstream license notices. No submodules or package installation are needed.

## Contracts and fees

[`NFTD`](src/NFTD.sol) is an OpenZeppelin ERC-20 named **Holder Discount**, symbol
**NFTD**, with **18 decimals** and **1,000,000,000 × 10¹⁸** units. Its argument-free
constructor mints the entire supply to `msg.sender` (the launch factory in production).
There is no further mint, burn, owner, tax, pause, upgrade, or administrative path.

[`NFTHolderDiscountHook`](src/NFTHolderDiscountHook.sol) extends the vendored
v4-periphery `BaseHook`. Its single constructor argument is `IPoolManager`. It has
no owner and enables exactly `afterSwap` and `afterSwapReturnDelta`. The permission
mask is **0x0044 (68)** under the v4 **0x3fff** address mask. All inherited callback
entrypoints require the immutable PoolManager as caller. Unused callbacks revert.
Pool initialization and seed liquidity do not call this hook.

The hook charges **100 bps (1%)**, reduced to **50 bps (0.5%)** when
`COLLECTION.balanceOf(tx.origin) >= 1`. `COLLECTION` is the source constant
`0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`, the Sepolia Uniswap v4 PositionManager
specified by the workflow. Holding any one position NFT qualifies; it need not
represent this pool or currently contain liquidity. Holdings are checked on every
swap, so transferring the NFT away immediately removes the discount.

The balance lookup uses `staticcall` with at most **50,000 gas** and a fixed 32-byte
output buffer. A revert, gas exhaustion, missing contract, or return length other
than exactly 32 bytes gives the full fee. Oversized return data is never copied in
full. This protects otherwise sufficiently funded swap execution from collection
failure; the transaction still needs enough gas for the swap itself.

For the launch pair, currency0 is native ETH and currency1 is NFTD. In v4,
`amountSpecified < 0` means exact input:

| Swap | `zeroForOne` | Specified amount | Fee currency and effect |
| --- | --- | --- | --- |
| Buy, exact input | true | Negative ETH input | Subtract NFTD from output |
| Sell, exact input | false | Negative NFTD input | Subtract ETH from output |
| Buy, exact output | true | Positive NFTD output | Add ETH to input |
| Sell, exact output | false | Positive ETH output | Add NFTD to input |

The fee is `min(amount, ceil(amount × bps / 10_000))`, where `amount` is the absolute
value of the **actual unspecified delta**, before this hook's adjustment. Partial
fills use the executed delta. A zero delta has zero fee; a nonzero dust amount may
be entirely consumed by rounding. The pool's 3000 LP fee (0.3%) is separate.

Fees are minted to the hook as PoolManager ERC-6909 claims during `afterSwap`.
The returned positive hook delta cancels the debt created by minting; the trader
settles the adjusted amounts through its router. The hook pushes no ETH or ERC-20s
during swaps. In particular, an ETH-less, one-sided NFTD seed supports the first buy.
Accounting is keyed by the complete `PoolId`, allowing other pools to attach the
same hook without sharing their accrued fees.

## Eligibility limitations

`tx.origin` is used **only to lower a fee**, never for authorization or crediting
assets. The callback's `sender` identifies the router. `hookData` is unauthenticated
and deliberately ignored: passing another holder's address cannot earn a discount.
The workflow's identity-from-hookData rule for crediting a user is inapplicable
because this hook credits only its own claims, then donates them to LPs.

- Contract and ERC-4337 wallets are judged by the relayer or bundler EOA.
- A relayer holding one NFT passes the discount to everyone it relays.
- An EIP-7702 account can hold a borrowed NFT during its own transaction.
- There is no snapshot, holding period, trusted-router registry, or Sybil protection.

These are intentional eligibility limits, not authentication guarantees. A frontend
must explain that `feeBpsFor(connectedWallet)` predicts a directly submitted EOA
transaction and may differ for relayed or bundled execution.

## Permissionless donation and accounting

Anyone can call `donateFees(PoolKey)` outside an existing PoolManager unlock. It
initiates its own unlock, checks that the pool has in-range liquidity, burns the
pool's accrued claims, and calls `PoolManager.donate` for both currencies. Burn
credits and donation debits cancel exactly. The caller gets no payout or bounty.
Donated fees reach **LPs in range at donation time**, who collect using their usual
position machinery. They are not attributed to the LPs present when each swap ran.

With zero in-range liquidity, the call reverts `NoLiquidity`, including before the
first buy of an out-of-range seed. Claims and accrual wait intact for a later call.
A reverted burn/donation rolls back everything. Empty donations are harmless when
liquidity exists. A wrong hook address in the key is rejected. An initialized pool
must have liquidity before donation; an unknown pool also produces `NoLiquidity`.

`unlockCallback` accepts only PoolManager and only the exact payload of an active,
hook-initiated donation. That payload is consumed once, and the donation guard
remains active across the entire unlock. Reentry, unsolicited callbacks, changed
payloads, and callback replay are rejected.

PoolManager deltas are signed 128-bit quantities. For extreme accumulated totals,
each call donates up to `int128.max` per currency and leaves the rest for subsequent
calls. Ordinary NFTD-scale accrual is donated entirely in one call. LP distribution
uses v4's normal rounding, so tiny donations may remain as pool dust.

For each currency, the sum of recorded accrual across pools equals the hook's
fee-generated ERC-6909 claims. The randomized tests check this invariant. ERC-6909
also permits outsiders to transfer unsolicited claims directly to the hook; those
unattributed balances are not fees and cannot safely be assigned to a pool. Such
transfers make total claims exceed recorded accrual and remain stranded. Direct or
forced asset transfers are likewise not donations. There is no rescue/admin path.

Donation is permissionless and may benefit liquidity inserted just before the
call. This implementation has no JIT protection, keeper subsidy, or historical LP
allocation. Standard ERC-20 accounting is assumed for pooled assets: fee-on-transfer,
rebasing, or callback-enabled third-party tokens are not certified by these tests.
NFTD itself has none of those behaviors.

## Tests and handoff

The delivered tests include a real local v4-core PoolManager, CREATE2 deployment
with actual permission validation, both holder states for all four swap types,
collection read failures, signed arithmetic boundaries, partial fills, settlement
rollback, LP fee collection, multiple pools, and donation guards. The launch rehearsal
seeds only NFTD below the opening price, confirms zero ETH in PoolManager, then buys,
sells, and donates. Stateful invariants execute swaps and donations across two pools
and check claims, settled deltas, and conservation of underlying funds and supply.
The adversarial manager in `DonationGuards.t.sol` is limited to callback protocol and
large accrual boundary tests; it is not used to establish real-manager settlement.

The supplied protected assertions were also run locally from temporary scratch
copies with explicit bytecode, flags, decimals, and manager parameters in place of
environment reads. Those copies are not part of this delivery, and the local result
does not substitute for the independent admission checks.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for concrete launch parameters,
operational responsibilities, and review boundaries, and [`docs/ABI.md`](docs/ABI.md)
for integration details. Independent review and a live Sepolia factory rehearsal
remain release responsibilities. Local tests are not an independent security audit.
