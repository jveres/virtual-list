# Gallery momentum investigation, September 27, 2026

The reported regression is a small jitter during trackpad momentum deceleration
in both gallery layouts on the LU28R55 display. After the preparation change
in `5ceb9d4`, the user tested real trackpad momentum in both layouts in Firefox
and reported smooth deceleration. The Rows capture also has complete profiling
data. There is no matched real-input capture of the original jitter, so these
results establish the observed current behavior, not a proven original cause.

## Environment and workload

Installed Firefox 156.0.1, build 20260921121718, ran with a fresh temporary
profile and closed DevTools. The LU28R55 was 1920 × 1080 logical pixels at 2×
scaling and 60 Hz. The browser content viewport was 1900 × 965. Each scripted capture
used a five-second warmup, six downward gestures, and four upward gestures.
Each gesture delivered 90 native 24-pixel events at 16.667 ms intervals, then
waited 700 ms. No performance patch preceded the baseline captures.

The application used the default medium gallery size and seeded Picsum URLs.
Photo content and network delivery remain external variables. These are
single-run observations, not a statistically established speedup.

## Observations

The masonry runs followed the same paging path, reached 360 retained photos,
and finished at scrollTop 4021.5. All recorded ten scroll-end events and zero
programmatic scrollTop writes. Their sampled frame intervals never exceeded
25 ms. Rows also had no long sampled frame gaps, but two downward bursts
reached the paging boundary; those stationary intervals are not smoothness
evidence.

| Masonry application | Content-thread CPU | Renderer-thread CPU | Display-list marker total | Frame interval p95 |
| --- | ---: | ---: | ---: | ---: |
| Before fade feature, `a7a970a` | 957 ms | 654 ms | 126 ms | 17.24 ms |
| Fade baseline, `83bce91` | 1547 ms | 1209 ms | 288 ms | 17.18 ms |
| Local preparation candidate | 1426 ms | 1173 ms | 254 ms | 17.24 ms |

CPU values are sampled thread CPU across approximately 25-second captures.
Display-list durations are nested wall times and must not be added to CPU.
Regular animation-frame callbacks do not establish smooth physical display
presentation. The rendering increase with fades does not by itself identify
the cause of momentum jitter.

## Preparation change

Images decode when their source arrives in mounted overscan. A retained image
re-entering the viewport reuses that decode instead of starting another
promise. An in-flight decode can finish offscreen without revealing the image.
Removed images and replaced sources cannot reveal stale pixels.

The opacity surface is prepared with `will-change: opacity` while mounted.
The virtual list bounds its lifetime; reduced-motion mode removes the hint.
The user validated momentum behavior in Firefox; the memory/compositor tradeoff
has not been independently quantified. Initial viewport arrivals stay
immediate; cached and first-time arrivals during scrolling still fade.

The browser regression covers both layouts at mobile and desktop widths in
Firefox, Chromium, and WebKit, including one decode per mounted image across
an overscan exit and re-entry. All seven gallery regression scripts pass,
as do the full 1059-test unit suite and `pnpm run check`. The resize regression
initially failed because it expected the removed `.cached` class. It now
checks the loader's reuse counter and verifies that continuously visible
images do not restart their fade during reflow. Its corrected rerun passed
both layouts. Fade stylesheet ordering and reduced motion also pass in all
three browser engines.

## Real trackpad follow-up

The user reported "No, it felt smooth" for masonry and "Smooth" for Rows on
the same external display. Both tests used isolated Firefox profiles at the
geometry above, with DevTools closed.

The 25-second Rows capture recorded 247 scroll events and six scroll-end
events. Its 247 moving-frame intervals had a median of 16.66 ms, p95 of
17.30 ms, and maximum of 17.68 ms. There were no sampled intervals above
25 ms and no programmatic scrollTop writes. Moving intervals cover about
4.12 seconds; idle time in the capture is not scrolling evidence. The longest
scroll handler took 2.43 ms. These measurements support the user's observation
without independently measuring physical-screen presentation.

The initial 60-second masonry capture recorded input, but Firefox's ring
buffer overwrote the start marker. Full CPU analysis therefore failed. It is
excluded from profiling conclusions; the user's smoothness observation is
retained separately. Use shorter manual captures with the current buffer.
No raw data from either run remains, and both temporary browser profiles were
removed. This follow-up did not repeat the real-input test in Chrome or Safari.

## Reproduction and artifacts

Start the demo server, then run:

```sh
pnpm run profile:firefox -- --url http://127.0.0.1:5173/demos/gallery/ \
  --display LU28R55 --layout masonry --live --refresh-hz 60 --warmup-ms 5000
```

Use `--layout rows` for the second layout. For real trackpad deceleration, add
`--manual-seconds 25` and flick the isolated test window only after the runner
announces recording. Let momentum finish between gestures. A stationary or
interrupted capture is invalid.

Compact summaries and source hashes/patches are under ignored
`browser-artifacts/firefox/`: `run-9lkA12` (fade baseline masonry),
`run-rp1nft` (fade baseline rows), `run-Czb7En` (pre-fade control), and
`run-hMlWE0` (candidate masonry). The control used an isolated archive served
on port 5175; its reproduction metadata identifies the application revision
separately from the profiling runner. Raw captures and temporary browser
profiles were removed automatically.

The real-input follow-up is `run-9mpGS9` (valid Rows capture) and `run-pDv3Bn`
(invalid full masonry CPU capture, user observation retained in `run.json`).
