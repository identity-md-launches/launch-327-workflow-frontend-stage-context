# Holder Discount frontend

A single-page React + TypeScript interface for the deployed Sepolia ETH/NFTD pool. It shows the discount collection, connected account's NFT balance and indicative hook fee, current accrued claims, lifetime fees per currency, discounted swap share and recent events. It supports exact-input buys/sells through the assigned PoolSwapTest router and permissionless `donateFees` calls. There is no backend.

## Install, run and rebuild

Node 24 and npm 11 were used on the worker. All frontend dependencies and build configuration stay here; root contract build files are unchanged.

```sh
cd web
npm ci
npm run build
npm run preview
```

Open the preview URL printed by Vite. For source development, run `npm run dev` after the first build. Its middleware serves the exact deployment manifest and ABI files from `../dist/`. Refresh the build whenever configuration inputs change. Do not open `index.html` with `file://`; manifest/ABI fetches need an HTTP static host.

`npm run build` typechecks, builds with Vite's `base: './'`, verifies the pinned implementation ABIs, copies them and the font license into `dist/`, and finally generates `dist/imd-deployment.json`. The publisher must host the whole root `dist/` directory. Hash anchors and relative paths support gateway subpaths without server rewrites. Runtime requests consist of public JSON-RPC and the visitor's injected wallet; fonts and application files are local.

## Deployment configuration

The **only runtime deployment configuration** is `dist/imd-deployment.json`. `src/config.ts` fetches it, loads the referenced ABI JSON arrays and verifies their canonical Keccak hashes before rendering the app. It does not import a separate deployment address or chain map.

Build inputs are retained under `web/config/`:

- `deployment-handoff.json`: supplied deployment handoff, deployed source commit, exact contract set, ABI hashes, pool parameters and deployment block.
- `network-handoff.json`: supplied network block and exact `walletAddChain` parameters. The build copies these data unchanged to the runtime manifest.
- `workflow.json`: the explicitly assigned PoolSwapTest address from the approved workflow and pinned `docs/DEPLOYMENT.md`.

`scripts/export.mjs` reads `docs/abi/<Contract>.json` using `git show` at deployed commit `85e5b19a6c502e621e60b33b6031c6c9006448af`. It requires the working-tree export to match those exact bytes and compares `keccak256(UTF8(JSON.stringify(recursivelyKeySortedABI)))` with the handoff. Arrays retain their ordering. Git and the pinned commit must remain available when rebuilding. No Solidity compilation, contract source modification or redeployment is part of this frontend build.

The generator preserves the required manifest fields and adds `pool`, `deploymentBlock`, `integrations.poolSwapTest` and `walletAddChain`. It inventories every other exported file, including `index.html`, all ABI JSON, JavaScript, CSS, font and license, using lowercase SHA-256. It rejects oversized files, more than 128 assets, symlinks, malformed router addresses and a deployment/network chain mismatch. Always regenerate after changing export bytes; never hand-edit the inventory.

The supplied network block does **not** contain PoolSwapTest. The explicit assignment and workflow require that router; the background Universal Router/Permit2 example is therefore not used. PoolManager, StateView, quoter, collection, explorer, RPCs and wallet network setup come from the supplied network data. PoolSwapTest is a single documented extension rather than an invented network entry. The original network object is unchanged. **NFTD approval goes directly to the assigned PoolSwapTest spender**, as its `CurrencySettler` transfers from the caller. Approving Permit2 would not authorize this route.

No private keys, RPC credentials, WalletConnect IDs or backend endpoints are present. The app supports injected EIP-1193 browser wallets, selecting the first provider when `window.ethereum.providers` is exposed. WalletConnect and account-abstraction transaction construction are not implemented. On an unknown-chain switch failure (4902 or an equivalent message), the app offers the exact supplied `wallet_addEthereumChain` parameters, then switches again. Disconnect clears the app session; it does not revoke wallet permissions or token allowances.

## Reads and transaction behavior

Public RPC transports fall back in the supplied order. The connected wallet transport is a final read fallback only when its chain matches. Every snapshot checks the RPC chain, nonempty launch/infrastructure code, hook/router PoolManager bindings, collection and token metadata. Contract state uses one explicit block per snapshot. Reads refresh every 30 seconds; state older than 90 seconds cannot enable a transaction. Account/network changes clear snapshot-dependent reviews, and account and chain are checked again immediately before signing.

The collection is read from `COLLECTION()`, and the displayed fee comes from `feeBpsFor(account)`. NFT balance read failures display “Unavailable”; the hook determines the full fee independently. A simulated transaction uses the connected account as `from`, matching ordinary EOA `tx.origin`. Contract/ERC-4337 wallets are evaluated by their actual relayer/bundler EOA, so this connected-account fee is indicative. An NFT-holding relayer discounts its users, and EIP-7702 can borrow a position NFT inside the transaction. These limits are explained on the page. Hook data is empty and is not treated as an authenticated identity.

