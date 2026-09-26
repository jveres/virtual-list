# Image lookup batches and large-row restoration

Image-preview binding now resolves a row's image order and source message once
per batch. This removes repeated subtree and transcript scans during complex
streaming. The separate cost of laying out a restored, very large reply remains.

## Findings and change

The investigation starts with a fresh installed-Firefox capture at revision
`400cd2a63a083f7cda41f2e5ad16365cc17db893`, using `markdown-viewer v0.8.5`.
Restoring the completed 44,230-character reply takes 41 ms in `stageFrame`.
The native trace includes a 31.7 ms layout flush, with 11.1 ms of style work
and a 15.1 ms synchronous reflow inside it. These nested durations must not
be added to the enclosing flush.

A width-containment control adds `contain: inline-size layout style` to
assistant rows. Staging remains 42 ms and moving-frame timing does not improve.
That control is reverted; no CSS or runtime layout change is retained.

The same profile records 1,344 image-binding calls and 69 ms inside `bind`
during the bottom-scroll phase. Each image independently searches the source
messages and queries all images in its row to find its ordinal. A mutation
delivery already has a stable final DOM order, so repeating those lookups
for every image is unnecessary.

The retained change uses a batch-local map. Each affected row gets one ordinal
map and one source-message lookup; the source callback runs once per batch.
Initialization, mutation delivery, and image loads use the same binding path.
The map expires after binding, so later moves, source replacements, and row
rekeying read the new state. No persistent DOM cache or geometry read is added.

With 12 images and 40 text mutations, the regression requires two row scans:
one to collect affected images and one to resolve all ordinals. The previous
implementation requires thirteen. Preview identities and navigation still pass
the duplicate-source, responsive-source, attachment, move, rekey, removal,
restoration, and disposal checks.

## Native diagnostic results

All captures use the LU28R55 at 1920 × 1080 logical pixels, 2× scaling, and
60 Hz. Windows are 1900 × 1049 at `(1450, 31)`. Installed browsers are Firefox
156.0.1, Chrome 153.0.8010.53, and Safari 27.0 (22625.1.29.11.27), with inner
viewports of 1900 × 965, 1900 × 962, and 1900 × 997 respectively. Sessions are
isolated, DevTools are closed, and Safari's driver disconnects before capture.

The workload streams 48 sections over 12 seconds with 160 history turns and a
20-second capture. Its hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
Diagnostic operation and scheduling probes are enabled. Chrome and Safari reuse
the matching published-tag baselines from the
[range-reuse investigation](streaming-range-reuse-2026-09-26.md).

The first candidate in each browser records the following results:

| Metric | Firefox: baseline → candidate | Chrome: baseline → candidate | Safari: baseline → candidate |
| --- | ---: | ---: | ---: |
| Bottom-phase binding calls | 1,344 → 1,357 | 1,343 → 1,343 | 1,386 → 1,387 |
| Bottom-phase binding time | 69 → 40 ms | 117.0 → 43.2 ms | 35 → 24 ms |
| Largest staging span | 41 → 46 ms | 36.9 → 35.6 ms | 52 → 54 ms |
| Moving-frame p95 | 17.10 → 17.24 ms | 17.50 → 17.40 ms | 19 → 23 ms |
| Largest moving interval | 33.40 → 50.08 ms | 33.30 → 33.40 ms | 57 → 61 ms |

The binding durations are instrumented wall time, including the lazy row
lookup performed within `bind`; they exclude outer batch setup. The regression
establishes the reduction in scans. These diagnostic pairs do not establish an
overall speedup or smoother physical presentation. Firefox and Safari's worst
frame results are higher, and no restoration improvement is claimed.

In Safari, the first candidate's restoration includes a 54 ms staging span
and a 60 ms callback gap. Another 61 ms animation timestamp interval has only
an 18 ms callback-entry gap. These are different observations: the profiler
must not attribute every long animation timestamp interval to JavaScript work.

Safari's third comparison trial repeats the candidate. Binding takes 28 ms
across 1,393 calls in the bottom phase, staging reaches 53 ms, moving p95 is
22 ms, and the largest moving interval is 59 ms. Both candidates have higher
frame timings than the reused baseline. The small diagnostic sample does not
establish their cause; this change is retained for the verified reduction in
duplicated lookups, not as a Safari frame-timing improvement.

Local capture IDs are:

| Browser | Baseline | Image-batch candidate |
| --- | --- | --- |
| Firefox | `firefox-diagnostic-u7MiK6` | `firefox-diagnostic-Q8b5eX` |
| Chrome | `chrome-diagnostic-T8f0Xj` | `chrome-diagnostic-Y8vAGd` |
| Safari | `safari-diagnostic-gBLiFV` | `safari-diagnostic-p3wwVZ` |

Safari's candidate repeat is `safari-diagnostic-QzYofM`. All comparison pairs
pass the profiler's browser, display, workload, transport, and probe checks.

The rejected Firefox width-containment capture is
`firefox-diagnostic-BIdPmu`. Firefox uses three trials in this round: baseline,
width control, and image-batch candidate. No extra Firefox trials are added.

## Verification and reproduction

`pnpm run check`, all 1,066 unit tests, and all 126 portable profiling checks
pass. The expanded 12-image reconciliation regression passes in Chromium,
Firefox, and WebKit. The full image-preview interaction regression passes in
its configured Firefox and WebKit cases. Every native candidate reports all
four button destinations with zero gaps in cached coverage publications. The
later [completion-metric correction](staged-row-layout-2026-09-26.md#corrected-navigation-metric)
shows why the old bottom count alone cannot prove restored-tail arrival.
No iPhone/iPad momentum measurement is part of this round.

Run the same commands at the baseline and candidate revisions:

```sh
pnpm run profile:chat -- --browser=firefox --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=chrome --scenario=buttons \
  --mode=diagnostic --scheduler --display=LU28R55 --refresh-hz=60
pnpm run profile:chat -- --browser=safari --scenario=buttons \
  --mode=diagnostic --scheduler --safari-detached \
  --display=LU28R55 --refresh-hz=60
pnpm run test:regression -- --group=chat-content --match=chat-image
```

Compact summaries and reproduction metadata remain under ignored
`browser-artifacts/chat-profile/`, including revision, source patch and hashes,
commands, browser builds, and display geometry. Raw captures are deleted after
analysis. Reproduction uses synthetic local input and requires no private chat
or remote inference.

The six new captures retain 1.50 MiB of compact evidence and no raw files.
Temporary compiler/Vite caches and test logs are removed. The owned browsers,
helpers, and servers have exited; the pre-existing demo server is preserved.
