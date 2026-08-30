# Publishing Notes

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
- Keep the widget fetch-based. Canonical event IDs/addresses are queried exactly, followed by broad descriptor discovery for unresolved or legacy bare `d` refs.
- Keep broad discovery bounded and preserve exact configured events while paging publication history.
- Publish shared configuration with the revision observed when editing began so compatible hosts can reject stale moderator drafts.
- Treat catalog-declared or runtime `UNSUPPORTED_CAPABILITY` shared-config support as read-only URL/local fallback mode.
- Treat the before/after manifest scripts as alternative placements of one widget identifier, not simultaneously installable variants.

For legacy or read-only host fallback, publish the widget with an app URL containing one or more `event` params (`eventRef` is also read for older URLs):

```text
?header=Featured%20events&event=31923%3A<author-pubkey>%3A<event-d-tag>&event=31922%3A<author-pubkey>%3A<event-d-tag>
```

The configuration panel persists selected events through `community:publishSharedConfig`.
