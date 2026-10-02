# Clean code audit after the performance closeout

The audit starts at `0edae93` (`v0.4.16`). Three review passes close four
medium-priority findings. No high-priority finding was identified, and the
last pass found no additional high- or medium-priority issue in the audited
scope.

## Scope and method

The audit covers the runtime, companions, integrations, demos, examples,
profiling tools, browser regressions, and unit tests. It checks module and
export reachability, obsolete assumptions, duplicated logic, CSS class
references, and resource ownership on failures.

TypeScript already checks unused locals and parameters. Knip 6.39.0 adds
module, export, and dependency analysis. The tracked root `knip.jsonc`
describes public entry points, standalone tools, injected fixtures, and
Vite-root browser imports. Reproduce that check without adding a project
dependency:

```sh
pnpm dlx knip@6.39.0
```

The final check reports zero issues. A separate pass includes entry-point
exports and reviews its results against the public API. Public types and the
documented deprecated `ScrollOptions.duration` compatibility field remain.
Tests and historical reports count as references only after their uses are
checked; a reference alone does not establish that a tool still works.

The clone scan uses jscpd 5.4.0 with comments excluded, a minimum of 12 lines,
and a minimum of 100 tokens. A second source-only scan lowers those limits to
8 lines and 65 tokens and checks similar functions at 0.9 similarity. These
are review inputs, not automatic deletion rules. See the tools' official
[Knip configuration reference](https://knip.dev/reference/configuration) and
[jscpd repository](https://github.com/kucherenko/jscpd).

## Findings and corrections

The fixes preserve the production runtime's behavior and public interfaces.
These are cleanup and correctness changes; they make no new performance claim.

| Priority | Finding | Correction and evidence |
| --- | --- | --- |
| Medium | Failed exact-history preparation loses ownership of its partial list and leaves its frame sampler running. | Dispose the list before propagating preparation failure, and stop the sampler in `finally`. The browser regression injects a failure after real preparation. Before the fix, Firefox reports an unbalanced row lifecycle and one pending frame; afterward, all three engines report balanced destruction and zero pending frames. |
| Medium | The old imported-transcript top-navigation probe watches row translations that native-flow rows no longer use. It can produce no anchor observations without reporting failure. | Remove the obsolete fixture and update its historical report to point to the maintained `chat-prepend-anchor` regression. That regression measures the visible anchor directly and passes all 30 prepend checks across Firefox, Chromium, and WebKit. Original local capture recipes remain available for historical reproduction. |
| Medium | Two memory runners duplicate the cleanup error-collection loop already implemented by `cleanupCapture`. | Route both through the existing helper, preserving cleanup order, each runner's resources, and their `invalid` status on failure. Existing portable tests cover continuing cleanup after errors and retaining a successful status. |
| Medium | The standalone Safari trail probe deletes a caller-supplied WebDriver session on exit. | Close only sessions created by the probe. Two portable tests exercise navigation failure with owned and supplied sessions. The supplied-session test fails before the fix and passes afterward. |

The audit also removes eight unnecessary internal exports, a duplicated CSS
comment, and a redundant copy of the Lucide license notice. The complete
notice remains in `public/lucide-license.txt`, where Vite includes it in the
distributed demo. No runtime implementation or dependency pin changes.

## Repeat review

The first pass finds the history failure cleanup, obsolete translation probe,
duplicated cleanup loops, and unnecessary exports. The second pass follows
resource ownership through the older standalone tools and finds the supplied
Safari session issue. The third pass repeats reachability and clone analysis,
checks CSS references and removed-file references, and reviews the final diff.
It finds no additional high- or medium-priority issue.

The final clone scan still reports 34 matches, covering 0.67% of scanned lines.
These are small test/fixture setup blocks, explicit resource-action lists,
parser-time theme bootstrap and SVG markup, and palettes repeated under
explicit-theme and system-theme selectors. They are retained as low-priority
or intentional repetition. Moving parser-time startup into an asynchronous
component would change behavior; combining unrelated test scenarios would
obscure their independent assertions. The audit does not claim zero repeated
text or prove that every possible defect is absent.

Other historical fixtures remain when they still reproduce a supported
experiment. Public compatibility, migration readers, and deterministic
rejected-candidate controls are not removed as dead code.

## Verification

The completed checks are:

- `pnpm run check`: passes with the two existing CSS diagnostic-override
  warnings.
- `pnpm test`: all 5,656 tests pass in 55 files. The first attempt was blocked
  by sandbox restrictions on localhost sockets; the authorized rerun passes.
- `pnpm run test:firefox-profile`: all 197 checks pass, including the new
  Safari session ownership cases.
- `pnpm run test:regression-runner`: all 11 checks pass.
- `pnpm run test:consumer`: both isolated source-distribution builds pass.
- `pnpm run test:regression -- --match=estimated-history`: ordinary cases and
  injected preparation failure pass in Firefox, Chromium, and WebKit.
- `pnpm run test:regression -- --match=chat-prepend-anchor`: five prepends in
  each of two demos pass in all three engines, with zero measured anchor drift.

The browser checks use isolated Playwright sessions for correctness. They do
not measure native gesture presentation or replace installed-Firefox profiling
for a performance claim. The Safari ownership tests use a fake WebDriver
transport; they do not navigate or close a user's Safari session.

Owned browser sessions and servers exited. The pre-existing demo server stays
running. Temporary audit output and test-generated caches are removed; compact
results remain under ignored `browser-artifacts/clean-code-audit-2026-10-02/`.
