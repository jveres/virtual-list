# Clean code audit after native-scroll cleanup

The audit started at `24fdcc7` with a clean working tree. Three medium-severity
findings were reproduced and fixed. No high-severity findings were identified.
A second review pass found no further high- or medium-severity issues in the
reviewed paths.

## Scope

The review covered runtime scrolling, cancellation, disposal, paging, reach and
follow ownership, companion lifecycles, measured-text integrations, streaming
message/tool rendering, attachment and transcript boundaries, and regression
process cleanup. It focused on correctness, resource ownership, exception
handling, and obsolete assumptions after the native-only migration. This is a
bounded code audit, not proof that the repository has no defects.

These are correctness investigations. No performance improvement or physical
scroll smoothness is inferred from the automation results.

## Findings and fixes

| Severity | Finding | Fix and evidence |
| --- | --- | --- |
| Medium | Reaching a changed live target could release scroll ownership while the browser still animated toward the original destination. | Stop outstanding motion before reporting the changed target complete. A unit regression failed before the fix. |
| Medium | Firefox ignored an instant scroll to the current position, leaving the old smooth animation running after cancellation. | Move one pixel and restore the original position with native instant requests in the same task. Isolated browser checks verify that the final position remains unchanged after both explicit cancellation and changed-target completion. |
| Medium | A native cancellation exception exited list disposal before removing rows or disconnecting observers. | Collect the cancellation error, finish teardown, then surface it. The regression verifies command cancellation, row destruction, empty observers, and idempotent disposal. Preserve both the original request error and a cleanup error when both fail. |

The cancellation control in Firefox continued from 249 to 9,979 pixels after a
same-position instant request. Assigning `scrollTop` also failed to stop it.
The two-request stop held its original position in Firefox, Chromium, and
WebKit. These are synthetic programmatic-animation checks, not native gesture
or display-presentation measurements.

## Verification

`pnpm run check` and all 1,059 unit tests pass. The reusable browser regression
is `scripts/regressions/runtime/native-scroll-retarget-regression.mjs`:

```sh
pnpm run test:regression -- --match=native-scroll-retarget
pnpm run test:regression -- --match=chat-reach-takeover
pnpm run test:regression -- --match=chat-answer-follow
```

The browser checks require actual intermediate movement. They verify final
position, completion outcome, ownership release, paging progress, and follow
limits. Temporary diagnostics are removed after analysis; compact reproduction
metadata is retained under ignored `browser-artifacts/clean-code-audit/`.
