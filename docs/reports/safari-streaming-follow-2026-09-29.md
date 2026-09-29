# Safari streaming-follow motion

The user reports that streaming follow feels continuous in Firefox and Chrome,
but moves in abrupt bursts in Safari. This Safari-specific investigation is an
explicit exception to the Firefox-first profiling workflow. It starts from
`3dec64e` and keeps navigation browser-owned.

## Findings

The installed Safari capture used Safari 27.0.1 (22625.1.29.11.28), the LU28R55
at 1920 × 1080 logical resolution, 2× scaling, and 60 Hz. The isolated window's
inner viewport was 1900 × 945. DevTools stayed closed; the Inspector-backed MCP
transport remained connected. Reduced motion was off. Captures passed focus,
geometry, stream-completion, movement, and buffer-validity checks. These are
scripted SSE workloads, not a capture of the user's physical experience.

The runtime issued smooth requests, with no direct scroll-position writes or
instant requests during streaming follow. An added diagnostic reads scroll
position immediately before and after each scroll call. Safari showed no
synchronous jumps. This does not exclude jumps between frames or compositor
presentation problems.

Current [WebKit smooth-scroll source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ScrollAnimationSmooth.cpp)
uses distance-dependent durations and changes easing when retargeting. Short
line-sized movements can therefore have short animations. That is a plausible
explanation for the reported difference, not proof that this source revision
exactly matches the installed browser.

## Native-only experiment

The deterministic workload uses 102 history turns, 12 rich reply sections,
116 chunks over 10 seconds, a 16-second capture, and the long trail. The profiler
sets end-follow and end landing. There were two installed Safari baselines,
one before the additional response metrics. Headless WebKit was used to test
an interval change before spending another installed-browser comparison.
Headless runs use 1200 × 900 at 1× scaling; they are comparable to each other,
but are not matched-display performance comparisons with installed Safari.

The following metrics cover the phase after send landing, including its idle
tail. They measure observed scroll positions, not physical smoothness:

| Capture | Smooth requests | Instant requests | Moving frames | Moving step p50 / p95 / max |
| --- | ---: | ---: | ---: | --- |
| Installed Safari, 100 ms interval | 101 | 0 | 396 | 19 / 37 / 77 px |
| Headless WebKit, 100 ms interval | 101 | 0 | 391 | 19 / 37 / 78 px |
| Headless Chromium, 100 ms interval | 88 | 0 | 500 | 10 / 48 / 96 px |
| Headless WebKit, 32 ms candidate | 107 | 0 | 367 | 22 / 39 / 77 px |

The shorter WebKit interval did not improve these measures. It was reverted;
`src/native-glide.ts` is unchanged. No scrolling fix is claimed. A Safari-only
streaming animation fallback would relax the user's native-only requirement
and requires their decision before implementation.

## Reproduction and retained diagnostics

Run the installed-browser baseline with:

```sh
pnpm run profile:chat -- --browser=safari --scenario=follow \
  --mode=diagnostic --display=LU28R55 --seconds=16 --stream-ms=10000 \
  --sections=12 --history=102 --output=browser-artifacts/safari-follow-audit
```

For engine correctness comparisons, replace `safari` with `engine-webkit` or
`engine-chromium` and omit `--display`. The diagnostic summary now retains
per-phase request counts, requested distances, synchronous movements, moving
frame-step distributions, and stationary-frame counts. Timing mode adds no
scroll-call instrumentation. The frame sampler still performs no layout reads.

Compact results, source patches, hashes, browser/display metadata, and exact
commands remain under ignored `browser-artifacts/safari-follow-audit/`. Raw
recordings are discarded by the runner. The rejected candidate's source patch
is retained with its run so it can be reproduced.

Verification passes: `pnpm run check`, all 5,613 unit tests, all 146 portable
profiling checks, and the recorder browser regression across all three engines.
Owned test browsers and servers exited; the reproducible Swift cache was removed.
