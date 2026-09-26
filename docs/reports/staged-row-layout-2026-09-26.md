# Incremental first layout of large completed replies

Restoring a long completed reply now divides its initial layout into hidden
preparation slices. The largest staging callback falls from 50 to 10 ms in
Firefox, 35.6 to 13.3 ms in Chrome, and 53 to 14 ms in Safari in the matched
diagnostic pairs. This reduces the worst synchronous task; it does not reduce
total preparation work or establish smooth physical presentation in every case.

## Finding and change

The fresh installed-Firefox baseline at
`7629c3cb68968dc59f8614b30ee469443fcf28a8` confirms a 50 ms staging callback
while restoring the completed 44,230-character reply. Earlier native attribution
in the [image-batch report](streaming-image-batches-2026-09-26.md) identifies
style and first layout as a substantial part of this work. Yielding between
rows cannot bound the cost of one very large row.

The runtime adds an optional `stage(item, element)` hook for new measured rows
prepared by `updateWindow`. It runs after rendering and before connection. A
synchronous iterator can attach part of the content in each hidden preparation
slice; the existing warm layout read then lays out that part before yielding.
Only completed rows enter the atomic window commit. The ordinary synchronous
APIs and declared-height mode keep their existing rendering path.

The streaming demo uses the hook for completed or cancelled assistant replies
of at least 16,384 characters with more than 16 top-level markdown blocks.
It preserves the original nodes and attaches up to 16 blocks per slice, in
segment order. Tools, event listeners, text, and whitespace remain intact.
Cancellation, disposal, and width changes close an unfinished iterator before
destroying its row; the helper restores withheld nodes even when cancelled
before its first step. No persistent cache, extra wrapper, or frame-sampler
layout read is introduced. The renderer remains pinned to `markdown-viewer
v0.8.5`; this defect belongs to this repository's preparation path.

The tradeoff is more slices and longer total preparation. A single huge
top-level block is still indivisible, and rendering/parsing before staging is
still synchronous. Active streaming replies do not use this helper.

## Native diagnostic results

All native captures use the LU28R55 at 1920 × 1080 logical pixels, 2× scaling,
and 60 Hz, with 1900 × 1049 windows at `(1450, 31)`. Installed browsers are
Firefox 156.0.1, Chrome 153.0.8010.53, and Safari 27.0 (22625.1.29.11.27).
Their inner viewports are 1900 × 965, 1900 × 962, and 1900 × 997 respectively.
Profiles are temporary, DevTools are closed, and Safari's driver disconnects
before capture. No physical iPhone/iPad momentum measurement is included.

The deterministic workload uses 160 history turns, 48 reply sections, 461 text
chunks over 12 seconds, and a 20-second capture with four top/bottom commands.
Its hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
Diagnostic operation and scheduling probes are enabled. Chrome and Safari
reuse matching final image-batch captures as the baseline; Firefox starts with
a fresh baseline. Each performance pair uses probe version 4.

| Metric | Firefox: before → after | Chrome: before → after | Safari: before → after |
| --- | ---: | ---: | ---: |
| Largest staging callback | 50 → 10 ms | 35.6 → 13.3 ms | 53 → 14 ms |
| Bottom-phase staging callbacks | 12 → 36 | 9 → 30 | 12 → 32 |
| Bottom-phase staging total | 97 → 124 ms | 68.2 → 85.4 ms | 101 → 138 ms |
| Moving-frame p95 | 17.40 → 17.54 ms | 17.40 → 17.50 ms | 22 → 21 ms |
| Largest moving interval | 50.06 → 33.12 ms | 33.40 → 33.20 ms | 59 → 56 ms |

These are instrumented wall times. The pairs pass the browser, workload,
display, transport, and probe compatibility checks. The increase in total
staging time is explicit: the retained benefit is smaller individual tasks.
Firefox's final bottom command takes about 1.48 seconds to reach the tail,
versus 1.12 seconds in the baseline; its first directional movement is observed
45 ms after the command, versus 33 ms. Chrome's corresponding completion grows
from about 1.71 to 2.02 seconds, while movement starts in about 23 ms in both.
These completion times use the older metric described below and are not a
reliable full-tail comparison for Safari.

Safari still records a 56 ms animation-timestamp interval near restoration,
but only a 14 ms callback-entry gap there, about 2 ms of instrumented reconcile
work, and no recorded application animation callback in that interval. It is
not evidence of a remaining 56 ms JavaScript task. Separate intervals during
streaming still contain live-update work. This round does not claim to remove
every Safari frame gap or establish its presentation cause.

All six baseline/candidate final snapshots contain the complete tail and the
expected final scroll position. Cached coverage publications report zero gaps;
they cannot establish that the compositor painted every frame.

| Browser | Baseline | Candidate |
| --- | --- | --- |
| Firefox | `firefox-diagnostic-amL8Lk` | `firefox-diagnostic-hJqbR4` |
| Chrome | `chrome-diagnostic-Y8vAGd` | `chrome-diagnostic-uQOYIa` |
| Safari | `safari-diagnostic-QzYofM` | `safari-diagnostic-qmEPNK` |

## Corrected navigation metric

This investigation found that probe version 4 could mark bottom navigation
complete at the old window's end, before the asynchronously prepared tail
committed. Safari's candidate illustrates the error: completion is recorded
at 17.740 seconds, before the restoration handoff around 18.145 seconds. Earlier
reports' four-destination counts cannot by themselves prove full-tail arrival.
The operation/frame measurements and final snapshots remain separate evidence.

Probe version 5 requires three conditions for bottom completion: runtime
`atEnd`, the latest transcript page loaded, and no pending window navigation.
It reads application state, without a DOM geometry query. Top still targets
the currently loaded window's start. Missing navigation metadata fails closed.
The comparison tool rejects different probe versions.

The third and final Firefox trial, `firefox-diagnostic-rA5j1N`, validates version
5 against the full native workload. All four destinations complete, including
the final restored tail at 18.964 seconds. The largest staging callback is 9 ms
and the largest moving interval is 17.56 ms. These are validation results with
a changed probe, not another version 4 performance pair. No extra comparison
trials are added.

## Verification and reproduction

`pnpm run check`, all 1,078 unit tests, all 127 portable profiling checks, and
both isolated consumer builds pass. The new browser regression checks hidden
partial content, final measured height, native end navigation, node identity,
event listeners, cancellation, and destruction in Firefox, Chromium, and WebKit.
The seven related regression scripts also pass: profiler capture, hidden-row
retention, paged streaming, bottom-loader lifecycle, bottom navigation,
interrupted restoration, and touch-paging edge cases. The profiler exercises
follow and button scenarios in all three engines, plus WebKit's manual export
path. Touch edge cases use synthetic events and do not replace device testing.

Reproduce native captures with the same command at the appropriate source
revision and probe version:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=chrome --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --mode=diagnostic --scheduler --safari-detached \
  --display=LU28R55 --refresh-hz=60
pnpm run test:regression -- --match=staged-row
pnpm run test:regression -- --match=chat-profiler
```

Compact summaries, source patches/hashes, browser builds, display geometry,
workload metadata, and exact commands remain in ignored
`browser-artifacts/chat-profile/`. Raw inputs are deleted after analysis.
Reproduction uses tracked synthetic data and requires no private chat or remote
inference. Temporary caches and logs are removed when verification ends.

The five new native runs retain 1.33 MiB of compact evidence and no raw captures.
About 200 MiB of temporary Swift/Vite caches are removed. Owned profiling and
regression sessions have exited; pre-existing development servers are preserved.
