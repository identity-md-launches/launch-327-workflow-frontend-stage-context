# Frontend validation and interface review

## Delivered scope

One static Sepolia ETH/NFTD page, with source and npm lockfile under `web/`, production export under root `dist/`, and documentation/evidence under `docs/`. The deployed contract sources, ABIs under `docs/abi/`, `launch.json`, Foundry configuration, libraries and other root files are preserved.

The approved workflow, both supplied handoffs, both protected Solidity floor tests and all six pinned Better Interface core-principle sections were read. The floor tests describe the existing deployed contract requirements; they were not modified or rerun for this frontend-only assignment. No sub-agents were used.

Consequential choices:

- Use the specifically assigned PoolSwapTest, including direct NFTD approval to that spender. The generic Universal Router/Permit2 route conflicts with this narrower instruction. The network file lacks a PoolSwapTest field, so the supplied address is retained as the single `integrations.poolSwapTest` extension; the network object itself remains unchanged.
- Offer exact-input trades in both directions. The price limit is honestly identified as a pool-price bound with possible partial fill and no guaranteed net output or deadline. Exact-output trading is not exposed.
- Build lifetime metrics from complete, confirmed event scans; display ETH/NFTD separately and never substitute current accrued claims for lifetime totals.
- Bundle a local font and use static CSS artwork. No remote image/font services, private RPC settings, backend, WalletConnect project or funded test account are required.
- Deliver `docs/DESIGN.md` instead of root `DESIGN.md`: the explicit allowed-path rule takes precedence over that conflicting output-location criterion.

## Checks performed

| Check | Actual result |
| --- | --- |
| `npm --prefix web run build` | Passed. Includes `tsc --noEmit`, Vite production build and final manifest generation. |
| `npm --prefix web run typecheck` | Passed directly during implementation and in the final build. |
| `npm --prefix web test` | 5 passing tests for exact decimal parsing, input bounds, directional price-limit math, signed delta decoding, canonical ABI/path validation and chain addition. |
| `npm --prefix web run check:export` | Passed: exact handoff identifiers/contract set, unchanged network and chain-add data, ABI Keccak binding, all 8 asset hashes, file/path/count/size limits. |
| `npm --prefix web run test:browser` with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | 19 passing scenario groups against the final production export at `/preview/`, in Chromium headless shell 154.0.8037.0. Wallet and RPC mocked; no broadcasts. |
| `node web/tests/live-browser.mjs` with the same Chromium override | Passed against supplied public RPCs without mocks or a wallet. Pool reads, spot price and complete history loaded; zero console errors and failed requests. |
| `npm --prefix web run check:chain` | All three supplied RPCs returned chain 11155111. Launch and infrastructure bytecode was nonempty; hook/router manager and collection bindings matched. |
| `node web/scripts/check-scope.mjs` | Passed permitted-path, dependency/cache exclusion, no-submodule and conservative bundle-budget checks. Exact sizes in `frontend/integrity.json`. |
| Development-server smoke check | Passed: the dev route serves byte-identical exported deployment configuration and the source entry module returns HTTP 200. Server closed after the foreground check. |
| `git diff --check` | Passed; existing tracked files are unchanged. New source and documentation were also inspected. |

The production export is **639,660 bytes**, containing eight declared assets plus `imd-deployment.json`. All paths are relative; the manifest excludes itself. The largest asset is the approximately 542 KB application JavaScript bundle. Vite emits its default 500 KB chunk-size advisory; it is not a failed build. The export stays far below the response-body budget and no packaging archive or source map is included.

The browser package expected an uninstalled browser revision. The worker's existing full Chrome also failed to start its crash handler, so the browser scripts used the already installed headless shell via their documented executable override. Browser evidence was recorded only after a real page loaded and interactions ran. Servers and browsers are owned and closed by the foreground scripts.

## Interaction coverage

`frontend/browser-results.json` records each scenario and outcome. Coverage includes:

