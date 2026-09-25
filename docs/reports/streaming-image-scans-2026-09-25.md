# Streaming image-preview scan optimization

This investigation starts from profiler revision `e45d4b0`. The retained change
deduplicates image-preview subtree scans within one MutationObserver delivery.
The streaming renderer can generate many records for the same row; every record
previously queried that row's images again. The observer now gathers unique
roots before scanning their final DOM state. Image binding still reconciles
removed nodes, changed sources, row keys, and sibling ordinals.

## Evidence and hypothesis

The initial Firefox diagnostic capture `firefox-diagnostic-KX1vnX` attributed
186 native samples to the image-preview observer, including 88 to collection.
The profiler was extended with synchronous `collect` and `bind` spans. The
instrumented baseline `firefox-diagnostic-el0eBs` recorded 21,804 collection
calls and 94 ms of collection self time. Candidate `firefox-diagnostic-cKXufh`
recorded 11,766 calls and 25 ms. Binding remained necessary: the respective
trials recorded 1,744 and 1,731 calls, with 96 and 132 ms self time.

The candidate reduces duplicate traversal, not image-binding semantics. A
focused unit regression changed one row's text 40 times in one delivery and
observed 41 row image queries before the change, versus two afterward. The two
remaining queries collect images and resolve the image ordinal. A real-browser
regression checks the same bound and preserves preview source, identity,
rekeying, movement, removal, and responsive-image behavior across Chromium,
Firefox, and WebKit.

These diagnostic times include instrumentation and coarse timer precision.
They establish a local cost reduction, not a physical scroll-jitter fix.

## Comparison conditions

The default fixture streams 44,230 characters in 461 chunks over 12 seconds,
with 160 history turns, a long renderer trail, and a 20-second capture window.
Its input hash is
`b871a8159e958823e1b309e72bc3ef2f0a48590998de7e3af2b786951cf594d9`.
All comparisons use automatic follow, fresh isolated browser profiles, and
closed DevTools on the LU28R55 external display at 1920 × 1080 logical pixels,
2x scaling, and 60 Hz. Windows are 1900 × 1049 at (1450, 31); browser content
heights differ and are compared only within the same browser.

The installed builds are Firefox 156.0.1, Chrome 153.0.8010.53, and Safari 27.0
(22625.1.29.11.27). Safari uses the same Inspector-backed MCP transport for
both variants. Browsers run sequentially, with baseline/candidate order
`B, C, C, B, B, C` in each browser. The only production difference is the
observer change. Timing captures omit synchronous operation instrumentation.

The preliminary `firefox-timing-WkyxCO` is excluded because a focused test ran
near the end of its capture. No test suite runs during the comparison sequence.

## Timing results

All 18 timing trials completed the expected stream and recorded movement.
The nine pairs pass the comparison checks. Values below are medians of three
trials, with the observed range in parentheses.

| Browser / metric | Baseline | Candidate |
| --- | ---: | ---: |
| Firefox moving p95 | 17.14 ms (17.12–17.26) | 17.12 ms (17.06–17.20) |
| Firefox moving intervals >25 ms | 2 (1–2) | 2 (2–2) |
| Firefox content-thread CPU | 3,880 ms (3,874–3,988) | 4,011 ms (3,849–4,099) |
| Chrome moving p95 | 33.0 ms (32.7–33.3) | 17.7 ms (17.6–32.6) |
| Chrome moving intervals >25 ms | 42 (40–50) | 31 (27–38) |
| Chrome main-thread task time | 7,937 ms (7,760–7,950) | 7,447 ms (7,358–7,593) |
| Safari moving p95 | 21 ms (20–22) | 21 ms (20–21) |
| Safari moving intervals >25 ms | 14 (11–14) | 10 (8–12) |

Chrome's median main-thread task time falls 6.2%, with every candidate trial
below every baseline trial. Its sampled `querySelectorAll` wall time falls
from a median 313 ms (313–317) to 76 ms (62–89), consistent with the removed
traversals. These samples are wall-time attribution, not CPU utilization.
The maximum moving interval still reaches 99 ms in one candidate trial, so
the change does not eliminate stalls.

