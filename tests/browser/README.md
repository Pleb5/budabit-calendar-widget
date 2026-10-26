# Featured calendar protocol fixture

This mounts the actual Svelte widget in an iframe, speaks its real SDK message
protocol, and imports the reviewed host's `resolveExactRefs` implementation.
It uses locally signed disposable fixtures. By default, complete or incomplete relay
results are supplied in memory. With `transport=mock`, bounded WebSocket REQs are
intercepted by the host repository's existing MockRelay. It does not instantiate
the full host app or exercise its WebSocket loader; host bridge tests cover
permission-scoped query wiring.
There are no signing/publishing/account actions exposed to the widget.

Start from this widget checkout using existing dependencies:

```sh
BUDABIT_CHECKOUT=/absolute/path/to/budabit node node_modules/vite/bin/vite.js --config tests/browser/fixture.vite.ts
```

Open `/tests/browser/featured.html` with query parameters:

- `hostSource=/@fs/absolute/path/to/budabit/src/app/extensions/exact-ref-resolution.ts`
- `nostrSource=/@fs/absolute/path/to/budabit/node_modules/nostr-tools/lib/esm/pure.js`
- `mode=fixed`, `mixed`, `missing`, `timeout`, or `baseline`.

`baseline` mounts `.artifacts/baseline.html` (ignored) and emulates the old bridge's
timeout response when an exact pin is absent and one relay is incomplete.
Copy the deployed widget artifact there before this check. The investigated
0.2.14 manifest points to SHA-256
`378cbbd398ce4b93df468ed05e433469427ff36c2bac56bbade7c6a24aff8991`;
the canonical checkout's existing `dist/index.html` matched those bytes.
This identifies deployed bytes, not a proven reproducible source commit.

Inspect `window.fixtureTrace` for the actual widget requests. Expected:

- Baseline/timeout: bounded retries, then Retry and an unavailable message.
- Fixed: author-deletion message, no Retry, one exact request across startup
  refreshes, no broad requests.
- Missing: terminal not-found message, no Retry or broad request.
- Mixed: the explicitly pinned past event remains visible, with one unavailable
  event reported. The newer replacement survives an older deletion.

Use the session-owned browser helper; capture and read evidence screenshots.
These controlled results must not be described as a reproduction of the
operator's exact live relay failure.

To run the paired MockRelay regressions from the host checkout, set
`FEATURED_FIXTURE_URL` to the full fixture URL above (including both source paths),
then run `node node_modules/@playwright/test/cli.js test --config tests/featured-calendar.playwright.config.ts`.
The focused config uses one worker and an existing Chromium binary, with no host
build, account setup or application server startup.