- Disconnected action locks, browser-wallet connection, absent wallet guidance, wrong-chain locks and 4902 → exact chain addition → switch retry.
- Connected NFT balance and 0.5% holder rate, non-holder 1% rate, account-change invalidation and collection-read failure with the contract-selected full fee.
- Invalid amount and out-of-range price-limit validation, focus on the correct field, and field-specific `aria-invalid`.
- Keyboard connection and buy flow, from quote submission through acknowledgment and confirm; a visible keyboard focus ring was screenshot and inspected.
- ETH buy calldata/value, negative exact-input amount, buy direction, ordinary settlement and empty hookData. Quoting is an `eth_call` with the connected origin.
- NFTD sell, exact approval amount and assigned spender, separate approval receipt, re-quote, final sell simulation and zero native transaction value.
- Donation preview without broadcasting, confirmation, refreshed accrual, no-fee state and no-liquidity lock. Zero current liquidity does not prevent a buy simulation crossing into seeded liquidity.
- Partial-fill disclosure, changed-account reviews, quote expiry, simulation revert, wallet signature rejection, confirmed receipt and reverted receipt.
- Duplicate log handling, complete lifetime count/share, wrong-RPC-chain refusal, RPC outage and refresh recovery, missing bytecode and tampered ABI lockout.

The test receipt and swap responses are controlled fixtures. They establish UI/encoding behavior, not an independently proven Uniswap execution or a funded wallet integration.

## Better Interface coverage

| Domain | Coverage and evidence | Unperformed or not applicable |
| --- | --- | --- |
| Accessibility | Checked semantic landmarks/headings, native controls, visible labels, invalid-field descriptions, dynamic status/error roles, keyboard connection and primary buy flow, visible focus screenshot, disabled states, reduced-motion CSS and target sizes. Axe WCAG A/AA-tagged scans reported zero violations in desktop disconnected, desktop quote review and mobile connected states. | No human screen-reader session, physical touch device or exhaustive assistive-technology compatibility claim. Forced-colors CSS was reviewed, not visually exercised. No modal/focus trap exists. |
| Layout | Checked grouping and DOM order in source and actual desktop/mobile screenshots. No horizontal overflow at 1440×1080, 780×1024, 390×844 or 320×780. Also checked 200% CSS text enlargement at 320px. | CSS text enlargement is not browser-native zoom. RTL and localization variants are not implemented or claimed. |
| Writing | Checked action labels, recoverable errors, loading/empty states, units, fee explanation, exact-input terminology, donation consequences and router limitation beside the signing control. Rejection now clears obsolete wallet instructions. | No translations or copy experiment. |
| Typography | Inspected hierarchy, wrapping and numeric stability at tested widths. Browser verified local DM Sans loaded. Inputs are at least 16px. Long identifiers expand/wrap in details. | No cross-platform font-rendering or native iOS check. Small decorative ticket text is hidden from assistive technology and duplicates no required information. |
| Colors | Inspected actual foreground/background roles and computed rendered contrast. Body/page 14.09:1; secondary/page 5.11:1; collection copy/tint 4.65:1; primary label/lime 11.38:1. Status uses redundant text. | Only one light theme exists. Contrast measurements do not claim comprehensive WCAG compliance. |
| UI | Inspected panel/field/button states, native details, loading, empty, error and review states; keyboard focus and CTA visible in screenshots. Hover is media-gated. Only 120ms color/border transitions exist and are disabled for reduced motion. | No animated entrance, dialog, tooltip, alternate theme or motion timeline requiring a slowed replay. |

## Findings, fixes and rechecks

