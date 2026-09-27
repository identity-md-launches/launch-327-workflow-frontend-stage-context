# Sepolia deployment handoff

This is the source-producing contract assignment. The separate generated-manifest
assignment owns `launch.json`; independent reviewers inspect accepted sources and
that manifest. Services subsequently publish source, link signed artifacts, attest,
admit, deploy through the factory, and start the frontend. None of those later
outcomes is claimed by this implementation or required to run its local tests.

## Fixed parameters

| Parameter | Value |
| --- | --- |
| Chain | Sepolia, chain ID `11155111`, Cancun support required |
| Launch type | `univ4_hook` |
| Token artifact | `src/NFTD.sol:NFTD` |
| Token constructor arguments | None |
| Token metadata | Holder Discount / NFTD / 18 decimals |
| Total supply, base units | `1000000000000000000000000000` |
| Initial supply recipient | Token constructor's `msg.sender`, expected to be the launch factory |
| Hook artifact | `src/NFTHolderDiscountHook.sol:NFTHolderDiscountHook` |
| Hook constructor | `constructor(IPoolManager manager)` |
| Hook argument | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Enabled permissions | `afterSwap`, `afterSwapReturnDelta` |
| Address flags | Decimal `68`, hex `0x0044`, mask `0x3fff` |
| Pool currency0 | Native ETH, `address(0)`; do not substitute WETH |
| Pool currency1 | Deployed NFTD address |
| Pool LP fee | `3000`, static fee; no dynamic-fee flag |
| Pool tick spacing | `60` |
| Pool hooks | Mined deployed NFTHolderDiscountHook address |
| Discount collection | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`, source constant |
| Fee rates | 100 bps full / 50 bps holder; immutable source constants |
| Owner, recipient, token constructor arguments | None for the hook |
| Build | Solidity 0.8.26, Cancun, optimizer 200, bytecode hash none |
| Site label for later frontend | `lab-nft-discount-hook` |

The constructor accepts the manager argument so local tests can use a real freshly
deployed PoolManager. It does not enforce a chain ID or embed the Sepolia manager
address in source. The manifest and deployment services must supply **exactly** the
Sepolia address above. There is no upgrade or setter to repair a wrong deployment.

## Address mining and factory setup

Mine the hook address using the factory's **actual CREATE2 deployer address**, the
final creation bytecode, and `abi.encode(IPoolManager(sepoliaManager))`. The condition
is `uint160(hookAddress) & 0x3fff == 0x0044`. `BaseHook` validates this in the
constructor; it is not disabled in production or in the integration tests. The
vendored `v4-periphery/src/utils/HookMiner.sol` and tests show the calculation:

```text
initCode = NFTHolderDiscountHook.creationCode || abi.encode(sepoliaManager)
hookAddress = last20(keccak256(0xff || create2Deployer || salt || keccak256(initCode)))
```

A salt mined for a test contract or a different factory, compiler configuration,
source revision, or constructor argument cannot be reused. Check the resulting
address is unoccupied. The deployment service must bind reviewed creation code,
constructor arguments, salt, and resulting address to its deployment artifacts.

The factory address, its ABI and allocation rules, token/hook deployment addresses,
salt, initial price, launch liquidity amount, and seed tick bounds are not provided
in this assignment. They remain explicit deployment inputs; none is invented here.
Initialize with the pool parameters above. The seed must be entirely NFTD: both
tick boundaries below the opening price, each aligned to tick spacing 60. The local
rehearsal uses `sqrtPriceX96 = 2^96`, ticks `[-600, -60]`, and liquidity `1000e18`;
those are deterministic test parameters, not approved production pricing or sizing.
Initialization must precede seeding, and swap price limits must reach the seed range.

Deploy NFTD directly from the supply-receiving factory; a helper that becomes its
constructor caller receives the supply instead. There is no post-deployment mint or
distribution privilege. Never assume a signer EOA receives tokens deployed by a
factory. The hook's independent constructor takes no token or owner argument.

## Service and operator responsibilities

1. The manifest contributor records these sources, ABI paths, fixed constructor
   parameters, supply, permissions, and pool configuration. Policy and signed
   artifact linkage belong to services. Concrete source/constructor/policy or
   authorization conflicts remain independent review findings.
2. Independent reviewers inspect the final accepted source and `launch.json`,
   including return-delta signs, claim backing, callback authorization, the documented
   origin-based eligibility limits, and permission-address agreement.
3. Deployment services verify the supplied Sepolia infrastructure addresses and
   code, complete any required live-chain/factory rehearsal, publish and attest the
   reviewed source, perform admission, then deploy. No broadcast script, funded
   wallet, live-chain proof, or signed deployment artifact is delivered here.
4. Operators or users submit permissionless `donateFees` transactions when liquidity
   is in range. No automated keeper is bundled. Monitor `FeeCharged`, `FeesDonated`,
   accrued claims, collection read failures, and repeated failed donation attempts.
   No admin can redirect fees, rescue unsolicited funds, pause swaps, or change rates.
5. The frontend contributor builds the later static, one-page site against deployed
   addresses, exporting `dist/index.html`. Publication and IPFS hosting were approved
   in the workflow but have not been performed in this source assignment.

## Frontend integration parameters supplied by the workflow

| Sepolia service | Address |
| --- | --- |
| PoolSwapTest | `0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe` |
| StateView | `0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C` |
| V4Quoter | `0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227` |

These are supplied configuration, not an assertion of independently verified live
code. The later site shows the collection, connected wallet's NFT balance, indicative
fee, lifetime fees, discounted share, donation button, and swap form. Use StateView
for price and V4Quoter for quotes, accounting for the actual transaction origin when
interpreting a simulation. PoolSwapTest forwards hookData and sqrtPriceLimitX96;
the hook ignores hookData. Use ordinary settlement (`takeClaims = false`,
`settleUsingBurn = false`) for wallet token transfers. For native buys, provide enough
ETH including any exact-output hook fee. The router refunds surplus ETH.

PoolSwapTest is a test router and its `sqrtPriceLimitX96` bounds pool price, not a
user's minimum net output or maximum total input after hook fees. Hook-adjusted
exact-output input can exceed the gross pool quote, and exact-output requests may
partially fill at a price limit. The frontend and independent review must explicitly
account for these properties when implementing user trade protection. Do not present
gross pool deltas as the final amount received or paid.
