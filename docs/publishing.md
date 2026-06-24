# Publishing Notes

The widget is designed for BudaBit's community widget publisher.

- Default header: `Featured event`
- Query permission: `community:queryTargetEvents`
- Optional toast permission: `ui:toast`
- Supported slots: `community-home-before-quicklinks`, `community-home-after-quicklinks`

Configuration is intentionally based on generic community context:

- Use `communityContext.writeTargets.calendar.canWrite` and `communityContext.writeTargets.calendarDate.canWrite` for configuration access.
- Do not expect a host-provided `canCreateCalendarEvents` boolean.
- Do not hard-code community section names. The host maps logical targets to renamed sections before querying.

For a community-wide featured event, publish the widget with an app URL containing:

```text
?header=Featured%20event&event=31923%3A<author-pubkey>%3A<event-d-tag>
```

The configuration panel generates this URL after a calendar writer selects an event.
