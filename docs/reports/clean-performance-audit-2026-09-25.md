# Clean-code and performance audit, September 25, 2026

Two medium findings are fixed in the working tree based on `baf4efe`. The
follow-up review found no remaining high or medium findings in the reviewed
paths. This is a scoped audit, not proof that every workload is defect-free.

The review covered runtime geometry, paging, follow/glide behavior, lifecycle
and transaction boundaries, sticky-header companions, selected gallery and
chat support code, and Firefox measurement tooling. Existing automated tests
cover a broader set of demo behavior. Performance measurements cover chat boot
and synthetic rich-chat scrolling; they do not establish gallery, live-stream,
or real trackpad performance.

## Resolved findings

Both findings affect failure or partial-data paths rather than normal scrolling.
No high-severity finding was identified.

| Severity | Finding | Resolution and evidence |
| --- | --- | --- |
| Medium | Sticky headers treated unavailable positions as zero, breaking the sorted lookup and potentially showing a missing or incorrect header. | Exclude unavailable positions while retaining source ordinals for rendering. The new regression failed before the fix and covers missing first, middle, and last headers, changed ordinals, handoff, and all positions becoming unavailable. |
| Medium | Boot profiling established its cleanup boundary after browser startup. Spawn failures and failed connections could leak temporary profiles or browsers; unanswered commands and shutdown could wait indefinitely. | Cover setup and startup with cleanup; observe spawn errors and early exit; bound connection attempts, commands, and shutdown; reject pending commands on disconnect; handle termination signals. Validate measurement arguments before creating resources. Portable checks verify invalid arguments and profile removal after missing executables and early browser exit. |

The second review checked the changed failure boundaries and header cache
invalidation. The startup checks and a successful installed-Firefox run verify
the repaired profiler. Disconnect, command-timeout, and signal paths were
reviewed but were not independently fault-injected.

## Firefox measurements

The native runs used installed Firefox 156.0.1, fresh temporary profiles,
closed DevTools, and the external LU28R55 at 1920 × 1080 logical pixels,
2× scaling, and 60 Hz. The browser outer window was 1900 × 1049 and its
inner viewport was 1900 × 965. No regular Firefox profile was modified.

The workload imported the tracked 160-turn synthetic rich-chat fixture, then
sent six upward native gestures of 90 ticks at 24 pixels per tick. Both runs
moved from scroll position 20,697 to 7,737, with constant scroll height 21,512
and six scroll-end events. This tests a retained transcript, not new paging
progress. The baseline temporarily used the original sticky-header source;
the repeat used the fix. Raw run IDs below are local-only.

| Measure | Baseline `run-oGruyl` | Fixed `run-XEoYGl` |
| --- | ---: | ---: |
| Measurement duration | 15.20 s | 14.86 s |
| Moving frame intervals | 527 | 538 |
| Moving interval p95 | 17.22 ms | 17.34 ms |
| Moving interval maximum | 17.66 ms | 17.62 ms |
| Intervals over 25 ms | 0 | 0 |
| Programmatic scroll-position writes | 0 | 0 |
| Content main-thread CPU, one-core average | 2.77% | 2.86% |

Runtime attribution and CPU summaries did not identify a material runtime
bottleneck in this workload. No performance optimization was justified or
applied. One pair cannot establish a speed improvement; callback timing does
not measure physical presentation or real trackpad momentum. The first trial,
`run-Qtls0b`, started at the bottom with stationary downward gestures and is
excluded from performance evidence. The initial sandboxed display query also
failed and supplied no performance evidence.

Boot measurement used the streaming demo's `chat:visible` mark, a requested
1200 × 900 window, four loads per mode, and discarded the first load in each
mode. Cold means HTTP cache bypass. These boot runs were not display-matched
scroll trials. Cold medians were 187 ms before and 182 ms after; warm medians
were 130 ms before and 136 ms after. These small samples show the repaired
tool runs successfully, not a demonstrated boot improvement.

Reproduce with a local Vite server and these commands:

```sh
pnpm exec vite --host 127.0.0.1 --port 4193 --strictPort
pnpm run profile:boot -- --url=http://127.0.0.1:4193/demos/streaming/ --runs=4
pnpm run profile:firefox -- --display=LU28R55 \
  --url=http://127.0.0.1:4193/demos/streaming/ --layout=none \
  --setup=scripts/firefox-profile/fixtures/rich-chat.js --down=0 --up=6 --live
```

## Verification

The final verification uses the repository's required checks and the browser
regression relevant to the changed companion:

- `pnpm run check`: passes.
- `pnpm test`: 1,041 tests pass across 48 files.
- `pnpm run test:firefox-profile`: 93 checks pass.
- `pnpm run test:regression -- --group=shared --match=sticky-header`:
  passes in Firefox, Chromium, and WebKit.

The initial sandboxed unit run could not bind a relay test server. The same
suite passed with local socket access. Dependency sourcemap warnings remain
non-failing diagnostics. Raw profiles and command output remain under ignored
`browser-artifacts/`; no captures were uploaded.
The final process audit found no remaining audit browsers, native helpers,
or temporary servers. Pre-existing development servers were preserved.
