# Main-thread CPU and retained resources, September 29, 2026

Skipping unnecessary delimiter analysis in the owning `comrak-wasm` parser
reduces main-thread CPU by 12.7% in a matched Firefox prose-stream comparison.
The rich-Markdown parser benchmark is unchanged. Two separate ownership fixes
bound shared code-line caching and release image resources when a conversation
is replaced. These memory results measure retained strings and Blob resources,
not browser process memory or GPU allocations.

The user confirmed both the parser preview and the combined renderer-cache
preview render correctly through completion and scrolling. The scroll handler
and anchoring algorithm are unchanged in this round.

The parser fix is released as `comrak-wasm` `v0.6.2`, commit `c8fd8ad`.
Its versioned build has the same measured byte size as the candidate. The WASM
hash changes with the Cargo package version; the capture metadata retains the
original measured build hash.

The renderer fix is released as `markdown-viewer` `v0.8.10`, commit `cbad224`,
with an exact `comrak-wasm` `v0.6.2` pin. This repository pins the renderer's
GitHub tag and updates its lockfile and build-script allow-list accordingly.

## Firefox CPU comparison

The captures use installed Firefox 156.0.1, build 20260921121718, a fresh
temporary profile, and closed DevTools. The LU28R55 display is 1920 × 1080
logical pixels at 2× scaling and 60 Hz. The outer window is 1900 × 1049 and the
viewport is 1900 × 965. Four background workers attempt 10 ms of CPU work per
20 ms period; this is bounded CPU contention, not a model of GPU contention.

The prose workload uses 160 rich history turns, a 44,928-character reply,
468 text chunks, a long streaming trail, and 12-second stream deadlines inside
a 20-second capture. The tool event divides the prose into separate rendered
segments. Both captures completed the same workload, ending at 51 mounted DOM
nodes and a 22,304-pixel scroll height.

| Metric | Baseline | Parser candidate |
| --- | ---: | ---: |
| Main-thread CPU | 1,605.533 ms | 1,401.754 ms |
| Main-thread awake time | 1,669.578 ms | 1,458.278 ms |
| Animation-frame callback work | 372.506 ms | 291.471 ms |
| Synchronous reflow markers | 200.733 ms | 197.598 ms |
| Style markers | 125.524 ms | 123.942 ms |
| Sampled inclusive `renderMarkdown` | 319 ms | 119 ms |
| Sampled inclusive `mdToStreamingHtmlBlocks` | 291 ms | 95 ms |

Inclusive samples overlap and must not be added. GC and scheduler variation
also affect the CPU total. This is one matched pair, not a statistical estimate
or evidence that intermittent presentation jitter is resolved. The round has
three native captures: a rich-content discovery capture, then the prose pair.

The parser's healing passes previously built literal ranges even when their
delimiter could not occur. Cheap absence checks skip these passes for missing
link, emphasis, code, and math delimiters. Existing semantics remain
covered by Rust and WASM tests. Three-sample Node 24.21.0 medians provide a
separate algorithm check:

| Parser workload | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| Long plain paragraph, 420 prefixes | 499.75 ms | 181.75 ms | −63.6% |
| Plain multiple blocks | 170.22 ms | 158.13 ms | −7.1% |
| Rich chat, 461 prefixes | 896.83 ms | 899.86 ms | No improvement |
| Open code block | 49.77 ms | 46.61 ms | −6.4% |

Every prefix's output hash matches. WASM memory remains 59 pages in this
benchmark; the optimized binary grows by 688 bytes. Node timings do not
establish a browser-wide speedup.

## Code-line ownership

The renderer has a hidden shared cache of processed code lines and a global
snapshot of the last block's input and output. The old line-count limit does
not bound expanded color-preview HTML. Neither allocation appears in public
cache statistics or responds to `clearAllCaches()`.

A deterministic 512-line streaming color fixture retains 14,593,138 estimated
UTF-16 bytes in the old shared cache. The candidate retains 514,044 estimated bytes
within a 512 KiB slice of the existing 10 MiB reusable-cache budget. An
oversized standalone line no longer leaves an unbounded last-block snapshot.
Cache clearing removes both the shared lines and active working snapshots.

Active streaming blocks need positional reuse even when larger than the shared
budget. Their snapshots now belong to the renderer through weak ownership and
are released on completion, cursor movement out of code, reset, invalidation,
or destruction. Concurrent viewers have separate state. These active working
snapshots can scale with the current code block and are explicitly excluded
from reusable-cache statistics. The 10 MiB figure is not a total renderer
memory cap.

A rejected candidate capped the active snapshot too. Its 512-line append
benchmark became 6.55 times more expensive because the smaller cache repeatedly
evicted useful lines. The revised ownership design preserves positional reuse:
three-sample CPU medians for 20 appends are 69.569 ms before and 23.042 ms after,
with identical output hashes. For a small 100-line block, wall time changes
from 0.224 to 0.387 ms for all 20 appends. These are Node microbenchmarks, not
physical browser-memory measurements or a claim of the same browser CPU gain.
Node process CPU includes worker and garbage-collection threads.

## Conversation image resources

Safari's reduced-size display copies were shared for the lifetime of the page.
Importing another conversation retained the prior conversation's data-URL keys,
Promises, and object URLs. The image preview also retained its recent original
image URLs until page unload.

Conversation replacement now closes and unbinds the old preview, terminates
pending conversion work, cancels decode probes, and revokes the old URLs after
disposing the old rows. Generation checks prevent late conversions or decodes
from repopulating the cache. Ordinary paging continues to reuse the current
conversation's resources.

