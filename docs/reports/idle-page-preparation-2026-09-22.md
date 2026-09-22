# Hot path review and idle page preparation: September 22, 2026

This report records a Firefox review of the runtime's scroll hot path on a
real, image-heavy transcript. It also records a prototype that prepares a
held history page during the scroll phase. The runtime's own scroll path used
0.2–0.5% of content-thread samples. The prototype committed older pages about
240 ms sooner after release and lowered the longest frame work. It is off by
default behind the `prepareDuringScroll` option.

> **Note:** `prepareDuringScroll` is a prototype. It has two native captures,
> one workload, and Firefox only.

## Environment and workload

All captures used the [Firefox workflow](../firefox-profiling.md) against the
user's development server, with a fresh temporary profile, closed DevTools,
native macOS input, and live 1 ms profiling. The baseline source was main
`3484f65`. The prototype captures used the same source plus the working-tree
change described below.

| Property | Value |
| --- | --- |
| Browser | Installed Firefox 156.0.1 |
| Display | LU28R55, 1920 × 1080 logical, 2× scale, 60 Hz |
| Page | 1900 × 965 CSS pixels, devicePixelRatio 2 |
| Demo | Streaming chat with a private imported transcript |
| Transcript | 27.7 MB, 46 turns, 30 embedded images |
| Gestures | 12 upward, 90 ticks at 60 px, 700 ms settle |
| Warmup | 15 s after the setup import |

The transcript and raw captures remain local under ignored
`browser-artifacts/`. The tracked setup is
[`imported-chat-wheel.js`](../../scripts/firefox-profile/fixtures/imported-chat-wheel.js).
It imports a transcript named by `profile-transcript` and leaves native wheel
gestures as the only input.

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  '--url=http://127.0.0.1:5173/demos/streaming/?profile-transcript=/browser-artifacts/TRANSCRIPT.md' \
  --layout=none \
  --setup=scripts/firefox-profile/fixtures/imported-chat-wheel.js \
  --warmup-ms=15000 --down=0 --up=12 --ticks=90 --delta=60 \
  --interval-ms=16.667 --settle-ms=700 --live
