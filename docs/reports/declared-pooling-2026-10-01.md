# Declared-row pooling measurement, October 1, 2026

Cross-item pooling reduces card creation and host rendering time in this
synthetic feed, but does not demonstrate lower total scrolling CPU or better
frame timing. Keep production behavior unchanged. The pooled capture uses
867.6 ms of content-thread CPU; the restored non-pooled control uses 862.0 ms.
The initial control is slower, so its apparent improvement does not survive
the third trial.

This measures option 4 from the
[virtualization research](virtualization-web-research-2026-10-01.md). The
prototype uses the existing host callbacks without changing `src/` or adding
a runtime pooling API.

## Conditions and workload

All three native captures use revision
`77e1d1839d536693be98ec050b73f37190938df5` plus the retained fixture and profiler
patches. Installed Firefox is 157.0, build `20260924084938`, on macOS 27.
Each capture uses a fresh temporary browser profile, closed DevTools, and the
LU28R55 at 1920 × 1080 logical pixels, 2× scaling, and 60 Hz. The outer window
is 1900 × 1049 at `(1450, 31)`; content is 1900 × 964 and the scroll viewport
is 924 px tall.

The [fixture](../../scripts/firefox-profile/fixtures/declared-pooling.html)
contains 10,000 deterministic local cards, each 180 px high, with 900 px of
overscan. Each card has 28 elements: a title, description, four metrics, four
tags, a checkbox, and an action button inside its container. There are two
item kinds. Both use the same structure, with item-specific content. There are
no remote assets, images, parsing, streaming, or paging. All data is loaded
before measurement. The fixture starts at item 5000, at 900,000 px.

The unchanged control creates a new card tree in `render` and releases it in
`onDestroy`. The candidate keeps up to 16 detached cards per kind in a host
pool. `render` takes a compatible tree and rebinds every item-dependent field.
Listeners read the current identity rather than capturing a previous item.
Disposal prevents further pooling and clears both pools. The pool is warmed by
initial positioning before measurement; this is a steady-scroll comparison,
not a cold-boot result.

This pool reuses host card DOM. The runtime still creates its row records and
wrapper slots, removes and reconnects nodes, and performs normal geometry and
anchoring work. It does not reproduce every aspect of a persistent-view
recycling engine.

Each trial sends six downward and four upward native gestures. Each gesture
has 90 events of 48 px, 16.667 ms apart, followed by 700 ms of settling. All
three traverse exactly 25,920 px down and 17,280 px up, finish at 908,640 px,
record ten scroll ends, and retain a 1,800,000 px scroll height. Each renders,
mounts, and destroys 240 rows during measurement. No capture has programmatic
scroll-position writes or invalid final card content.

## Results

The table lists the three trials in execution order. Run IDs are local-only
under `browser-artifacts/declared-pooling/`.

| Measure | Original `uxbRBj` | Pooled `SEKJTb` | Original restored `X4s44o` |
| --- | ---: | ---: | ---: |
| Capture duration | 25.192 s | 25.467 s | 25.584 s |
| Content main-thread CPU | 1,094.0 ms | 867.6 ms | 862.0 ms |
| Average CPU, one core | 4.34% | 3.41% | 3.37% |
| New host card trees | 240 | 0 | 240 |
| Reused host card trees | 0 | 240 | 0 |
| Host render callback total | 55 ms | 20 ms | 42 ms |
| Host render callback maximum | 2 ms | 1 ms | 1 ms |
| Scroll-handler total | 234.2 ms | 162.0 ms | 186.4 ms |
| Scroll-handler p95 | 0.925 ms | 0.589 ms | 0.685 ms |
| Style marker total | 72.9 ms | 66.6 ms | 60.7 ms |
| Synchronous reflow marker total | 77.6 ms | 72.4 ms | 63.5 ms |
| Display-list marker total | 102.5 ms | 90.8 ms | 82.0 ms |
| Moving rAF interval p95 | 17.22 ms | 17.22 ms | 17.18 ms |
| Frames over 25 ms | 0 | 0 | 0 |
| Scroll events | 882 | 893 | 884 |

