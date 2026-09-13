# Top-page anchor shift investigation

> Verification record, not current API guidance. Results and status apply
> to the revision and workload described below. See the
> [release plan](../streaming-integration-plan.md) for current release status.

The supplied transcript reproduced a rounding defect after **Scroll to top**
and the subsequent history-page commit. The fix keeps stacked row heights
on whole CSS pixels at integer display scales. It changes no public API,
scroll listener, settle timing, or paging policy.

## Cause and scope

Previously, a 2x display allowed half-CSS-pixel row heights. Some browser
configurations floor or round `scrollTop` assignments to whole CSS pixels.
A prepended page with a half-pixel total therefore moved retained rows by
more or less than the accepted scroll correction: a 0.5 CSS px displacement,
or one physical pixel at 2x. Rounding each stacked height up to a whole CSS
pixel removes that mismatch without clipping content. Fractional display
scales and host-positioned layouts retain their existing device-pixel grid.

This addresses the measured rounding defect. It does not establish that
every perceived compositor shift has the same cause. Installed Firefox on
the external display accepted half-pixel corrections and showed no DOM
anchor displacement in the two measured button-driven commits even before
the fix. The user subsequently confirmed that the original visual shift was
gone on the reported external display; this is user acceptance, not an
additional instrumented Safari capture.

## Reproduction and browser checks

The user supplied `chat-2026-09-13-3.md`, a 92-turn exported transcript.
Its contents remain local and are not checked into the repository.
The sequence is: import, press **Scroll to top**, wait for the page to load,
then repeat. It is not equivalent to testing only wheel scrolling.

The pre-fix exact-transcript probe found 0.5 CSS px drift on a later Firefox
page and on WebKit/Chromium pages. Its initial first-page sample selected
an offscreen overscan row; that sample is not visible-anchor evidence.
The durable regression instead requires the sampled message to intersect
the viewport. After the fix, all three transcript prepends measured 0 CSS px
drift in Firefox, Chromium, and WebKit. Five chat-history prepends per engine
also measured 0, versus intermittent 0.5 CSS px drift before the fix.

Run the synthetic regression without supplying a transcript:

```sh
pnpm run test:regression -- --match=chat-prepend-anchor
```

To repeat with a local, linear serialized transcript, set
`PREPEND_TRANSCRIPT` to its absolute path. The test imports it directly; no
copy or upload is required. The default test uses synthetic content.

## Matched installed-Firefox captures

Both button captures used Firefox 155.0.1, a fresh temporary profile, closed
DevTools, the external LU28R55 at 2x/60 Hz, and an inner window of 1900 by
965 CSS pixels. The supplied transcript was imported locally. Two timed
button activations exercised the actual click handler and runtime glide;
there were no wheel gestures or manual trackpad input in these captures.

| Measurement | Before | After |
| --- | ---: | ---: |
| Local run ID | `run-XjDMKi` | `run-HySu5A` |
| Sample duration | 15.00 s | 15.00 s |
| Frame interval p95 | 17.14 ms | 17.12 ms |
| Maximum frame interval | 17.66 ms | 17.50 ms |
| Intervals above 25 ms | 0 | 0 |
| Scroll events / assignments | 154 / 154 | 154 / 154 |
| Measured page commits | 2 | 2 |
| DOM anchor displacement | 0, 0 CSS px | 0, 0 CSS px |

Mutation callbacks compared row translation deltas with accepted scroll
corrections. The animation-frame sampler performed no layout reads. The
diagnostic is not a screenshot/presentation test or a CPU-neutrality claim.
The unchanged Firefox DOM result is not evidence of a reproduced physical
jitter fix in that browser.

The tracked `scripts/firefox-profile/fixtures/imported-chat-top.js` preserves
the diagnostic. Stage the source under ignored `browser-artifacts/`, then
run it with a `profile-transcript` query parameter pointing to that local
file. Use `--warmup-ms=10000 --manual-seconds=15 --live --layout=none` and the
external display. Here `manual-seconds` is only the runner's timed capture
mode; the fixture activates both buttons. Each original run retains its
exact setup expression and metadata locally.

Earlier native-wheel captures did not reproduce the button-specific report:
`run-7nvcg4` used synthetic rich content, `run-iZcwAS` used chat-history, and
`run-Lzy4Gi` used the supplied transcript. A longer history capture,
`run-kKarAh`, lost its start marker from the profiler buffer and is invalid
performance evidence. Raw captures remain local and ignored.

## Verification and remaining acceptance

The new unit tests cover integer-scale stacked anchoring and preservation of
host-positioned height grids. Browser regressions measure the actual visible
message, not just scroll position or frame timing. The runtime change adds
no work to the scroll-event path.

The user confirmed the original visual symptom is gone after reloading the
demo. Fractional display scales, native compositor presentation, and broad
CPU performance signoff are not resolved by these rounding checks.
