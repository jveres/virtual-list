# Constrained table layout comparison, October 2, 2026

Changing host-owned tables from automatic to fixed layout does not justify a
production change in these Firefox workloads. Total sampled content-main-thread
CPU across all three cases and measured phases is 941 ms at baseline, 943 ms
with fixed layout, and 964 ms in the restored automatic-layout control.
Geometry and content are identical at every validation checkpoint.

This closes the constrained-table hypothesis in the
[web-research review](virtualization-web-research-2026-10-01.md). It does not
claim that fixed layout can never help another table design. The experiment's
fixtures and regression remain reusable; production CSS stays unchanged.

## Comparison

Each case contains one 1,200-row, four-column table and 24 small surrounding
rows. Both controls use explicit 12% / 20% / 23% / 45% column widths, a full-width
table box, and the same wrapping rules. The candidate changes only
`table-layout: auto` to `fixed`.

The cases contain ordinary wrapping cells, long unbroken strings, or 100
decorative inline images with known dimensions. Each performs four traversals,
four width changes between 1,100 and 650 CSS pixels, and four batches of 25 live
cell edits. Text hashes, column widths, row heights, image counts, every cell's
overflow, full-table selection, actual movement, and disposal are checked.

| Case / measure | Automatic baseline | Fixed layout | Automatic repeat |
| --- | ---: | ---: | ---: |
| Ordinary: synchronous list creation | 75 ms | 70 ms | 66 ms |
| Ordinary: creation synchronous reflow markers | 31.13 ms | 30.85 ms | 31.05 ms |
| Long cells: synchronous list creation | 53 ms | 52 ms | 53 ms |
| Long cells: creation synchronous reflow markers | 30.59 ms | 29.92 ms | 31.01 ms |
| Images: synchronous list creation | 39 ms | 38 ms | 41 ms |
| Images: creation synchronous reflow markers | 27.79 ms | 27.69 ms | 29.14 ms |
| All cases: content-thread CPU in preparation | 149.92 ms | 149.53 ms | 152.06 ms |
| All cases: content-thread CPU in all marked phases | 940.79 ms | 942.88 ms | 964.11 ms |
| Traversal, resize, and edit frame gaps above 25 ms | 0 | 0 | 0 |

The ordinary case's faster creation also appears in the restored control.
Its Markdown rendering falls from 33 to 27 to 24 ms, while creation reflow stays
near 31 ms. That is not evidence that fixed table layout improves creation.
Resize and live-edit CPU differences are mixed across cases. No memory or
physical-presentation improvement is established.

[MDN's table-layout reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/table-layout)
describes how fixed layout uses explicit widths instead of deriving horizontal
sizing from cell contents. These controls already specify columns, and the
remaining cell layout still costs work. The measured results supply no useful
overall saving here. This is not a comparison of the renderer's default
content-sized, horizontally scrollable tables against a different layout
policy; both controls accept the same host-owned constraints.

## Conditions and limits

Revision `93b53e7` plus the recorded fixture and runner patch. All three captures
have identical source hashes. The production runtime is unchanged from v0.4.12.
Installed Firefox 157.0, build `20260924084938`, macOS 27.0; fresh temporary
profiles and closed DevTools. LU28R55 is 1,920 × 1,080 logical pixels, 2× scaling,
60 Hz. The outer window is 1,900 × 1,049 at `(1450, 31)`, with a 1,900 × 964
content area.

These are the three timing trials for this comparison. Creation starts after
module initialization and does not measure demo boot. Traversal uses instant
API offsets, not native gesture release. Frame samplers read timestamps only;
edit and resize sampling starts before the mutations. Geometry and selection
validation run outside the timed phases. Creation is reported separately from
the traversal/resize/edit frame-gap counts.

CPU values interpolate boundaries of 2 ms samples and cover the selected
content main thread. Rendering markers can overlap and must not be added to CPU
as independent work. Profiling adds overhead, and regular animation-frame
callbacks do not prove smooth physical presentation.

## Reproduction and verification

The [table workflow](../memory-profiling.md#compare-constrained-table-algorithms)
records the commands and controls. Compact local evidence is retained under:

- `browser-artifacts/table-layout-baseline/run-nWC15Z/`
- `browser-artifacts/table-layout-fixed/run-qp4fYc/`
- `browser-artifacts/table-layout-restored/run-LIrtNZ/`

Each directory contains only its summary, reproduction metadata, and source
patch. All captures complete with empty cleanup-error arrays. No raw profiles,
temporary browser data, or generated capture helpers remain in those runs.

`pnpm run check` passes with the two existing CSS warnings. All 5,650 unit tests
and 195 portable profiler checks pass. All 18 table cases pass in Firefox,
Chromium, and WebKit. After moving frame timestamps before mutations, the final
Firefox regression repeats all six combinations successfully.

Reject a production fixed-table-layout change for these results. Continue with
the separate large-row construction and staging hypothesis.
