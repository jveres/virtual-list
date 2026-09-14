# Renderer-owned streaming trail release audit

The accepted shared-overlay effect is released as `markdown-viewer` v0.2.0,
commit `774effe127b0503aa106a76a4f3520e5ba6927e4`. The renderer commit and
annotated tag are pushed. The initial integration pinned that tag; the cursor
patches below advance the pin to v0.2.4. The dependency, lockfile, and
exact-commit build permission are updated together.

## Ownership and API

The renderer accepts `streamingTrail: false | { durationMs?: number }`.
It defaults off; an empty object uses 1,200 ms. The renderer owns text tracking,
range geometry, shared blending, browser opacity animations, reduced motion,
and cleanup. No trail API or implementation was added to virtual-list's core.

The streaming demo offers off, 600 ms, and 1,200 ms. Its message-content adapter
only passes renderer options, disables the trail on unmount, restores it on
mount, and destroys the renderer through the existing row lifecycle. Hidden
retained rows do not run trail observers. Finalization preserves active fade
ages, while disablement and destruction clear the effect immediately.

The discarded CSS and per-group demo implementations are removed from product
code. Superseded source snapshots remain recoverable locally under ignored
`browser-artifacts/streaming-trail/retired-prototypes/`. Maintained regression
scripts and the complex synthetic fixture remain in `scripts/`; curated
performance reports remain in `docs/reports/`. Historical reports now identify
retired controls and distinguish prior measurements from current API behavior.

## Audit passes

The review covers the migration diff in both repositories, renderer scheduling
and morph boundaries, callback/resource ownership, bounded text tracking,
runtime mount/unmount/destruction and hidden-measurement integration, paging
ownership, dependency boundaries, package output, tests, and affected docs.
This is a scoped code audit with targeted verification, not a proof that all
possible inputs or browser behaviors are defect-free.

| Pass | Findings and resolution |
| --- | --- |
| Ownership review | Demo-owned trail observation and geometry required copying renderer-specific behavior into hosts. Move the accepted implementation behind the renderer's optional API. Remove alternative demo controls and duplicate implementations. |
| Renderer review | Fix three medium lifecycle findings: animation of fallback content, inline-position priority/ownership restoration, and late clipboard feedback after disposal/removal. The clipboard reproducers failed before the fix; regression coverage now includes feedback timers, frames, and stuck classes. No high findings identified. |
| Integration review | Update the tag, lockfile, exact-commit build permission, and consumer documentation together. Remove stale prototype references from maintained scripts. Verify hidden/remounted rows through the public renderer API. No additional high or medium runtime findings identified. |
| Repeat review | Recheck the fixes, lifecycle boundaries, public-only integration, generated package, and installed-tag tests. No remaining high or medium findings identified in the reviewed scope in either repository. |