The deterministic resource test uses 24 distinct 256 KiB Blob copies in each
of three conversations. Previously, retained resources grow from 24 to 48 to
72 URLs, or 6 to 12 to 18 MiB of encoded Blob data. With the fix, each active
conversation has 24 URLs and each replacement releases all old URLs. This
checks ownership directly; it does not estimate decoded pixels or browser RSS.

## Reproduction and retained evidence

The baseline repository revisions are virtual-list `822094b`, markdown-viewer
`bf0b908` (`v0.8.9`), and comrak-wasm `7b5e995` (`v0.6.1`). Ignored compact
capture directories preserve exact source hashes, patches, commands, browser
build, geometry, and deterministic workload metadata:

- `browser-artifacts/main-thread-next/firefox-diagnostic-gDpPGs`: rich discovery.
- `browser-artifacts/main-thread-next/firefox-diagnostic-XeUDgv`: prose baseline.
- `browser-artifacts/main-thread-next/firefox-diagnostic-wRPtq0`: prose candidate.
- `browser-artifacts/scroll-hot-path/comrak-heal-{baseline,guards}.json`: parser
  benchmark summaries.
- `browser-artifacts/main-thread-next/code-line-cache-summary.json`: code-line
  benchmark summary; the rejected candidate has a separate patch and summary.

After rebuilding the recorded parser source in its owning repository, run the
matched workload with:

```sh
COMRAK_WASM_LOCAL=1 node scripts/firefox-profile/cpu-contention.mjs -- \
  node scripts/profile-chat.mjs --browser=firefox --scenario=follow \
  --mode=diagnostic --display=LU28R55 --refresh-hz=60 --seconds=20 \
  --stream-ms=12000 --sections=48 --history=160 --content=prose \
  --trail=long --output=browser-artifacts/main-thread-next
```

Both prose captures use the same parser-preview loading path and the installed
`markdown-viewer` `v0.8.9` pin. The baseline temporarily builds the recorded
parser revision; the repeat builds its candidate patch. The workload hash is
`fe0cf495c5acc891f8b33c18bdc8f76ad9044e4ea8f1c404135a79853f1aa1ad`.

The profiler removes raw profiles and temporary browser profiles after analysis.
No captures are uploaded. Keep source fixtures and compact summaries; regenerate
WASM output and compiler/browser caches as needed.

Run the parser benchmark with `node bench/streaming-heal.mjs` in comrak-wasm.
Run `node --expose-gc scripts/benchmark-code-line-cache.mjs` in markdown-viewer
for the portable comparison against `v0.8.9`. Its fixture and
cleanup are part of the owning repository. Shared and active string estimates
can refer to the same strings and must not be summed.

New preview captures record generated runtime hashes separately from source
hashes, plus available Rust, wasm-bindgen, and wasm-opt versions. The two prose
captures predate that safeguard: their WASM hashes come from the matching build
benchmarks, with that provenance recorded explicitly. Other generated hashes
and toolchain versions were not recorded at capture time.

## Verification

The parser passes 226 Rust tests, 378 WASM tests, lint, type checking, formatting,
and Clippy. The conversation resource changes pass 26 focused lifecycle tests.
The application passes `pnpm run check`, 5,623 tests, and 157 portable profiler
checks. Existing CSS diagnostic-override warnings and dependency sourcemap
warnings remain unrelated to these changes.

The code-line candidate passes all 1,175 renderer tests, full checks, and its
build. Tests cover real viewer completion, reset, destruction, clearing, and
concurrent-owner isolation. Generated files grow by 6,659 bytes, including
2,935 runtime bytes; the generated ceiling increases to 532,000 bytes while
the 290,000-byte runtime ceiling remains unchanged.

The combined preview passes both trail browser regressions in Chromium,
Firefox, and WebKit. Four image regressions cover display-copy geometry,
retired-image release, preview interaction, and reconciliation across their
configured browser engines. All six scripts pass after the user's early check.

## Released-dependency memory gates

The installed GitHub pins pass the existing Firefox and Safari streaming memory
gates without increasing budgets. Both captures use fresh sessions, closed
DevTools, the LU28R55 at 2× scaling, a long trail, and six allocation cycles.
Each capture observes an active streaming trail and completes the reply. These
instant-scroll stress checks validate allocation behavior, not physical
trackpad momentum or presentation smoothness.

| Gate metric | Firefox | Safari |
| --- | ---: | ---: |
| Largest process peak | 423.21 MiB | 577.27 MiB |
| Browser-wide checkpoint maximum | 1,077.66 MiB | 662.41 MiB |
| Median late-minus-early growth | −8.42 MiB | 32.69 MiB |
| Final-three-cycle range | 20.58 MiB | 20.98 MiB |

The process-peak limits are 600 MiB for Firefox and 768 MiB for Safari. Both use
a 1,400 MiB browser-wide limit, a 64 MiB growth limit, and a 40 MiB final-cycle
range limit. A passing finite gate does not prove zero growth over arbitrarily
long sessions or a reduction in browser RSS relative to another revision.

Firefox 156.0.1, build 20260921121718, uses a 1920 × 965 inner viewport. Safari
27.0.1, build 22625.1.29.11.28, uses a 1920 × 945 inner viewport. Both outer
windows are 1920 × 1049. Compact reports are
`browser-artifacts/memory/firefox-streaming-tniX9D` and
`browser-artifacts/memory/safari-streaming-huYnBZ`; cleanup reports no errors.

Reproduce these gates with:

```sh
pnpm run test:memory -- --browser=firefox --workload=streaming --trail=long --cycles=6 --display=LU28R55
pnpm run test:memory -- --browser=safari --workload=streaming --trail=long --cycles=6 --display=LU28R55
```

Each trial has six allocation cycles; these are not six comparison trials.