Pooling avoids 240 host tree constructions and reduces recorded render time
by 52–64% against the two controls. The absolute saving is 22–35 ms across
about 25 seconds. Timers are quantized, instrumentation is identical in the
compared render paths, and callback wall times are not CPU attribution.

The pooled run has 20.7% less content CPU than the first control but 0.7% more
than the restored control. Its style, layout, and display-list totals are all
higher than the restored control. Event coalescing and browser background work
vary despite identical travel and row churn. These trials establish the DOM
reuse mechanism, but not a repeatable total CPU gain. Marker totals are nested
wall times and must not be added together or subtracted from sampled CPU.

All trials end with 16 mounted cards, or 448 host elements, excluding runtime
wrappers. The pooled trial additionally retains seven detached cards, or 196
elements. Its observed peak is 23 active-plus-pooled cards versus 17 in the
restored control. This measures retained DOM counts, not JavaScript heap,
physical browser footprint, or GPU memory. The first control predates the
pool-count fields; it must not be treated as having a measured peak-owned
counter.

## Reproduction and evidence

Start a dedicated local server, then run the native profiler. Change only
`pool=off` to `pool=on` for the candidate and back to `off` for the restored
control:

```sh
pnpm exec vite --host 127.0.0.1 --port 4193 --strictPort
```

```sh
pnpm run profile:firefox -- --display=LU28R55 --refresh-hz=60 \
  --live --layout=none \
  --url='http://127.0.0.1:4193/scripts/firefox-profile/fixtures/declared-pooling.html?pool=off' \
  --down=6 --up=4 --ticks=90 --delta=48 \
  --output=browser-artifacts/declared-pooling
```

The original baseline was captured before adding the optional pool. The pooled
and restored captures use identical fixture source bytes, differing only in
the query parameter. Their fixture SHA-256 is
`4068d89aa5a6e7d46c57382bbfa280a83fa5aa81c2710d92c129379ba4f95128`;
the first control's is
`1b391126662e5a9554756280f860083c35dd07bde450a85cfbdff3138884a1db`.
The rendered workload and measurement input remain the same.

Each run retains the exact command, source patch and hashes, browser build,
display geometry, CPU attribution, and marker summaries. `comparison.json`
records validated travel, row counts, and matching candidate/restored source.
The profiler now preserves an optional bounded `fixtureSummary` from its
existing audit hook, while discarding raw audit records. Fixture snapshots
read DOM only at capture boundaries; the rAF sampler still reads cached scroll
position without layout queries.

## Verification and limits

The retained work is the reusable opt-in fixture, its browser regression, the
compact-summary support and portable check, and this report. No production
runtime or demo behavior changes.

- `pnpm run check` passes with the two existing CSS `!important` warnings.
- `pnpm test` passes all 5,624 tests.
- `pnpm run test:firefox-profile` passes all 185 checks.
- `pnpm run test:regression -- --group=runtime --match=declared-pooling`
  passes in Playwright Firefox, Chromium, and WebKit. It checks actual
  cross-item DOM reuse, text/identity/checkbox rebinding, button dispatch,
  contiguous 180 px rows covering the viewport, bounded retention after
  retiring a large window, and disposal cleanup. These are correctness checks,
  not installed-browser performance comparisons.

Initial sandboxed test attempts could not bind local HTTP sockets. Rerunning
with local socket access passes; no application fix was needed. Existing
dependency source-map warnings remain.

Only three native Firefox timing trials were run. There is no statistical
estimate of a small speed difference, no native Chrome/Safari comparison, and
no real trackpad momentum or physical-presentation measurement. More expensive
cards, images, or a renderer with costly listener setup could change the
tradeoff; this fixture does not establish those gains. Exact retained DOM
counts also do not establish a memory saving.

The runners removed all raw profiles and temporary browser profiles. The
dedicated Vite server and owned browser/helper processes are closed; the
pre-existing user Vite server is preserved. The experiment's compiler cache
and display-listing helper are removed. Compact evidence remains ignored.
