# Clean code audit after the v0.5.0 hot-path release

The audit starts at `cf6a572` (`v0.5.0`). Two review passes remove unused
runtime methods and state, unexport internal-only interfaces, deduplicate demo
helpers and styles, clear stale tooling configuration hints, and update dev
dependencies.

## Scope and method

The audit covers `src/`, `src/companions/`, `integrations/`, `demos/`,
`examples/`, `scripts/`, `tests/`, and stylesheets:

- Reachability and configuration checks via `pnpm dlx knip@6.39.0` (including a
  second pass with `--include-entry-exports` and a cross-file internal-export
  check across `src/`, `integrations/`, `demos/`, and `examples/`).
- Clone detection via `pnpm dlx jscpd@5.4.0` at `12 lines / 100 tokens`,
  `8 lines / 65 tokens`, and `6 lines / 45 tokens`.
- Static verification via `pnpm run check` (`biome check . && tsc --noEmit`).

## Findings and corrections

| Area | Finding | Correction |
| --- | --- | --- |
| `src/declared-items.ts`, `tests/unit/declared-items.test.ts` | `DeclaredItems.holdsAt` became unused in production after `DeclaredItems.forEach(visit, unchanged)` superseded it in `commitBody`; `Declared<T>` was exported but only used internally. | Remove `holdsAt` and its unit-only assertions; make `Declared<T>` module-private. |
| `src/scroll-settle.ts`, `src/virtual-list.ts`, `tests/unit/scroll-settle.test.ts` | `ScrollSettleController.isTouchScrollPhase()` and `touchScrollPhase` became unused in production after commit `e38dadb` deferred all `safari-wheel` phases until settle; required `onGestureStarted` and `onGestureReset` host callbacks forced empty no-ops in `virtual-list.ts` and `scroll-settle.test.ts`. | Remove `isTouchScrollPhase` and `touchScrollPhase`, make `onGestureStarted` and `onGestureReset` optional on `ScrollSettleHost`, and remove the empty callbacks. Sync `README.md` and `docs/core-contract.md` with that WebKit settle rule. |
| `src/geometry.ts`, `src/virtual-list.ts` | `Commit` was exported from `src/geometry.ts` without external callers; `lastReconcile.structure` had an unnecessary `as number \| undefined` widening cast. | Make `Commit` module-private and type `lastReconcile.structure` as `number`. |
| `demos/` internal exports | Eight interfaces/types (`ImageLoader`, `LayoutStrategy`, `ItemMeasurer`, `MessagePart`, `TreeEntry`, `ResponseContext`, `SimulatedHistory`, `ChatGPTAuthStatus`) were exported without external imports. | Make all eight module-private. |
| `demos/` duplicated helpers & styles | `isRecord` and `localStorage` JSON object parsing were duplicated across seven demo modules; `record` was duplicated between `chatgpt-auth.ts` and `chatgpt-relay.ts`; root-to-leaf active-branch traversal was duplicated between `activeLeafId` and `rebuildActiveTranscript` in `streaming.ts`; active touch lookup was duplicated in `photo-preview.ts`; header control styles were duplicated in `gallery.css`. | Share `isRecord` and `readStoredObject` in `demos/shared/utils.ts`, share `record` from `chatgpt-auth.ts`, extract `walkActivePath` in `streaming.ts` and `activeSwipeTouch` in `photo-preview.ts`, and combine shared header control rules in `gallery.css`. |
| `knip.jsonc`, `demos/shared/styles.css`, `package.json` | Knip reported four unused ignore hints (`loom`, `swift`, `sample`, `screencapture`); Biome warned on two intentional diagnostic `!important` declarations in `styles.css`; five devDependencies had newer patch/minor releases. | Remove stale entries from `knip.jsonc`, annotate the two diagnostic `!important` lines in `styles.css`, and update `@tanstack/virtual-core` (`3.19.2`), `@types/node` (`^26.6.5`), `playwright` (`^1.64.0`), `vite` (`^8.3.4`), and `vitest` (`^5.0.4`). |

## Verification

- `pnpm run build` (`biome check . && tsc --noEmit && vite build`): 0 errors, 0 warnings.
- `pnpm dlx knip@6.39.0`: 0 issues and 0 configuration hints; internal export reachability across `src/`, `integrations/`, `demos/`, and `examples/` reports 0 unused internal exports.
- `pnpm dlx jscpd@5.4.0` (`--min-lines 8 --min-tokens 65`): 0 TypeScript clones across `src/`, `integrations/`, `demos/`, and `examples/`.
- `pnpm outdated`: 0 outdated packages.
- `pnpm test` (61 files, 1,105 tests), `pnpm run test:consumer`, `pnpm run test:firefox-profile` (197 checks), and `pnpm run test:regression-runner` (11 checks): all pass.
