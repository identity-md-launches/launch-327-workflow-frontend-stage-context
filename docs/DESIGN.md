# Holder Discount design

## Overview

The page serves visitors to the Sepolia ETH/NFTD pool: discover NFT eligibility, understand fees, trade and return fees to LPs. Its cream background, dark olive text, pale green collection panel and lime primary action keep the page calm while distinguishing the active transaction control. The collection illustration is decorative CSS artwork, not an image of a visitor's NFT.

The page groups collection and fee information in a wider column, with a swap panel alongside on desktop. Lifetime totals, donation and activity stay separate from transaction controls. Technical limitations affecting a transaction stay visible; contract details and eligibility context use native expandable sections. English and one light theme are implemented.

Source of truth: `web/src/styles.css`, `web/src/fonts.css`, and `web/src/App.tsx`. This document is intentionally under `docs/`: the assignment's explicit file scope prohibits creating root `DESIGN.md`.

## Colors

Primitive values and semantic roles are defined in `styles.css:3`.

| Semantic token | Value | Role |
| --- | --- | --- |
| `--page` | `#f7f8f2` | Page background |
| `--surface` | `#ffffff` | Panels and controls |
| `--surface-soft` | `#eff1e9` | Fields, segmented-control track, review notes |
| `--text` | `#20291c` | Headings, body, primary-action text |
| `--muted` | `#646c5e` | Secondary copy, labels and inactive controls |
| `--border` | `#d8ddce` | Structural outlines |
| `--accent` | `#c5ee79` | Primary transaction action, decorative brand elements |
| `--accent-hover` | `#b3df63` | Primary-action hover |
| `--tint` | `#e7f1cf` | Collection panel |
| `--link` | `#425e26` | Links and network/status dot |
| `--warning-bg` / `--warning-text` | `#fff3df` / `#775113` | Recoverable network/read notices |
| `--error` | `#a42d2d` | Validation and transaction errors |
| `--focus` | `#345dd1` | Keyboard focus perimeter |

Status always has text in addition to color. The bright filled action is reserved for the current swap-flow step. Donate and wallet controls remain outlined. The decorative ETH token marker uses `#e2e5f2` with `#50577a`; the NFT card has an illustrative `#c4d5a3` offset shadow. These are local illustration treatments rather than extra interaction states.

Measured rendered pairs: body text/page 14.09:1, secondary text/page 5.11:1, collection secondary text/tint 4.65:1, primary label/accent 11.38:1. Measurements and computed styles are in `frontend/contrast.json`. No dark-theme contrast claim is made.

## Typography

DM Sans is locally bundled at `web/src/assets/dm-sans-latin.woff2`, with a `system-ui, sans-serif` fallback. The variable normal face declares weights 100–1000; the page uses 400, 500 and 600. The browser confirmed that the font loaded. `font-synthesis: none` avoids invented font faces. The local normal face is the only font asset; no separate italic font is shipped.

Body base is 16px and line-height 1.5. Semantic small sizes are 12px, 13px, 15px and 18px. The hero uses `clamp(2.5rem, 4.7vw, 3.65rem)`, weight 500, 1.07 line-height and -2.3px letter-spacing; at the narrowest breakpoint it uses 2.45rem and -1.6px. Panel headings are generally 1.45rem/500/1.2. Dense desktop captions use 10–13px, with transaction explanatory copy raised to 12px in the stacked layout. Amount inputs are 1.9rem; the price-limit input is 1rem, avoiding mobile input zoom caused by undersized fields.

Headings use `text-wrap: balance`; descriptions use `text-wrap: pretty`. Long narrative copy caps its measure; addresses and hashes wrap with `overflow-wrap: anywhere`. Changing amounts use tabular numbers. Exact full-unit values remain available in amount titles; token units are visible. Important addresses are expanded in the contract details and explorer links, while wallet/transaction summaries use shortened labels.

## Layout

`.wrap` caps page width at 1192px with 36px inline padding. Common spacing is 4, 8, 12, 16, 24, 32, 48 and 64px. Desktop `.main-grid` uses `minmax(0, 1.45fr) minmax(0, 1fr)` with a 24px gap. Panel padding is generally 28px (swap 26px). The DOM remains collection, statistics, donation, swap, transaction status, activity and expandable details.