Firefox's frame timings are effectively unchanged. Its content-thread CPU
median is 3.4% higher, with overlapping ranges; these trials establish neither
an overall CPU gain nor a reliable CPU regression. Safari's p95 is unchanged
and its long-interval ranges overlap. There is no native Safari CPU measurement
in this transport. The change is retained for the bounded scan regression,
measured collection reduction, and repeated Chrome task-time benefit. It does
not establish jitter-free physical presentation in any browser.

| Browser | Baseline run IDs | Candidate run IDs |
| --- | --- | --- |
| Firefox | `cUT1Z0`, `76JcXC`, `4LMWHl` | `zITwZJ`, `NDdCKW`, `AxhEWG` |
| Chrome | `5a4sOe`, `oXfddK`, `BuLSJf` | `3Z11C5`, `l5k7iQ`, `LpAlCW` |
| Safari | `OMgLLP`, `MZIhL1`, `sF0GXS` | `GZdl5q`, `eW4UVz`, `QHjYZO` |

Run IDs use the `<browser>-timing-` prefix under the local chat-profile folder.
Every run retains source replay metadata and compact results, and confirms raw
capture deletion. All owned servers closed; all six Safari trials also confirm
driver and automation-browser closure.

The repeats exposed an analyzer bug: Swift emits monitor object keys in varying
orders, and JSON-string comparison incorrectly treated matching displays as
different. Comparison now uses deep value equality. A portable regression checks
both reordered keys and an actual scale mismatch. The recorded geometry values
were unchanged; the correction does not alter measurements.

## Correctness and native input

Candidate capture `firefox-diagnostic-VSLNSy` completed the full stream during
scripted native scrollback. It recorded 897 wheel events, 17 scroll-end events,
and 886 moving intervals (p95 17.16 ms, maximum 33.34 ms). The retained range
progressed from turns 133–160 of 160 to 109–162 of 162, exercising paging and
image binding as rows entered and left the viewport. This is a candidate
correctness check, not a paired scrollback performance claim.

Validation commands:

```sh
pnpm run check
pnpm test
pnpm run test:firefox-profile
pnpm run test:regression -- --group=chat-content --match=chat-image
pnpm run test:regression -- --group=runtime --match=chat-profiler
```

All passed: lint/types, 1,042 unit tests, 105 portable profiling checks, the two
image-preview browser regressions, and the streaming-profiler regression across
three engines plus manual keyboard/export controls.

Firefox burst summaries now retain at most 64 evenly spaced write details with
their eight nearest input events, alongside complete counts and explicit omission
counts. This removes repeated event lists without retaining a full input trace.
Compacting existing summaries saved another 16.4 MiB. After removing regenerated
compiler caches and temporary test data, all retained local profiling results
and replay records occupy 5.7 MiB; no raw capture files remain. The final process
audit found only pre-existing user browsers and development servers.

## Remaining investigation

Chrome still spends substantial time in style recalculation and at `scrollTop`
reads. The first baseline/candidate traces record about 3.5 seconds of nested
`UpdateLayoutTree` work and about 1.6 seconds of sampled wall time at the getter.
Those costs do not disappear with this patch. The next hypothesis should inspect
which writes precede those reads and whether a read can be avoided without
breaking resize clamps or native scroll anchoring. Inclusive event durations
overlap and must not be added together as CPU time.

Real trackpad release behavior and visible jitter remain manual verification
tasks. Automatic follow and scripted native scroll input do not reproduce a
physical momentum gesture or prove that the display presented every frame.

## Reproduce

Use the baseline application file from `e45d4b0` and the candidate patch from
this report's commit. Run each browser sequentially with both versions:

```sh
pnpm run profile:chat -- --browser=firefox --mode=timing \
  --display=LU28R55 --refresh-hz=60
```

Substitute `chrome` and `safari` for the other installed browsers. Use
`--mode=diagnostic` to inspect the image-preview operation spans. Each local run
retains its exact command, source patch and hashes, browser/display metadata,
and compact summaries. Raw captures are removed after analysis. Match the
workload hash, build, geometry, refresh rate, and transport before comparing.
