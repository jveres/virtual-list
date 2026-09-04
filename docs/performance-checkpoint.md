# Runtime performance checkpoint

The browser checks and benchmarks cover runtime commit `822a026`. The only
code correction during validation was to the dynamic-height lab's visibility
assertion; no runtime behavior changed.

## Browser acceptance

Full scenarios passed in Chromium, Firefox, and WebKit for `same-height`,
`freeze`, and `live`. Chat acceptance also passed in all three engines.
The lab reported zero violations and zero reset violations on passing runs;
chat reported no violations or browser errors.

The initial Chromium `live` run reported a false positive during a glide:
a row ended at 6064px while the viewport started at 6063px. The assertion's
positive 1px tolerance classified that still-visible row as entirely above
the viewport. The corrected comparison requires the bottom to be clearly
above the viewport, consistent with the lab's tolerance for moved rows.
The full Chromium `live` scenario then passed in isolation. The original
failure trace remains in `browser-artifacts/chromium-live.log`.

Scripted wheel input cannot validate a physical trackpad re-grab with fingers
resting during a bounce. That Firefox acceptance case remains a manual check.

## Benchmark method

The benchmark runs in real, headless browsers against a Vite development
server, sequentially after acceptance tests finish. It uses a blank page,
a 600px viewport, and simple 40px rows. It compares measured and declared
heights at 1,000 and 10,000 items under `live` updates.

For each case, a ten-row prepend is held while a mounted row receives 110
updates. The first ten updates warm the path; the following 100 are timed.
Each case runs three times, giving 300 timed updates. The script checks that
the prepend stays held, the latest token survives its commit, and all row
elements receive destruction callbacks on disposal.

These are synchronous runtime costs, not markdown-rendering benchmarks,
paint latency, or end-to-end frame times. Both APIs run on the same current
implementation: this is not a before/after comparison of the refactors.
Browser timer resolution rounds many individual calls to zero, especially
in Firefox and WebKit, so the table reports means rather than zero medians.
Treat the values as indicative, not precise cross-engine rankings.

## Results

For 10,000 starting rows, mean synchronous update latency was:

| Engine | Height source | `updateItem` | `setItems` |
| --- | --- | ---: | ---: |
| Chromium 151.0.7922.34 | Measured | 0.035ms | 1.017ms |
| Chromium 151.0.7922.34 | Declared | 0.029ms | 1.776ms |
| Firefox 153.0 | Measured | 0.030ms | 2.800ms |
| Firefox 153.0 | Declared | 0.027ms | 3.557ms |
| WebKit 26.5 | Measured | 0.050ms | 1.277ms |
| WebKit 26.5 | Declared | 0.057ms | 1.697ms |

Targeted updates stayed in roughly the same range at 1,000 rows:
0.027–0.063ms. Full snapshots cost 0.123–0.290ms at that size.

All engines retained 10,010 measured row elements during the held prepend,
versus 45 declared row elements. Both configurations mounted 45 rows.
These counts come from render/destruction accounting, not heap profiling;
declared lists still retain data and geometry for all items.

Measured-list constructor medians at 10,000 items ranged from 70–85ms in
Chromium, 125–127ms in Firefox, and 850ms in WebKit across the two API cases.
Declared-list construction took 2.9–7ms. API selection happens after boot,
so differences between those boot samples are run variation, not API effects.

The synchronous command that commits the prepend and jumps to the start took
roughly 1–4ms at 10,000 rows. It includes command takeover and window work;
it does not isolate pure commit duration or subsequent rendering.

## Reproduce

Start the server in one terminal:

```sh
pnpm exec vite --host 127.0.0.1 --port 4175 --strictPort
```

Run acceptance, then the benchmark without other test workloads:

```sh
BROWSER_MATRIX_URL=http://127.0.0.1:4175 pnpm run test:browser
node scripts/browser-benchmark.mjs --url=http://127.0.0.1:4175
```

The benchmark accepts `--engine=chromium`, `--engine=firefox`, or
`--engine=webkit`. It writes results, versions, and a timestamp to
`browser-artifacts/runtime-benchmark.json`, which is ignored by Git.
Each run replaces that results file.

## Next steps

Prioritize measured-row retention and startup before further per-token
optimization. A bounded offscreen DOM cache could reduce retention, but it
needs explicit remount/state semantics; silently evicting current measured
rows would change behavior. Eviction alone also does not remove initial
premeasurement cost when exact heights are required.

Profile a representative markdown conversation and take heap snapshots before
choosing that policy. The remaining commit-function cleanup is a readability
task, not a demonstrated performance bottleneck in this fixture.
