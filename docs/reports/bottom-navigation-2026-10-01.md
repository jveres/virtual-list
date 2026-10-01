# Bottom navigation easing restart

The streaming demo issued two native smooth-scroll commands when the latest
messages had been evicted. Preparing the tail interrupted the first command
and started a new easing curve. The candidate prepares the tail first, then
issues one native command. User confirmation of presentation and startup
latency is pending.

## Reproduction and evidence

Use the default simulated chat in a fresh profile. Press top four times,
waiting 2.5 seconds between presses, then press bottom. This reaches the
beginning with messages 1–72 loaded and the final 30 messages evicted.

```sh
pnpm run profile:firefox -- \
  --url=http://localhost:5173/demos/streaming/index.html \
  --layout=none --display=LU28R55 \
  --setup=scripts/firefox-profile/fixtures/chat-bottom-navigation.js \
  --idle-seconds=16 --live
```

Both captures used installed Firefox 157.0, build 20260924084938, macOS 27,
closed DevTools, and fresh temporary profiles. The LU28R55 was 1920×1080
logical pixels at 2× scaling and 60 Hz; browser content was 1900×964.
Baseline revision: `0cce2b7370a2770a248cf3c94fee8f02537faa58`.
Local compact captures: `run-91zuxv` (baseline) and `run-KeDpXD` (candidate).
Their reproduction metadata includes source patches, hashes, and the fixture.
Raw profiles and temporary browser profiles were removed automatically.

| Observation after bottom click | Baseline | Candidate |
| --- | --- | --- |
| First smooth request | 6 ms | 189 ms |
| Native smooth requests | 2 | 1 |
| Instant cancellation requests during motion | 2 | 0 |
| Final arrival | 1156 ms | 1156 ms |
| Final scroll offset | 12363 px | 12363 px |

In the baseline, the first destination was 30629 px in the old window.
At 174 ms after the click, restoration cancelled that animation at 20046.5 px,
replaced the window, and anchored its first row at 92 px. A second native
animation started at 189 ms, targeting 12363 px in the restored window.
This explains the slowdown and subsequent acceleration without requiring a
main-thread stall. Neither capture recorded an animation-frame interval above
25 ms. Regular frame callbacks do not establish smooth physical presentation.

## Change and tradeoff

`scrollToLatest()` no longer starts the preliminary animation through the old
window. The existing runtime still prepares rows asynchronously, takes over
at commit, and animates natively to the final destination. Existing momentum
can continue during preparation; new user input or a newer navigation command
can cancel the pending replacement.

This fixes the command sequence at its source in the demo's navigation
orchestration. It does not change runtime easing or introduce a custom scroll
animation. It also does not claim to fix the separately investigated
intermittent Firefox/Safari presentation jitter.

The tradeoff is that movement from a stationary viewport starts after tail
preparation: 189 ms in this default-chat capture. Larger replies can take
longer. If this latency is unacceptable, preparation needs a separate design;
reintroducing the old-window approach would restore the easing restart.

## Verification

The paged-history browser regression now requires one smooth command and no
instant cancellation during that command. It retains checks for asynchronous
preparation, intermediate animated positions, final bottom alignment, bounded
history, newer-command cancellation, and sending after history restoration.
It passes in Firefox, Chromium, and WebKit.

`pnpm run check` passes with two pre-existing diagnostic CSS warnings.
`pnpm test` passes all 5624 tests, and `pnpm run test:firefox-profile` passes
all 184 checks with local server access. The sandbox-only attempt could not
bind the checks' loopback servers.

`chat-reach-takeover-regression.mjs` passes all four timing cases per engine
(immediate, 100 ms, 350 ms, and final-animation takeover).
`chat-restore-interruption-regression.mjs` passes keyboard cancellation and
concurrent stream-stop cases in all three engines. These automated engine
checks establish correctness, not physical presentation on the monitor.
