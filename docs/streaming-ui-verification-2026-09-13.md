# Streaming UI verification — September 13, 2026

Installed Safari composer checks and scoped-typography checks passed without
an application patch. This supplies the two missing SI-05 verification
cases from the [release plan](streaming-integration-plan.md). Final API and
release-candidate signoff remain separate.

The tested application is commit `732e143` on `feat/streaming-integration`.
Working-tree additions are documentation and reusable test scripts, not
runtime changes or new example apps. No Safari preferences were changed.

## Installed Safari composer

Two successful isolated native WebDriver sessions used Safari 26.6.2
(`21624.5.1.11.3`) on macOS, with automatic inspection and profiling disabled.
The window was on the LU28R55 at screen position 1450,31, with a 1900×997
CSS-pixel inner viewport and 2× scaling. Existing Safari tabs were preserved.

The full streaming demo imported six synthetic turns into the automation
session. Native WebDriver typing tested same-line input and input while
scrolled away. Programmatic values plus input events exercised actual
composer height changes. Both runs produced the following measurements:

| Checkpoint | Composer height | Scroll position | Bottom gap |
| --- | ---: | ---: | ---: |
| Two-line prompt | 66 px | 2116 px | 0 px |
| After each native `a`, `b`, `c` | 66 px | 2116 px | 0 px |
| Three-line prompt | 88 px | 2138 px | 0 px |
| Capped long prompt | 160 px | 2210 px | 0 px |
| Short prompt | 44.39 px | 2094 px | 0 px |
| Scrolled away, before and after native `x` | 66 px | 1936 px | 180 px |

The composer grew and shrank without losing bottom alignment. Typing within
one line didn't change its height or the chat's scroll position. Typing
while scrolled away didn't rearm following. Browser error and unhandled
rejection collections were empty.

Local runs `run-gK2TcW` and `run-SoYQlL` under
`browser-artifacts/safari-ui/` contain JSON measurements and screenshots.
Before/after typing, maximum-height, and short-prompt screenshots from the
first successful run were inspected: no stale or blank chat surface appeared
at those checkpoints. This is installed-Safari evidence, not a Playwright
WebKit result. Checkpoint screenshots don't prove every intermediate physical
frame is artifact-free, and this isn't a trackpad or compositor profile.

The initial attempt, `run-N1lZom`, paused at the import confirmation and lost
its automation session before assertions ran. It is failed setup, not a pass.
The runner now accepts only the synthetic six-turn `safari-composer.md`
confirmation in its isolated page and restores the original confirmation
function afterward. Unexpected confirmations fail the test instead of being
accepted. Subsequent runs required no manual dialog response.

## Scoped typography and measurement containers

The shared browser-side scenario uses only supported source entry points.
Its two distinct ancestors share a scoped monospace font, CSS variables,
letter spacing, and inherited row styles. One contains the viewport; the
other is supplied to both runtime measurement and collapse preparation.

The scenario passed in Firefox, Playwright WebKit, Chromium, and installed
Safari. The final repeat adds first-mount reserved-height assertions before
ResizeObserver can correct a mismatch. It verifies:

- All 20 unknown-height rows are prepared detached, with the scoped 32 px
  line height producing a 160 px five-line collapse limit before mounting.
- Each observed first mount fits its premeasured reserved height exactly.
- Expansion preserves the reading point. A retained element unmounts,
  remounts, and keeps its expanded state.
- Narrowing the host from 540 to 320 px remeasures wrapped text.
- Updating both ancestors to 19 px font size and 29 px line height, followed
  by explicit synchronization/remeasurement, produces a 145 px collapse limit.
- Replacing the text with a short value hides the toggle and removes collapse.
- Disposal destroys all 20 retained elements and removes the measurement root.

Committed and mounted row heights matched at every inspected checkpoint:
212 px collapsed, 564 px expanded, 820 px after narrowing, 197 px with the
updated typography collapsed, and 53 px for the short replacement. The
reading point remained at viewport offset zero through these checkpoints.
This verifies inherited/scoped styles with matching ancestors, not arbitrary
host CSS, delayed web-font loading, or selectors that intentionally differ
between the viewport and measurement container.

## Reproduction and ownership

The standard regression runner owns its temporary Vite server and browsers:

```sh
pnpm run test:regression -- --group=runtime --match=scoped-typography
pnpm run test:regression -- --match=composer-resize
```

For installed Safari, first start its driver in a separate terminal:

```sh
/usr/bin/safaridriver -p 4445
```

Then run the native check from the repository root. The screen coordinate
below matches this investigation; select the appropriate coordinate for your
display arrangement. Leave the automation window undisturbed.

```sh
SAFARI_WINDOW_X=1450 node scripts/safari-ui-check.mjs
```

The script creates and closes its own Safari session and Vite server. It
doesn't stop an externally started driver or enable remote automation. Stop
your driver after the run. Safari remote automation must already be allowed;
a refused session isn't successful browser evidence. Screenshots and reports
stay in ignored `browser-artifacts/safari-ui/`.

## Verification and release status

`pnpm run check` and all 915 unit tests passed. The existing composer
regression passed in all three Playwright engines. The final scoped-typography
regression passed in all three engines and installed Safari. Both successful
Safari sessions closed, and their temporary servers exited. The task-owned
driver was stopped; the pre-existing Safari process and development server
were preserved.

These results cover the previously missing installed-Safari composer and
custom measurement-container scenarios. The broader SI-05 checklist still
needs final evidence signoff on the committed release candidate. No runtime
or integration API was expanded, and no commit, push, merge, or tag was made.
