# Demo performance audit

The September 6, 2026 audit covered all six demos with native macOS scroll
input in Firefox 155.0.1 on the external LU28R55 display: a 1900 × 965 CSS-pixel
viewport, 2× scaling, and 60 Hz. Each capture used a fresh browser profile
with DevTools closed. Raw evidence remains local in `browser-artifacts/firefox/`.

The audit removed measured application overhead. It did **not** establish
that intermittent compositor or physical-display jitter is eliminated.

## Changes and measured effects

The profiling changes are in demo adapters and diagnostic UI. A later chaos
reproduction also identified a core scroll-lifecycle defect, described below.
Reflow totals are summed marker durations, not exclusive CPU time.

- Streaming: reuse the runtime's scroll snapshot for sticky headers, sample
  native scrolling in the capture phase, retain unchanged overlay content,
  and preserve fractional push-off positions. Skip unchanged status text.
  During active replies, status-related synchronous reflows fell from 870
  to 81 (`run-mmIy8H` versus `run-D3xDc2`).
- Dynamic height: skip unchanged diagnostic text. Status-related reflow time
  fell from 162 ms to 35 ms across comparable down/up captures
  (`run-rIMtJU` versus `run-XAN3XX`).
- Scroll settle: read viewport geometry before status writes and batch the
  shared visible trace once per frame. Trace export remains immediate and
  bounded. Log-related reflow time fell from 338 ms to 187 ms; status-related
  reflow time fell from 65 ms to 4 ms (`run-Y3WG31` versus `run-RDXkJ9`).
- Feed: skip unchanged edge and status labels. Both Bluesky and Lemmy were
  exercised, including paging.
- Gallery and newspaper: no application patch was justified by these
  captures. Both gallery layouts and all four newspaper variants were tested.
  A later gallery rows paging report led to the anchor fix described below.

## Repeat captures

These are animation-frame intervals, not physical presentation measurements.
"Moving max" includes intervals where the sampled scroll position changed.
The profiler flags intervals above 25 ms at 60 Hz, including stationary time.

| Workload | Capture | Max / moving max (ms) | Gaps above 25 ms |
| --- | --- | --- | --- |
| Streaming history upward | `run-99izYK` | 17.64 / 17.60 | 0 |
| Streaming active reply upward | `run-D3xDc2`, `run-1yxjDW` | 17.64 / 17.56; 24.78 / 24.78 | 0; 0 |
| Dynamic height down/up | `run-XAN3XX` | 17.62 / 17.62 | 0 |
| Dynamic height upward after shared log change | `run-5zekBK` | 17.60 / 17.50 | 0 |
| Scroll settle down/up and top paging | `run-RDXkJ9`, `run-Mgmamx` | 23.94 / 17.50; 17.64 / 17.64 | 0; 0 |
| Feed Bluesky | `run-dKBrLD` | 24.34 / 17.58 | 0 |
| Feed Lemmy, live GPU capture | `run-3Ec49S` | 33.30 / 17.54 | 1, stationary |
| Gallery rows | `run-ZM3SUV` | 22.98 / 17.52 | 0 |
| Gallery masonry | `run-iITXEu` | 22.12 / 17.68 | 0 |
| Newspaper Radar | `run-eck6UY` | 21.44 / 17.66 | 0 |
| Newspaper Broadsheet, warmed after switch | `run-TVA7wp` | 26.42 / 17.66 | 1, stationary |
| Newspaper Modular | `run-gU49rR` | 17.64 / 17.64 | 0 |
| Newspaper Reader, warmed after switch | `run-OJoInr` | 17.54 / 17.54 | 0 |

## Unresolved intermittent stalls

Clean repeats do not erase earlier failures. Streaming captures included
100 ms (`run-8VPo4O`) and 217 ms (`run-mmIy8H`) moving gaps; Lemmy included
a 333 ms moving gap (`run-qvU9ZX`). The inspected main-thread samples did not
show corresponding sustained application CPU work. Shutdown profiles omitted
GPU tracks, so those captures cannot establish a GPU root cause.