Exact-input swaps use `amountSpecified < 0`, true `zeroForOne` for ETH buys, ordinary token settlement (`takeClaims=false`, `settleUsingBurn=false`) and no claim-token operations. Token decimals are read and checked against the pinned source. Quoting calls the network's V4Quoter via `simulateContract` with the caller's account; it never sends a quote transaction. Quoter deltas already include the hook effect, so the UI does not subtract the hook fee a second time.

The visitor's price movement percentage becomes an integer `sqrtPriceLimitX96` relative to the StateView spot price, using integer square root with bounds in both directions. It is **not a minimum output slippage guarantee**. PoolSwapTest has no minimum net output or on-chain deadline and can partially fill. The form states this and requires acknowledgment before signing. The first ETH buy may cross from zero active liquidity into the seeded range, so only donation is gated by zero current liquidity.

For ETH buys the transaction value is the entered input cap; no approval is requested. For NFTD sells, the app simulates an exact-amount approval to PoolSwapTest, asks for a separate signature and receipt, then requires a fresh quote and final router simulation. After allowance exists, router simulation provides the displayed actual estimated spend and net receive, including a possible partial fill. A fresh simulation before signing rejects zero output, overspending and a worsening estimate. Quotes expire after 60 seconds and changing inputs invalidates the review. Receipt success/revert/timeout states link to the explorer. Network gas is additional.

Donation first refreshes accrued fees and active liquidity and simulates `donateFees(key)`. The preview explains that accrued pool claims, not the visitor's principal, go to in-range LPs; the visitor pays gas. A second control simulates again and requests a signature. Zero fees and zero in-range liquidity disable donation. No claim is made that preflight simulation can guarantee a future transaction's outcome.

## Event totals

`src/services.ts` scans the hook's logs from deployment to latest minus six blocks, filtering by the exact pool ID. Queries begin at 2,000 blocks and shrink down to 125 on RPC errors. Events deduplicate by transaction hash/log index; removed logs are skipped. Totals are rebuilt on refresh rather than persisted across reorgs. The target block hash is checked again at completion; if it changed, the user must refresh. This is a confirmation buffer, not finality proof.

ETH and NFTD lifetime fees remain separate. The discount share is discounted `FeeCharged` count divided by all `FeeCharged` count, including zero-fee events. Current accrued claims are separate because donation resets them. Incomplete scans never display partial numbers as lifetime totals. Recent confirmed swaps and donations link to the explorer. Public RPC log access and long-history performance remain external dependencies; no indexer is silently substituted.

## Validation

```sh
cd web
npm run typecheck
npm test
npm run build
npm run check:export
npm run check:chain       # Read-only calls against supplied RPCs
npx playwright install chromium
npm run test:browser      # Mocked wallet/RPC; no live broadcasts
node tests/live-browser.mjs  # Live public reads; no wallet injected
```

Both browser scripts own their static server and close it with the browser. They serve the production export at `/preview/`. If using an installed Chromium executable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its absolute path. This worker used the preinstalled Chromium headless shell 154.0.8037.0 because the package-default browser revision was absent and full Chrome's crash handler could not start in this environment.

Results and six-domain review: [`../docs/VALIDATION.md`](../docs/VALIDATION.md). Implemented design: [`../docs/DESIGN.md`](../docs/DESIGN.md). Machine-readable browser, contrast and live RPC evidence and screenshots are in [`../docs/frontend/`](../docs/frontend/). Mocked balances and transactions in screenshots are fixtures, not claims of live funds or broadcast swaps.

## Scope and dependencies

Only `web/**`, `dist/**`, `docs/**` and the explicitly allowed `web/.gitignore` are changed. The request for a root `DESIGN.md` conflicts with the stronger path restriction, so the document is delivered at `docs/DESIGN.md`. The explicit ignore-file budget is exactly `web/.gitignore`; its unanchored directory patterns exclude dependency/cache/report directories at every nesting level beneath `web/`. No root ignore/build file is changed. No `node_modules`, npm cache, package archive, offline registry or submodule is included.

The required runtime font is DM Sans, licensed under SIL Open Font License 1.1; its license accompanies both source and export. Interface guidance attribution is in `docs/DESIGN.md`. Protocol interface references were checked against the repository's `lib/v4-core/src/test/PoolSwapTest.sol`, implementation-derived ABIs and [Uniswap's IV4Quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol). The quoter's net returned delta was checked in [V4Quoter](https://github.com/Uniswap/v4-periphery/blob/main/src/lens/V4Quoter.sol); runtime addresses never come from those external sources.