The renderer's detailed audit ships in
[its v0.2.0 audit report](https://github.com/jveres/markdown-viewer/blob/v0.2.0/docs/CLEAN_CODE_AUDIT_2026_09_14.md).
An existing low-priority packaging limitation remains: published source maps
refer to omitted TypeScript sources, producing diagnostic warnings in Vitest.
Execution and the checks below pass; no runtime failure is attributed to these
warnings.

## Verification

The renderer passes formatting, lint, library/test/playground type checks,
1,079 tests across 40 files, a clean build, and package-boundary checks.
Generated output totals 484,344 bytes, including declarations/maps, and
263,894 runtime JS/CSS/SVG bytes, excluding dependency contents. The feature
release has explicit 500,000/280,000-byte ceilings and no new dependencies.

Against the installed GitHub tag, virtual-list passes:

- `pnpm run format`, `pnpm run check`, and 934 tests across 40 files.
- `pnpm run test:firefox-profile`: all 24 portable tooling checks.
- `pnpm run test:consumer`: both isolated source-only consumer builds.
- `streaming-trail-regression.mjs`: Firefox, Chromium, and WebKit; text
  coverage, wrapped geometry, tables, final fades, idle geometry reads,
  preserved ages, bounds, reduced motion, demo toggles, and hidden-row lifecycle.
- `streaming-trail-shared-regression.mjs`: all three engines in light and
  dark mode; stable pixels across DOM replacement and tight, shrinking bounds.
- `profiling-fixtures-regression.mjs`: tracked fixtures, including all 70
  sections of the 67,760-character reply, active trail, following, and cleanup.
- `markdown-streaming-consumer-regression.mjs`: all three engines; public
  Markdown rendering, finalization, and composer sizing.

Earlier attempts interrupted by Vite reloads or stale dependency optimization
were not passes. The final browser checks use an isolated cache and the actual
installed tag, without local renderer aliases. Temporary test servers and
browser processes are closed; the pre-existing user server is preserved.

No new native performance capture or installed-Safari run was made for this
packaging migration. The [complex-fixture comparison](shared-streaming-trail-2026-09-14.md)
remains the performance evidence, with its original limitations. Moving the
effect into the renderer is not evidence of a further CPU gain or zero cost.

## Cursor patch: v0.2.1

The v0.2.0 migration missed the accepted prototype's cursor-height correction.
The patch release, commit `6b0d57a2094de87f107a7dac4a2b21d8a0ea3ed3`, moves
that correction into the renderer's base CSS, independent of `streamingTrail`.
Inline cursors, including code cursors, paint the inherited font box without
adding inline width. A no-wrap rule prevents the painted padding from creating
an extra line in narrow table cells. Standalone cursors retain their one-`em`
layout reservation. Hollow cursors remain supported. No JavaScript or API is
added for cursor sizing.

The new `scripts/regressions/runtime/cursor-font-box-regression.mjs` reproduces
the old mismatch in Firefox: a 24 px cursor beside a 28 px text box. The fixed
renderer passes in Firefox 153.0, Chromium 151.0.7922.34, and Playwright WebKit
26.5 at a 900 × 900 viewport and 2× device scale. Coverage includes paragraphs,
headings, lists, quotes, tables, fenced and inline code, identical trail-on/off
geometry, hollow state, and standalone spacing. This is automated browser
correctness evidence, not an installed-Safari or performance measurement.

Renderer formatting, lint/type checks, all 1,079 tests, build, and package
checks pass. Output is 483,321 total bytes and 262,871 runtime bytes, within
the unchanged package ceilings.

The installed v0.2.1 tag also passes the cursor regression and
`markdown-streaming-consumer-regression.mjs` in all three engines, without
local-source aliases. Virtual-list passes formatting, lint/type checks, and
all 934 tests. The existing source-map warnings remain unchanged. Temporary
test browsers and the isolated server are closed; the user's server is kept.

## Cursor refinement: v0.2.2

The patch at `a2e7358b6437dde176105569237537d561fae5b8` insets cursor paint
by one CSS pixel at the top and bottom without changing layout. Solid and
hollow cursors have square corners; the unused corner-radius variable is
removed. The renderer demo adds a live **Streaming trail** toggle and uses
the public unfocused-cursor option instead of overriding cursor CSS.

Pre-release pixel comparisons confirm the one-pixel inset at both edges in
Firefox, Chromium, and WebKit, including hollow mode. The demo toggle was
checked off/on during streaming in all three engines. Renderer checks, all
1,079 tests, and the build pass. Package output is 483,803 total bytes and
263,353 runtime bytes, within the unchanged ceilings.

Against the installed tag, the updated cursor regression passes in all three
engines. Virtual-list formatting, lint/type checks, and all 934 tests pass.

## Trail inset: v0.2.3

The patch at `ad02814f2a39deb51cfbf4cfe411c49fd51c704e` insets each trail
rectangle by one CSS pixel at the top and bottom only. Horizontal coverage,
text layout, fade timing, and the public API stay unchanged. Clipping still
protects code and table boundaries, and empty rectangles are skipped.

Pre-release geometry checks pass in Firefox, Chromium, and WebKit for wrapped
paragraphs, lists, quotes, fenced code, and tables. The renderer's 1,079 tests,
lint/type checks, and build pass. Package output is 483,936 total bytes and
263,452 runtime bytes, within the unchanged ceilings. No new performance
claim is made for this visual refinement.

The installed v0.2.3 tag passes `streaming-trail-regression.mjs` in Firefox,
Chromium, and WebKit, including the updated inset geometry, final fades,
reduced motion, cleanup, and demo toggle. Virtual-list formatting, lint/type
checks, and all 934 tests pass.

## Standalone cursor: v0.2.4

The patch at `5954a26caadea4902af904f70dc8b97d44230267` gives standalone
and inline cursors the same painted height. Standalone cursors keep their
one-`em` layout reservation. Square corners and the one-pixel top and bottom
inset stay unchanged. The patch changes only CSS and adds no API.

Pre-release pixel comparisons pass in Firefox, Chromium, and WebKit at 2×
device scale, with 16 px and 24 px fonts. Coverage includes solid and hollow
cursors, empty content, and standalone cursors after a block. All cases match
the inline cursor height without changing layout. In Firefox with a 16 px
font, standalone paint changes from 11 px to 17 px, matching inline paint.

The renderer passes all 1,079 tests. The versioned package passes lint/type
checks and the build. Output is 483,315 total bytes and 262,831 runtime bytes,
within the unchanged ceilings. These are browser correctness results, not an
installed-Safari or performance measurement.

The installed v0.2.4 tag passes `cursor-font-box-regression.mjs` in Firefox
153.0, Chromium 151.0.7922.34, and WebKit 26.5. Virtual-list formatting,
lint/type checks, and all 934 tests pass. The existing source-map warnings
remain unchanged.