Live collection was added to retain GPU threads. Broadsheet's first live
capture (`run-4GBDVx`) contained 266 ms and 83 ms moving gaps. The first gap
aligned with a roughly 258 ms `WR OS Compositor frame` on the GPU Renderer
thread while the page's main thread was idle. This localizes that stall to
the rendering/compositor path, but does not distinguish painting, driver
waiting, or macOS scheduling.

The original variant setup returned before its asynchronous switch finished.
The runner now waits another warmup interval after optional setup. The warmed
Broadsheet repeat did not reproduce the large stall. That is a workload
correction, not proof that startup caused every intermittent gap or that an
application change fixed the compositor. Normal browser preferences and
display settings were not changed.

## Chaos resize regression

The standard browser matrix passed, but did not exercise chaos. A subsequent
Firefox 155 report showed a geometry violation when chaos changed viewport
width during a command glide. A seeded Firefox automation run reproduced
49 geometry violations.

The width observer ended the controller's scroll phase without cancelling
its JavaScript glide. Later frames continued writing under an idle controller,
allowing geometry commits during the old animation. Width changes now cancel
the old command before committing, resolving it as interrupted. Automatic
end-follow retains its intent and catches up in a fresh phase. Height-only
resizing retains its previous behavior.

A focused unit test failed before the fix: the old glide continued from the
resize position of 1517 px to 5400 px. Regression tests now cover command
cancellation and retained end-follow intent. The standard browser matrix also
includes a width change during a glide, without a pointer event that could
mask the defect by cancelling the animation first.

Native chaos also exposed detector errors: pre-resize input was attributed
to the width takeover, and a command write without a canvas mutation could
be attributed to a later live commit. The lab now observes actual width
delivery before the runtime's observer, permits that takeover batch, and
retires command-write attribution at its microtask boundary. A separate
regression deliberately makes an illegal write under fresh input after the
resize and confirms that it still raises exactly one `W` violation in all
three engines and update modes.

The corrected native down/up capture (`run-0KdN1S`) exercised 76 chaos
operations and 945 scroll events with zero violations, clipped rows, or paint
mismatches; its maximum animation-frame interval was 17.62 ms. The earlier
long chaos capture (`run-ColcDn`) retained diagnostic traces but failed profile
analysis because its complete start/end marker pair was unavailable. It is
not valid timing evidence.

## Gallery rows append regression

A later Firefox report identified a 5–10 px content shift when loading more
photos at the bottom. A targeted reproduction measured 5–6 px shifts in rows;
masonry did not reproduce the defect and remains unchanged.

When the viewport starts in the gap below a photo row, the reading anchor
clamped the photo fraction but discarded the remaining gap distance. Restoring
that anchor after append moved all visible photos. The rows anchor now retains
the signed distance outside the photo while preserving its fractional position
inside the photo for resizing.

The strengthened paging regression compares actual visible photo coordinates,
not just an anchor round trip. It failed with a 5 px shift before the patch and
passes afterward with a 1 px tolerance. Firefox coverage includes rows at 1×
and 2× scaling, masonry at 1× and 1.25×, forward and backward loads, source
eviction, bounded DOM size, clipping checks, and resizing.

## Verification

The final checks pass with 395 unit tests across 21 files, seven profiling
analyzer tests, and TypeScript checking. Biome reports 16 existing newspaper
CSS specificity warnings.

The standard browser matrix passes in Chromium, Firefox, and WebKit across
all three lab update modes and the chat scenarios. The focused width-resize
regression also passes in all three engines and update modes. A Firefox chaos
soak runs for 120 seconds from each of the three initial update modes with
seed 17 and reports zero violations, paint mismatches, clipped rows, or errors.
Chaos can change the update mode during each run.

Gallery controls, paging, resize, header, reload, photo-preview, and preview
cleanup regressions pass. Feed and all four newspaper variants also pass
their Firefox and WebKit regressions.

## Next steps

If physical jitter persists, capture the actual trackpad gesture with `--live`
on the same display. Inspect presentation and renderer tracks around the
reported hitch before proposing another application patch. See
[Firefox-first profiling](firefox-profiling.md) for capture instructions and
limitations.