| Severity / domain | Source | Finding and correction | Evidence after correction |
| --- | --- | --- | --- |
| High / integration | `web/config/workflow.json:2`, `web/scripts/export.mjs` | An initial manual router transcription had an extra hex character. Corrected to the exact supplied address and added a build-time 40-hex-character check. | Final manifest address matches the workflow; all three RPCs report 6,950 bytes of router code and its expected manager. Browser buy/sell tests target that address. |
| High / writing and UI | `web/src/App.tsx:1017`, `web/src/services.ts:319` | PoolSwapTest cannot enforce minimum net output or a deadline. The form explicitly explains this, implements a directional price limit, simulates the final route, discloses partial fill and requires acknowledgment. | Quote, partial-fill, acknowledgment, expiry and pre-sign simulation scenarios pass. This is an inherent router constraint, not a claim that it was removed. |
| Medium / data integrity | `web/src/services.ts:176` | The first history reader lacked an independent RPC-chain check. Added chain validation and a behind-deployment guard before event scans. | Wrong-chain browser fixture now rejects both state and history rather than showing a potentially misleading zero. |
| Medium / accessibility | `web/src/App.tsx:907`, `web/src/App.tsx:966` | A price-limit validation error originally marked the amount input invalid. Added field-specific invalid state and retained focus/description on the field that failed. | Browser fills 51%, submits, checks focus and invalid state on price limit and verifies amount remains valid. |
| Low / writing | `web/src/App.tsx:275` | Wallet rejection left an obsolete “confirm in wallet” status beside the rejection message. The error path now clears that status. | Rejection test and narrow-screen screenshot show the recovery message without the obsolete instruction. |
| Evidence correction | `web/tests/browser.mjs` | Programmatic focus after a pointer action initially did not exercise `:focus-visible`. The test now traverses with Tab, activates with keyboard and captures the resulting 3px blue outline. | `frontend/keyboard-focus.png` was opened and inspected; computed focus is `rgb(52, 93, 209) solid 3px`. |

No observed product blocker remains in the tested frontend scope. `docs/DESIGN.md` documents final implemented values rather than a proposed design.

## Evidence files

- `frontend/browser-results.json`: scenario outcomes, three axe result sets, browser version, console/resource failures and computed-style samples.
- `frontend/contrast.json`: computed foreground/background pairs with measured ratios and loaded-font confirmation.
- `frontend/desktop-disconnected.png`, `desktop-connected.png`, `keyboard-focus.png`, `tablet.png`, `mobile.png`, `mobile-320.png`: production export with mocked wallet/state. Desktop, focused CTA and narrow screenshots were opened for visual review.
- `frontend/live-browser.json`, `live-desktop.png`: actual public-RPC browser session; no wallet, mocks or transaction signing.
- `frontend/live-chain.json`: read-only RPC chain, bytecode, bindings and pool-state evidence for each supplied endpoint.
- `frontend/integrity.json`: scope and conservative submission-size accounting.
- `frontend/dev-smoke.json`: development manifest and source-module smoke checks.

The live browser observed approximately 50,000,000 NFTD per ETH at block 11,791,554, with no confirmed fee events through block 11,791,548. These are point-in-time readings, not hardcoded UI values or price promises. The separate RPC check observed zero active liquidity, which correctly disables donation; it does not prove that a swap cannot cross into another range.

## Limitations and delivery status

**Frontend implementation, static export and local validation are complete within the writable scope. Git commit creation is blocked by the environment.** The explicit command `git add -- web dist docs` failed with `.git/index.lock: Read-only file system`. Source, lockfile, final static files and evidence remain available for the assignment's collector/publisher to commit. No attempt was made to bypass the read-only repository metadata or change protected paths.

The final Git submission bundle cannot be generated on this worker. The full prospective tree plus packed retained history and a 1 MiB overhead allowance is below the 8,388,608-byte limit; `frontend/integrity.json` records the exact conservative calculation. Dependencies and npm/browser caches are absent from the prospective file list at every nesting level. The only changed ignore path is the explicitly budgeted `web/.gitignore`.

No real swap, approval or donation was broadcast. Real extension-wallet signatures, gas behavior, MEV/price movement after signing, contract/ERC-4337 wallet relayer behavior, deep reorgs, prolonged RPC truncation/outages and very large historical scans remain untested live-chain behavior. Browser tests use controlled events/receipts and do not certify contract economics. A six-block buffer does not provide absolute finality, and RPC providers remain trusted for the completeness of returned log ranges.

IPFS pinning, fixed-CID/named-host checks, published URLs, source publication, redeployment and control-plane attestation verification were not performed or claimed. They belong to the subsequent publisher/control-plane stage. This worker evidence is not independent network certification.
