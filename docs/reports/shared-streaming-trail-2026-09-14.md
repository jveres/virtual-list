# Shared overlay on the complex streaming fixture

This historical report measures the pre-release shared-blend prototype. It preserves
the tested appearance of the original overlay. On the complex fixture, its
combined content-plus-Renderer CPU median is 7.4% lower than the original, but
the observed ranges overlap. Treat this as a promising prototype, not a proven
general performance improvement or a scrolling-jitter fix.

The accepted effect now belongs to `markdown-viewer` through `streamingTrail`.
The demo exposes only **Short fade** and **Long fade**, with `trail=short` and
`trail=long`. Alternative controls and the commands below describe the
measurement revision, not the current demo. Raw captures remain unchanged.

## Implementation and visual checks

The original overlay blends each fade group separately. The new variant places
the independently fading groups inside one blend container, bounded to their
rectangle union. The outer full-message clipping layer remains unblended.
The shared bounds shrink when older groups expire. Fade duration, fade ages,
text tracking, range measurement, and rectangle limits remain unchanged.

At measurement time, the demo offered separate original, CSS, and shared-blend
controls. The effect was disabled by default, and the prototype did not change
the runtime API or dependency pin. The released integration also defaults off.

Firefox 153, Chromium 151, and WebKit 26.5 pass pixel comparisons in light and
dark mode. The fixture includes wrapped prose, syntax-highlighted code, tables,
and three independently aged groups. Screenshots match within one color-channel
value. Assertions also require tight bounds and shrinking after group expiry.

The full overlay regression passes for both implementations in all three
engines. It covers text coverage, wrapped geometry, final fade, idle reads,
DOM replacement, resize, horizontal scrolling, resource bounds, reduced motion,
cleanup, and the live demo toggle. Installed Safari 26.6.2 also passes the final
line's pixel-fade test: intermediate colors progress to white, the line gap
stays white, and no groups or animations remain afterward.

The maintained regressions now exercise the public renderer option, including
pixel stability across DOM replacement, through the existing demo server:

```sh
node scripts/regressions/runtime/streaming-trail-shared-regression.mjs
node scripts/regressions/runtime/streaming-trail-regression.mjs
```

For installed Safari, start a temporary `safaridriver --port 4447`, then run
`node scripts/regressions/runtime/streaming-trail-safari-probe.mjs`.
Stop the driver afterward. The probe closes its own browser session.

## Complex workload and results

The comparison uses the earlier synthetic 70-section complex fixture, now
tracked under `scripts/firefox-profile/fixtures/complex-stream.html` and
`complex-stream.js`. It contains 67,760 characters: long prose, bold, emphasis,
inline code, 70 tables, 70 TypeScript fences, and lists. It uses the real demo
message renderer with the current public virtual-list API. The smoke test
requires all sections to render, an active shared trail during delivery,
continued following, and final cleanup.

Delivery uses 128-character chunks on fixed 8 ms deadlines, with a 100 ms pause
at every 4,096 characters. Late timers batch overdue chunks. This preserves the
input timeline rather than slowing the input when rendering takes longer.
The content comes from the old complex follow probe, but its internal runtime
instrumentation is not retained. This fixture isolates one growing reply after
a 1,400 px history row. It does not reproduce transcript paging, images, or math.

Twelve fresh profiles use installed Firefox 155.0.1 with closed DevTools and
live collection. The external LU28R55 is 1,920×1,080 logical pixels at 2× and
60 Hz. The browser content area is 1,900×965. The source is the uncommitted
prototype above `c5fa175`. Each variant runs three times in this order:
off, original, shared, CSS, CSS, shared, original, off, shared, off, CSS, original.

The table shows medians, with ranges in parentheses. Each percentage refers
to one core. The combined value is the median of per-run content-plus-Renderer
sums, not total browser CPU. Renderer CPU is not GPU utilization.

| Option | Content CPU | Renderer CPU | Combined CPU | Maximum frame interval across runs |
| --- | --- | --- | --- | --- |
| Off | 14.09% (12.73–14.65) | 1.84% (1.70–1.91) | 15.93% (14.44–16.56) | 33.40 ms |
| Original overlay | 16.58% (15.21–17.53) | 2.38% (2.32–2.47) | 18.95% (17.53–20.00) | 33.96 ms |
| Shared overlay | 15.46% (15.22–15.83) | 2.29% (2.06–2.34) | 17.55% (17.52–18.11) | 34.14 ms |
| CSS inline | 17.41% (15.55–17.55) | 2.27% (2.14–3.20) | 19.68% (17.69–20.74) | 50.88 ms |

Every run records actual movement: 220–222 moving frames and a final scroll
position of 35,703 px. All include the completion marker for the full stream,
3.33–3.37 seconds into the approximately 6.01-second measurement window.
The remaining time includes final rendering and fading. Programmatic scroll
writes are expected because these runs use hands-off end-follow.

Every variant records at least one frame interval above 25 ms. The original
overlay records one or two per run, the shared overlay one, and CSS one or two.
This does not establish a smoothness improvement. Frame callbacks do not
measure physical display presentation, and an effect-off run also exceeds
the threshold. CPU and frame timing vary, so more workloads and repeats are
necessary before promoting the shared variant as a performance replacement.

## Reproduction and local evidence

The command below records the original prototype capture. For a new run
against the published renderer, use `trail=long` for the accepted shared
overlay or `trail=off` as the control. The discarded alternatives no longer
have demo controls. Despite the
runner's manual-mode prompt, do not scroll: the runtime supplies the movement.
The runner warms the page for two seconds and waits another two seconds after
starting delivery before measurement. No benchmark processes run concurrently.

```sh
pnpm run profile:firefox -- --display=LU28R55 \
  --url='http://127.0.0.1:5173/scripts/firefox-profile/fixtures/complex-stream.html?trail=shared-long' \
  --layout=none --setup=scripts/firefox-profile/fixtures/complex-stream-start.js \
  --warmup-ms=2000 --manual-seconds=6 --live \
  --output=browser-artifacts/streaming-trail/complex-follow
```

The following IDs identify local-only captures in that output directory.
Use `node scripts/firefox-profile/cpu.mjs RUN_DIRECTORY` for CPU attribution
and `summary.json` for frame timing. All 12 captures complete, and their
temporary browser profiles are removed after the owned browser exits.

| Option | Local run IDs |
| --- | --- |
| Off | `run-bpsw7H`, `run-NqGeyT`, `run-ZVivgu` |
| Original overlay | `run-Td23Sx`, `run-Y0qOQ1`, `run-GfqUlM` |
| Shared overlay | `run-HEn3n3`, `run-J19iLM`, `run-4yWohc` |
| CSS inline | `run-TwBZCW`, `run-phUy21`, `run-0tiwNZ` |

The earlier fast-long attempt `shared-blend-follow/run-yuLGSQ` fails focus
validation and is excluded. The requested switch to the complex fixture ends
that smaller-workload comparison. Raw captures remain ignored and local.
The [earlier comparison](streaming-trail-comparison-2026-09-14.md) describes
the smaller built-in reply, not these complex-fixture results.

These measurements do not establish Safari or Chromium CPU cost, GPU load,
battery use, native gesture-release behavior, or performance during paging.
All test-owned browsers and the Safari driver are closed. The user's existing
Firefox and Vite server remain untouched.
