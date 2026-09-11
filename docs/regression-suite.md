# Browser regression suite

Run `pnpm run test:regression` to execute the browser regression scripts in
`scripts/regressions/`. The runner discovers each feature folder automatically,
runs scripts sequentially, and exits unsuccessfully if any script fails, times
out, or is interrupted. It continues after failures to report the full selection;
use `--fail-fast` to stop at the first failure.

## Run checks

Install dependencies and the Playwright browsers before your first run:

```sh
pnpm install
pnpm exec playwright install chromium firefox webkit
pnpm run test:regression
```

Choose a feature group, multiple groups, or part of a script name:

```sh
pnpm run test:regression -- --list
pnpm run test:regression -- --group=gallery
pnpm run test:regression -- --group=chat-tree,chat-editing
pnpm run test:regression -- --group=chat-tree --match=zoom
pnpm run test:regression -- --match=refresh-anchor --timeout=1200
pnpm run test:regression -- --group=runtime --fail-fast
pnpm run test:chat-tree
```

The timeout is per script, in seconds, and defaults to 600. Unknown groups,
unknown options, and selections without matching tests fail instead of reporting
an empty suite as successful. `--list` doesn't start a server or browsers.

The runner starts Vite on an available loopback port and closes it afterward.
To reuse a server you already own, set `BROWSER_MATRIX_URL`:

```sh
BROWSER_MATRIX_URL=http://localhost:5173 pnpm run test:regression -- --group=history
```

The runner doesn't stop that external server. Each script runs in a separate
worker that tracks and closes its Playwright browsers, including after assertion
failures or cancellation. A worker that doesn't stop within five seconds after
cancellation is forcibly terminated. Screenshots and existing diagnostic outputs
stay local under ignored `browser-artifacts/`.

## Feature groups

Each folder is a selectable group. A script belongs to one group even when it
covers interactions with another feature.

| Group | Coverage |
| --- | --- |
| `chat-content` | Attachments, generated files, images, copying, tool order, rendering, and provider context. |
| `chat-editing` | Editing, deletion, version controls, version anchoring, and touch actions. |
| `chat-scrolling` | Scrollback, prompt anchors, composer resizing, footers, and stopped-response landing. |
| `chat-storage` | Drafts, refreshes, reloads, restoration, import, export, sharing, and lifecycle. |
| `chat-tree` | Navigation, headings, placement, zoom, reveal, persistence, lifecycle, and bottom geometry. |
| `gallery` | Controls, headers, paging, reloads, and resizing. |
| `photo-preview` | Loading, navigation, zoom, cleanup, and overlay behavior. |
| `history` | Paged history, edge styles, and tail behavior. |
| `runtime` | Dynamic resizing, follow landing, pin replacement, streaming heights, and lab logging. |
| `shared` | Sticky headers, theme persistence, and thinking Markdown. |
| `feed` | Feed demo behavior. |
| `newspaper` | Newspaper demo behavior. |

## Browser coverage and other suites

The suite preserves each script's existing browser selection. Many scripts loop
over Firefox, WebKit, and Chromium; others use Firefox only, two engines, or a
`BROWSER_ENGINE` setting. A full suite run means all scripts, not every script in
every browser. There is deliberately no global `--engine` option: scripts don't
yet share a browser-selection contract. For engine-specific investigation, run
an individual script with the environment variables it supports. Direct scripts
require an existing Vite server; their default ports are unchanged.

The other commands remain separate:

- `pnpm test` runs deterministic unit tests, not browser scripts.
- `pnpm run test:regression-runner` checks discovery, selection, worker results,
  timeout handling, and cancellation without launching browsers.
- `pnpm run test:browser` runs the existing lab/chat matrix, including its
  refresh-anchor and generated-file checks. It retains its suite, engine, and
  chaos options; those two checks also belong to the feature regression suite.
- `pnpm run test:firefox-profile` checks the profiling analysis tools.
- `pnpm run profile:firefox` and the standalone benchmark scripts are profiling
  tools, not part of this correctness suite.

Automated browser gestures don't establish smooth physical scrolling or native
momentum behavior. Follow the [Firefox-first workflow](firefox-profiling.md) for
performance investigations.

## Add a regression

Place a standalone `*-regression.mjs` script directly inside the appropriate
feature folder. Read the server URL from `BROWSER_MATRIX_URL`, use isolated
Playwright contexts, and close browsers in `finally`. Keep assertions in the
script; the runner reports its exit status without weakening failures or retrying
them automatically. New feature folders are discovered without a manifest edit.

Run the affected group, `pnpm run test:regression-runner`, `pnpm run check`, and
`pnpm test` before handing off changes. Updating a shared browser helper can
require a full regression run.
