# Featured Calendar Event Widget

Inline BudaBit Smart Widget for featuring one already-published community calendar event on the community home page.

## Behavior

- Renders in `community-home-before-quicklinks` or `community-home-after-quicklinks`.
- Reads generic `communityContext` from BudaBit.
- Queries events with `community:queryTargetEvents` for logical targets `calendar` and `calendarDate`.
- Derives configuration access from `communityContext.writeTargets.calendar.canWrite` or `communityContext.writeTargets.calendarDate.canWrite`.
- Shows the selected event to all viewers when the app URL includes `?event=...`.
- Gates only configuration controls. If there is no configured event and the viewer cannot write calendar events, it displays: `Request access to create calendar events in order to use this plugin`.

## Local Development

```bash
pnpm install
pnpm dev
```

## Verify

```bash
pnpm check
```

## Publish Through Budabit

1. Build the iframe app with `pnpm build`.
2. Host `dist/index.html` somewhere HTTPS-accessible, or upload it through Budabit's widget publisher.
3. In the Budabit community widget publisher, use the hosted app URL.
4. Choose either `Above home quicklinks` or `Below home quicklinks` as the widget slot.
5. After loading the widget as a calendar writer, pick an event and header.
6. Use the generated configured app URL if you want the selected event/header encoded into the published widget URL for all viewers.

The widget also includes manifest helper scripts for standalone kind `30033` event generation:

```bash
WIDGET_APP_URL="https://cdn.example.com/bubdabit-calendar-widget/index.html" pnpm manifest:after
WIDGET_APP_URL="https://cdn.example.com/bubdabit-calendar-widget/index.html" pnpm manifest:before
```

These scripts generate manifests for the below-quicklinks and above-quicklinks slots respectively.