```

Add `&prestage` to the URL to enable the prototype in the streaming demo.
Every capture loaded one page (10,740 to 20,530 px) during gesture 2 and
reached the start of history by gesture 4. Gestures 5–11 are stationary, so
only the first five gestures are scrolling evidence.

## Hot path at main

The hot path costs little on this workload. The table lists the three
baseline captures. Sample counts are 1 ms content-thread samples across a
30.6 s window.

| Measure | `k0n2xk` | `ps8J8D` | `S2fdZy` |
| --- | ---: | ---: | ---: |
| Moving frame interval, p95 / max | 17.20 / 17.46 ms | 17.18 / 17.64 ms | 17.08 / 17.50 ms |
| Moving intervals over 25 ms | 0 | 0 | 0 |
| Scroll handler p50 / p95 / max | 0.05 / 0.66 / 2.30 ms | 0.04 / 0.58 / 0.88 ms | 0.05 / 0.78 / 1.29 ms |
| Content thread awake | 780 ms | 654 ms | 924 ms |
| Self samples in `src/` | 107 | 71 | 140 |
| `armWheelIdle` and its timer cancel | 33 | 24 | 47 |
| `boundaryAtNativeEdge` | 22 | 15 | 16 |
| Longest refresh tick | 12.4 ms | 18.1 ms | 17.6 ms |

The runner's own animation-frame sampler recorded 26 self samples, about as
much as the largest runtime entry. No other runtime function exceeded 10
samples in any capture.

Two runtime candidates were examined and rejected:

- **Edge read in the wheel handler.** `boundaryAtNativeEdge` reads
  `scrollTop` and can flush style for rows mounted by the preceding scroll
  event. At most 31 of about 1,840 refresh intervals had more than one style
  pass, identically in every capture. The possible saving is about 20 ms per
  30 s. A cached edge would change the per-engine settle contract in
  `src/scroll-settle.ts`, which is tuned against real-browser edge traces.
- **Wheel-idle timer.** The
  [September 10 profile](runtime-hot-path-profile.md) attributes most of this
  cost to the profiler recording timer stacks. A single-deadline replacement
  was reverted there because it changed settle ordering.

The longest refresh ticks came during page preparation after release, not
during movement. Every sample in them was markdown rendering (comrak WASM)
inside a single row's `render()`. The staging loop yields after 3 ms, but it
can't split one render. In two captures this produced back-to-back 18 ms and
14 ms ticks. The rendering cost belongs to the demo and renderer, and this
review didn't change them.

## Prototype: prepare during the scroll phase

`updateWindow` holds a proposal until the scroll phase settles. It then calls
the host's updater, renders and measures the fresh rows over several frames,
and commits. The prototype starts that preparation earlier. When
`prepareDuringScroll` is enabled and the phase is active, the runtime calls
the updater in an idle callback. It renders and measures fresh rows in idle
callbacks with at least 4 ms remaining. The commit still waits for the
settle. The changes are:

- `run(prepare)` builds the staged job without applying it. A proposal too
  small to stage, or a job that is already ready, waits for the settle.
- `stageIdle` stages batches under the idle deadline and returns once the
  phase is idle. The existing animation-frame staging then owns the job.
- Cleanup cancels a pending idle callback. Interrupting updates and engines
  without `requestIdleCallback`, such as Safari, keep the existing behavior.

Because the updater now runs during the phase, its protected window is taken
from a moving viewport. The existing commit-time check still cancels a job
whose trimmed rows the gesture exposed. The paging updater has no side effects
before `onCommit`, so an early call is safe for `createPagedWindow`.

## Prototype results

The two prototype captures used the same options as the baseline, with
`&prestage`. All five captures ended at the same height, position, and loaded
range. Release-to-commit is the time from the start of the settle phase that
committed the page to its scroll write.

| Measure | Baseline (3 runs) | Prototype (2 runs) |
| --- | ---: | ---: |
| Release to older-page commit | 653–687 ms | 436–438 ms |
| Longest refresh tick | 12.4–18.1 ms | 5.4–11.9 ms |
| Moving frame interval p95 / max | 17.1–17.2 / 17.5–17.6 ms | 17.1–17.2 / 17.4–17.6 ms |
| Frame intervals over 25 ms | 0–1 | 0 |
| Content thread awake | 654–924 ms | 625–807 ms |
| Staging samples: animation frame / idle | 129–142 / 0 | 0 / 117–119 |

The prototype runs are `BMzuoi` and `9usCRK`. Their idle staging produced
30–31 ms awake bursts during gesture 1. Frames around the bursts stayed
regular (15.8–17.2 ms), but the view was stationary at the top edge at that
time. A single long render can still delay a moving frame when preparation
starts during fast scrolling. This workload didn't test that case.

## Verification

The change passes `pnpm run check`, all unit tests, and the profiling-tool
checks. Three new unit tests cover the option. They show 40 rows prepared
before the settle when enabled, none when disabled, and full teardown when
the update aborts mid-phase. The browser chat suite passes in Chromium,
Firefox, and WebKit with the option at its default, off, with no violations
or errors. On macOS 27, Playwright's Firefox fails to launch with "Could not
find profile folder" unless `MOZ_APP_DATA` and `MOZ_LOCAL_APP_DATA` name
temporary directories. This is the same launch failure that the Firefox
profiling runner already avoids.

## Limitations

These results support further evaluation, not a default change:

- Two prototype captures on one workload, in Firefox only.
- Scripted native ticks arrive about every 20 ms against a 16.67 ms frame, so
  every fifth frame receives no input. Real trackpad input is untested.
- Safari has no `requestIdleCallback` and keeps the existing behavior. Chrome
  is unmeasured.
- The measured cost moved into idle time. The total rendering work is
  unchanged.

## Next steps

Before enabling the option by default, test these cases:

1. Capture a real trackpad fling that reaches the load threshold while
   moving, and check moving-frame intervals.
2. Measure Chrome with the same workload.
3. Consider a demo-side render cache for static messages. It would reduce the
   single-row cost that neither staging path can split.
