# Publishing Notes

The widget is designed for BudaBit's community widget publisher.

- Default header: `Featured event`
- Query permission: `community:queryEvents`
- Capability permission: `community:checkWriteCapabilities`
- Optional toast permission: `ui:toast`
- Supported slots: `community-home-before-quicklinks`, `community-home-after-quicklinks`

Configuration is intentionally based on generic community context:

- Use `community:checkWriteCapabilities` with descriptors `{kind: 31923}` and `{kind: 31922}` for configuration access.
- Do not expect a host-provided `canCreateCalendarEvents` boolean.
- Do not hard-code community section names. The host maps descriptors to active community sections before checking grants or querying.
- Refetch capabilities/events on `community:contextChanged` and ignore stale responses whose `contextSessionId` / `contextVersion` no longer match the current context.

For a community-wide featured event, publish the widget with an app URL containing:

```text
?header=Featured%20event&event=31923%3A<author-pubkey>%3A<event-d-tag>
```

The configuration panel generates this URL after a calendar writer selects an event.
