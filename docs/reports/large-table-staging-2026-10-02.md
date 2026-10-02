# Large table preparation, October 2, 2026

Keep table-only staging in the streaming demo's existing preparation hook.
For a completed 1,200-row Markdown table, the largest preparation frame gap
falls from 50.58 ms to 18.12 ms in the prototype and 18.26 ms in the final
implementation. Neither staged run has a gap above 25 ms. This trades total
work and readiness for responsiveness: readiness rises from 112 to 301 ms,
and sampled preparation CPU rises from 66.25 to 99.07–101.65 ms.

Reject the prototype's code-block staging. It leaves a 184 ms preparation gap
and increases readiness from 317 to 1,092 ms. Synchronous Markdown generation
still dominates the long pause.

## Change and scope

[`stageMessageLayout`](../../demos/streaming/staged-message.ts) already divides
replies with more than 16 top-level blocks across hidden preparation frames.
It now also withholds bodies containing at least 1,000 table rows and appends
up to 100 rows per step. A body starts filling only after its table wrapper
enters the preparation row. Ordinary tables keep their existing path.

The hook moves existing nodes, preserving text, whitespace, listeners, and
node identity. Cancellation restores all withheld content before destruction.
The runtime reveals the completed row after measuring its full content. No
table layout policy, code renderer, dependency, or core list API changes.
The threshold limits the tradeoff to exceptionally large tables; this study
does not establish 1,000 rows or 100 rows per step as universal optima.

## Comparison

Each case contains one completed large reply and 24 small surrounding rows.
The cases are 120 independent sections containing 3,000 total code lines,
one 3,000-line code fence, and one 1,200-row four-column table. The fixture uses
the demo's actual Markdown renderer and staging hook. Preparation starts after
module initialization, through an empty list's `updateWindow` call.

| Case / measure | Existing hook | Code/table prototype | Final table-only hook |
| --- | ---: | ---: | ---: |
| Table: readiness | 112 ms | 301 ms | 301 ms |
| Table: largest preparation frame gap | 50.58 ms | 18.12 ms | 18.26 ms |
| Table: preparation gaps above 25 ms | 1 | 0 | 0 |
| Table: sampled preparation CPU | 66.25 ms | 99.07 ms | 101.65 ms |
| Table: longest synchronous reflow marker | 27.95 ms | 10.47 ms | 10.54 ms |
| Code fence: readiness | 317 ms | 1,092 ms | 316 ms |
| Code fence: largest preparation frame gap | 215.50 ms | 183.68 ms | 217.92 ms |
| Code fence: sampled preparation CPU | 263.99 ms | 403.70 ms | 261.39 ms |
| Independent blocks: readiness | 665 ms | 660 ms | 682 ms |
| Independent blocks: sampled preparation CPU | 310.00 ms | 316.72 ms | 320.20 ms |

The table's Markdown generation takes 14–15 ms and DOM construction 2–3 ms.
Staging can divide its substantial first-layout work. The code fence spends
157–169 ms generating Markdown HTML and 9–10 ms creating DOM. Appending its
existing descendants in 48 slices does not divide that generation work and
adds enough layout and scheduling cost to reject the candidate. The final
hook restores the code control's original behavior. Independent blocks still
take 23 steps, with no demonstrated improvement; final readiness is 17 ms
later than baseline.

All cases preserve final markup, element identity, full selection, measured
outer geometry, width-change selection, and disposal. Node counts and selected
character counts match across all three captures. Four API traversals, width
reduction from 1,100 to 650 CSS pixels, and end/start navigation verify actual
movement and scroll-end events. They do not measure native gesture release.

## Conditions and limits

Revision `a91e66c` plus each run's recorded source patch and hashes. The first
two runs use the old hook; the third uses the final production hook. These are
the three trials for this comparison, not three trials per variant.
Installed Firefox 157.0, build `20260924084938`, macOS 27.0; fresh temporary
profiles and application data, with closed DevTools. LU28R55 is 1,920 × 1,080
logical pixels, 2× scaling, 60 Hz. The outer window is 1,900 × 1,049 at
`(1450, 31)`, with a 1,900 × 964 content area.

The animation-frame sampler starts before preparation and reads timestamps
only. Readiness excludes module boot and the final diagnostic settling frames.
CPU covers the content main thread within the preparation marks, including
rendering and frame waits. The `markup` and `dom` marks are nested within
`prepare`; their CPU must not be added to the parent phase. Rendering markers
can overlap. Profiler overhead affects timing, and callback cadence does not
prove smooth physical presentation. This is not a memory-saving claim or a
cross-browser performance result.

## Reproduction and verification

The [construction workflow](../memory-profiling.md#compare-large-row-preparation)
contains commands and fixture controls. Compact evidence remains under:

- `browser-artifacts/row-construction-baseline/run-Oq8pJ9/`
- `browser-artifacts/row-construction-nested/run-cj3Ed6/`
- `browser-artifacts/row-construction-table-staging/run-7P6n3H/`

All captures finish with empty cleanup-error arrays. Raw profiles, temporary
browser data, helpers, and caches are removed. Reproduction metadata includes
the source patches needed to restore the pre-change baseline.

`pnpm run check` passes with the two existing CSS warnings. The edited unit
test also passes a direct strict TypeScript check. All 5,655 unit tests and
195 portable profiler checks pass. All 18 construction cases pass in Firefox,
Chromium, and WebKit; six staged-row integration cases additionally verify
hidden/inert preparation, atomic reveal, listeners, exact height, and restoring
a canceled table before `onDestroy`. Unit coverage includes multiple tables,
a table after withheld top-level blocks, ordinary tables, and cancellation
before and during preparation.

This closes the nested first-layout experiment. The remaining synchronous
code-rendering cost belongs to the renderer; the tested slicing mechanism does
not justify a code change there.