At 67rem the grid ratio becomes 1.2:1 and spacing tightens. At 53rem the grid stacks, header navigation hides, page padding becomes 24px, and the decorative hero note hides. At 30rem padding becomes 16px, panel padding becomes 22px/18px, collection balance/fee stack, activity rows wrap and contract details become one column. Wallet actions remain available. The collection illustration scales inside its own column and has no meaning withheld from assistive technology.

Reflow was checked in Chromium at 1440, 780, 390 and 320 CSS pixels and with 200% CSS text enlargement at 320px. No horizontal overflow was observed. Browser-native zoom, physical-device behavior and translated layouts remain unverified.

## Elevation & Depth

This is mostly a flat system: 1px borders and tonal fills define groups. The swap panel uses `0 4px 16px #20291c06`, and selected direction buttons use a subtle `0 1px 2px #20291c08` shadow. The decorative ticket has a deliberately visible offset shadow. There are no dialogs, floating transaction overlays or sticky layers covering content.

## Shapes

Shared panels use `--radius: 20px`, reduced to 16px on narrow screens. Amount fields use 12px, buttons 10px, the direction track 9px with 6px inner buttons, and compact pills 6px. Token symbols and activity markers are circles. The static NFT ticket tilts 8 degrees; its flower uses four bordered circles. Decorations are marked `aria-hidden` and never intercept a control.

## Components

`App.tsx` owns one `Pool` screen and small presentational helpers:

- `External`: descriptive explorer/external links, a decorative arrow and accessible new-tab notice.
- `Amount`: token units, compact decimal display and exact-value title. Raw values remain bigint until presentation.
- `Arrow`: one 1.8px-stroke SVG for directional button/flow cues.
- `.panel`, `.section-heading`, `.metrics` and `.activity-row`: consistent grouping patterns, not a separate component-library API.
- `.direction`: two native buttons with `aria-pressed`, keyboard activation and explicit selected/disabled styling.
- Swap form: visible labels, decimal keyboards, field-specific `aria-invalid`, shared described errors and focus on the invalid control. A checkbox discloses the test router's output/partial-fill limitation before signing.
- Donation preview: first simulation, visible consequence text, confirm and cancel. Both stages use current state.
- `.status-panel`: stable polite status and alert regions; pending, confirmed, reverted and unknown receipts include explorer links.
- Native `<details>` sections: browser-managed keyboard disclosure for eligibility and contract configuration.

Normal buttons have at least 44px height, primary actions 48px. The segmented direction controls are 38px high with distinct padding; they exceed the 24px accessibility baseline. `:focus-visible` supplies a 3px blue outline with 4px offset; forced-colors uses system `Highlight`. Hover rules only apply when hover is available. Motion is limited to 120ms background/border-color transitions under `prefers-reduced-motion: no-preference`. No movement is necessary to understand status.

## Do's and Don'ts

- Reuse `.wrap`, panel grouping, heading roles and semantic color tokens for an additional section. Preserve DOM reading order when adding responsive columns.
- Keep one filled current swap action; use outlined or text controls for peer operations.
- Always name the currency and distinguish accrued claims from lifetime event totals.
- Show missing or incomplete data as unavailable/loading, never as a fabricated zero.
- Keep price-limit and fee limitations beside the transaction controls. Never label this router's estimate a guaranteed minimum.
- Preserve labels, visible focus and keyboard activation; retain native controls and disclosure elements.
- Keep the font and runtime assets local. Do not introduce another theme or typography system without changing the implemented tokens and verifying it.

## Attribution

Design guidance is adapted from Jakub Krehel's [Better Interface](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-interface), MIT, commit `267330e1adfc66a718fb65fa6918c1f06d0a689e`, as supplied in the pinned assignment reference. Documentation method is adapted from Paul Bakaus's [Impeccable document guide](https://github.com/pbakaus/impeccable/blob/9d715cc4f5564a990ca8345abfdd5df6dc9b41c8/skill/reference/document.md), Apache-2.0, commit `9d715cc4f5564a990ca8345abfdd5df6dc9b41c8`. The reference text was consulted, not redistributed as application code. DM Sans's original OFL notice is retained in source and static export.
