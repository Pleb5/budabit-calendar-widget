# Publishing Notes

For release 0.2.15, use `manifest:release:after` or
`manifest:release:before` with the uploaded `WIDGET_APP_URL`. Serve the HTML
from an iframe-compatible host: `Content-Disposition: attachment` prevents
the artifact from running inside BudaBit. Deploy the paired host resolution
changes before checking terminal deleted/missing selections.

The widget is designed for BudaBit's community widget publisher.

- Default header: `Featured events`
- Query permission: `community:queryEvents`
- Capability permission: `community:checkWriteCapabilities`
- Optional toast permission: `ui:toast`
- Shared config declaration: `budabit-calendar-widget=featured-calendar-event`
- Supported slots: `community-home-before-quicklinks`, `community-home-after-quicklinks`

Configuration is intentionally based on generic community context:

- Use `community:checkWriteCapabilities` with descriptors `{kind: 31923}` and `{kind: 31922}` for configuration access.
- Do not expect a host-provided `canCreateCalendarEvents` boolean.
- Do not hard-code community section names. The host maps descriptors to active community sections before checking grants or querying.
- Refetch capabilities/events on `community:contextChanged` and ignore stale responses whose `contextSessionId` / `contextVersion` no longer match the current context.
- Keep the widget fetch-based. Canonical event IDs/addresses are queried exactly. Optional host `resolutions` metadata with `deleted` or `missing` is terminal for that request and skips broad discovery. Older hosts without that metadata and legacy bare `d` refs retain bounded broad discovery.
- Confirmed deleted selections display an author-deletion message; mixed results keep available cards and show an unavailable count. Explicit past pins remain visible. No configuration is rewritten. Identical all-terminal startup refreshes coalesce for 30 seconds; later refreshes may discover a newer replacement.
- Keep broad discovery bounded and preserve exact configured events while paging publication history.
- Publish shared configuration with the revision observed when editing began so compatible hosts can reject stale moderator drafts.
- Treat catalog-declared or runtime `UNSUPPORTED_CAPABILITY` shared-config support as read-only URL/local fallback mode.
- Treat the before/after manifest scripts as alternative placements of one widget identifier, not simultaneously installable variants.
- Set `COMMUNITY_RELAYS` from the tagged community definition; standalone publishing has no hard-coded relay fallback.

For legacy or read-only host fallback, publish the widget with an app URL containing one or more `event` params (`eventRef` is also read for older URLs):

```text
?header=Featured%20events&event=31923%3A<author-pubkey>%3A<event-d-tag>&event=31922%3A<author-pubkey>%3A<event-d-tag>
```

The configuration panel persists selected events through `community:publishSharedConfig`.
