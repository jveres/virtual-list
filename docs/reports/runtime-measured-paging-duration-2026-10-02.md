# Longer measured paging control, October 2, 2026

The measured-height paging fixture's early memory growth reverses without
forced collection. At 480 retained-item budget, content-process footprint rises
to 172.64 MiB at cycle 120, then stays between 135.64 and 142.13 MiB over cycles
160–480. The 2,000-item case also shows no sustained growth over that interval.
This closes the duration question from the
[120-cycle comparison](runtime-rendering-allocation-2026-10-02.md) for the tested
workload and duration. No runtime change or performance gain is claimed.

## Results

One unprofiled installed-Firefox control runs 480 cycles per case on the
unchanged v0.4.12 runtime. These are observed memory levels, not before/after
optimization results.

| Measurement | 480-item budget | 2,000-item budget |
| --- | ---: | ---: |
| Largest sampled content-process footprint during cycles | 172.64 MiB at cycle 120 | 174.91 MiB at cycle 80 |
| Content-process range, cycles 160–480 | 135.64–142.13 MiB | 156.97–166.10 MiB |
| Content-process footprint at cycle 480 | 138.47 MiB | 158.08 MiB |
| Fixture-window storage before final forced collection | 8.723 MiB | 23.719 MiB |
| Fixture-window storage after final forced collection | 5.076 MiB | 16.542 MiB |
| Fixture-window storage after disposal and collection | 1.708 MiB | 2.963 MiB |
| Peak and ending active items | 408 | 1,700 |
| Rendered rows / destroyed rows before final disposal | 46,200 / 45,792 | 192,500 / 190,800 |
| Intrinsic image updates completed | 49,080 | 195,380 |

Both cases complete 480 page loads, 2,880 live text edits, 120 width changes,
and 120 canceled loads with matching completed reach requests. After disposal,
both have zero active items and balanced row destruction. Error arrays are
empty. Actual movement exceeds 27 million and 116 million CSS pixels, with
4,235 and 6,661 scroll-end events respectively.

The small case falls from 172.64 MiB at cycle 120 to 138.25 MiB at cycle 160
before any end-of-case collection request or memory-report tab. Its later
checkpoints stay within a narrow observed band through cycle 480. The earlier
98.16 MiB window-storage endpoint at 120 cycles was therefore not evidence of
indefinite retained-source growth. The new window-storage endpoint is a
separate memory reporter; it must not be confused with physical process
footprint.

## Conditions and limits

Revision `407e195`, unchanged runtime source SHA-256
`e3b364d2b09923e81d9c5f2de3016f6ed168b805957ad88650fa0fe5b3408ac0`.
Installed Firefox 157.0, build `20260924084938`, macOS 27.0, fresh temporary
profile and closed DevTools. LU28R55 is 1,920 × 1,080 logical pixels, 2× scaling,
60 Hz. The outer window is 1,900 × 1,049 at `(1450, 31)`; the content area is
1,900 × 964.

The capture runs from 09:43:39 to 10:00:51 UTC on October 2. The existing runner
samples owned-process footprints every twenty cycles, checks display geometry,
and forces collection before and after each case, never inside its cycle
sequence. Automation remains attached. There is no JS sampling or allocation
profiling in this control.

The deterministic workload includes overlapping pages, eviction, asynchronous
images, measured wrapping text, and live changes. Paging reverses in the final
quarter, so extending the duration also moves the reversal from cycle 91 to
cycle 361. This is not an identical replay of the earlier first 120 cycles.
Fixture timing arrays and counters also grow with the cycle count; small
differences between post-collection endpoints are not isolated runtime costs.

This is one finite-duration control, not a guarantee for unlimited operation,
all renderers, or every browser. Checkpoint samples do not capture every
transient process peak. The small and large cases have 16 and 18 animation-frame
gaps above 25 ms, with maxima of 36.02 and 50.02 ms. This control measures memory
behavior; it establishes no speedup, GC-pause improvement, or smooth physical
presentation.

## Reproduction and decision

Use the existing [memory workflow](../memory-profiling.md) and run:

```sh
node scripts/firefox-profile/runtime-retention.mjs \
  --workload=mixed-natural --cycles=480 --display=LU28R55 \
  --output=browser-artifacts/measured-streaming-long-control
```

The compact local record is
`browser-artifacts/measured-streaming-long-control/run-o4ooE7/`. It contains
only `summary.json`, `reproduce.json`, and `reproduce.patch`. Cleanup reports
no errors, and the process audit finds no owned Firefox, server, or helper left
running. The pre-existing user development server is preserved.

Close the sustained-growth hypothesis for this workload and duration. Keep the
runtime unchanged and proceed to the separate renderer/layout candidates.
Only reports change; the existing runner and fixture were used unchanged, so
code and browser correctness suites are not repeated for this control.
