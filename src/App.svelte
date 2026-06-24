<script lang="ts">
  import {
    createWidgetBridge,
    type CommunityEventDescriptor,
    type CommunityWidgetContext,
    type CommunityWriteCapability,
    type NostrEvent,
    type WidgetBridge,
    type WidgetInitPayload,
  } from 'budabit-sdk';

  const EVENT_DATE = 31922;
  const EVENT_TIME = 31923;
  const CALENDAR_DESCRIPTORS: CommunityEventDescriptor[] = [{kind: EVENT_TIME}, {kind: EVENT_DATE}];
  const DEFAULT_HEADER = 'Featured event';
  const NO_ACCESS_TEXT = 'Request access to create calendar events in order to use this plugin';
  const STORAGE_PREFIX = 'budabit-calendar-widget:config:';

  type WidgetConfig = {
    header: string;
    eventRef: string;
  };

  const tagValue = (event: Pick<NostrEvent, 'tags'>, name: string) =>
    event.tags.find((tag) => tag[0] === name)?.[1] || '';

  const readUrlConfig = (): WidgetConfig => {
    const params = new URLSearchParams(window.location.search);

    return {
      header: params.get('header')?.trim() || DEFAULT_HEADER,
      eventRef: params.get('event')?.trim() || params.get('eventRef')?.trim() || '',
    };
  };

  const initialUrlConfig = readUrlConfig();
  const hasUrlConfig = Boolean(initialUrlConfig.eventRef);

  let bridge = $state<WidgetBridge | null>(null);
  let initPayload = $state<WidgetInitPayload | null>(null);
  let communityContext = $state<CommunityWidgetContext | null>(null);
  let events = $state<NostrEvent[]>([]);
  let config = $state<WidgetConfig>(initialUrlConfig);
  let headerInput = $state(initialUrlConfig.header);
  let selectedEventRef = $state(initialUrlConfig.eventRef);
  let status = $state('Waiting for BudaBit community context...');
  let error = $state('');
  let loadingEvents = $state(false);
  let calendarCapabilities = $state<CommunityWriteCapability[]>([]);

  const canConfigure = $derived(calendarCapabilities.some((capability) => capability.canWrite));

  const calendarSectionNames = $derived(
    Array.from(
      new Set(calendarCapabilities.flatMap((capability) => capability.sectionNames))
    )
  );

  const calendarEventAddress = (event: NostrEvent) => {
    const identifier = tagValue(event, 'd');

    return identifier ? `${event.kind}:${event.pubkey}:${identifier}` : '';
  };

  const eventRefs = (event: NostrEvent) =>
    [calendarEventAddress(event), tagValue(event, 'd'), event.id].filter(Boolean);

  const matchesEventRef = (event: NostrEvent, ref: string) =>
    Boolean(ref && eventRefs(event).includes(ref));

  const selectedEvent = $derived.by(() => events.find((event) => matchesEventRef(event, config.eventRef)));

  const sortedEvents = $derived.by(() =>
    [...events].sort((a, b) => (getEventStart(a) || 0) - (getEventStart(b) || 0))
  );

  const configuredAppUrl = $derived.by(() => {
    if (!selectedEventRef) return '';

    const url = new URL(window.location.href);
    url.searchParams.delete('_t');
    url.searchParams.set('header', headerInput.trim() || DEFAULT_HEADER);
    url.searchParams.set('event', selectedEventRef);

    return url.toString();
  });

  const getStorageKey = (ctx: CommunityWidgetContext) => `${STORAGE_PREFIX}${ctx.pubkey}`;

  const readLocalConfig = (ctx: CommunityWidgetContext): WidgetConfig | null => {
    try {
      const raw = localStorage.getItem(getStorageKey(ctx));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<WidgetConfig>;
      if (!parsed.eventRef) return null;

      return {
        header: parsed.header?.trim() || DEFAULT_HEADER,
        eventRef: parsed.eventRef.trim(),
      };
    } catch {
      return null;
    }
  };

  const writeLocalConfig = (ctx: CommunityWidgetContext, next: WidgetConfig) => {
    localStorage.setItem(getStorageKey(ctx), JSON.stringify(next));
  };

  const parseTimestamp = (value: string) => {
    if (!value) return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
    const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00` : value);

    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  };

  function getEventStart(event: NostrEvent) {
    return parseTimestamp(tagValue(event, 'start'));
  }

  function formatDate(value?: number) {
    if (!value) return '';

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      ...(value % 86400 === 0 ? {} : {timeStyle: 'short'}),
    }).format(new Date(value * 1000));
  }

  function formatEventDate(event: NostrEvent) {
    const startRaw = tagValue(event, 'start');
    const endRaw = tagValue(event, 'end');

    if (event.kind === EVENT_DATE) {
      if (!startRaw) return 'Date not set';
      return endRaw && endRaw !== startRaw ? `${startRaw} to ${endRaw}` : startRaw;
    }

    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (!start) return 'Date not set';

    return end ? `${formatDate(start)} - ${formatDate(end)}` : formatDate(start);
  }

  const getEventTitle = (event: NostrEvent) =>
    tagValue(event, 'title') || tagValue(event, 'name') || 'Untitled event';

  const getEventSummary = (event: NostrEvent) => event.content.trim();

  const getCommunityContextKey = (ctx: CommunityWidgetContext | null) =>
    ctx ? `${ctx.contextSessionId}:${ctx.contextVersion}` : '';

  const responseMatchesContext = (
    response: {contextSessionId?: string; contextVersion?: number},
    expectedContext: CommunityWidgetContext
  ) =>
    response.contextSessionId === expectedContext.contextSessionId &&
    response.contextVersion === expectedContext.contextVersion;

  async function refreshCalendarCapabilities(ctx = communityContext) {
    if (!bridge || !ctx) return;

    const expectedContext = ctx;

    try {
      const res = await bridge.request('community:checkWriteCapabilities', {
        descriptors: CALENDAR_DESCRIPTORS,
      });

      if ('error' in res) {
        error = res.error;
        status = 'Unable to check calendar configuration access.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;
      calendarCapabilities = res.capabilities;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to check calendar configuration access.';
    }
  }

  async function loadCalendarEvents(ctx = communityContext) {
    if (!bridge || !ctx) return;

    const expectedContext = ctx;
    loadingEvents = true;
    error = '';
    status = 'Loading community calendar events...';

    try {
      const res = await bridge.request('community:queryEvents', {
        descriptors: CALENDAR_DESCRIPTORS,
        limit: 100,
      });

      if ('error' in res) {
        error = res.error;
        status = 'Unable to load calendar events.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;
      events = res.events.filter((event) => event.kind === EVENT_TIME || event.kind === EVENT_DATE);
      status = events.length ? `Loaded ${events.length} calendar event(s).` : 'No events found.';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to load calendar events.';
    } finally {
      loadingEvents = false;
    }
  }

  async function saveConfig() {
    if (!communityContext || !selectedEventRef) return;

    const next = {
      header: headerInput.trim() || DEFAULT_HEADER,
      eventRef: selectedEventRef,
    };

    config = next;
    writeLocalConfig(communityContext, next);
    status = 'Featured event configured locally.';

    try {
      await bridge?.request('ui:toast', {message: 'Featured event configured', type: 'success'});
    } catch {
      // Toast is best-effort.
    }
  }

  function applyCommunityContext(nextContext: CommunityWidgetContext | null) {
    communityContext = nextContext;
    calendarCapabilities = [];

    if (communityContext && !hasUrlConfig) {
      const localConfig = readLocalConfig(communityContext);
      if (localConfig) {
        config = localConfig;
        headerInput = localConfig.header;
        selectedEventRef = localConfig.eventRef;
      }
    }
  }

  $effect(() => {
    const b = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: '*',
      timeoutMs: 15000,
    });

    bridge = b;

    const offInit = b.onEvent('widget:init', (payload) => {
      initPayload = payload;
      applyCommunityContext(payload.communityContext ?? null);

      status = communityContext
        ? `Connected to community context ${getCommunityContextKey(communityContext)}.`
        : 'Waiting for BudaBit community context...';
      void refreshCalendarCapabilities(communityContext);
      void loadCalendarEvents(communityContext);
    });

    const offCommunityChanged = b.onEvent('community:contextChanged', (payload) => {
      applyCommunityContext(payload.communityContext ?? null);

      status = communityContext
        ? `Community context updated to ${getCommunityContextKey(communityContext)}.`
        : 'Waiting for BudaBit community context...';
      void refreshCalendarCapabilities(communityContext);
      void loadCalendarEvents(communityContext);
    });

    b.signalReady();

    return () => {
      offInit();
      offCommunityChanged();
      b.destroy();
      bridge = null;
    };
  });
</script>

<main>
  {#if !communityContext}
    <section class="panel muted">
      <strong>{DEFAULT_HEADER}</strong>
      <p>{status}</p>
    </section>
  {:else}
    {#if selectedEvent}
      <article class="event-card">
        <p class="eyebrow">{config.header || DEFAULT_HEADER}</p>
        <h1>{getEventTitle(selectedEvent)}</h1>
        <p class="date">{formatEventDate(selectedEvent)}</p>
        {#if tagValue(selectedEvent, 'location')}
          <p class="location">{tagValue(selectedEvent, 'location')}</p>
        {/if}
        {#if getEventSummary(selectedEvent)}
          <p class="summary">{getEventSummary(selectedEvent)}</p>
        {/if}
      </article>
    {:else if loadingEvents}
      <section class="panel muted">
        <strong>{config.header || DEFAULT_HEADER}</strong>
        <p>Loading calendar events...</p>
      </section>
    {:else if config.eventRef}
      <section class="panel warning">
        <strong>{config.header || DEFAULT_HEADER}</strong>
        <p>The configured event could not be found in this community.</p>
      </section>
    {:else if !canConfigure}
      <section class="panel muted">
        <strong>{DEFAULT_HEADER}</strong>
        <p>{NO_ACCESS_TEXT}</p>
      </section>
    {/if}

    {#if canConfigure}
      <section class="config-panel">
        <div class="config-heading">
          <div>
            <h2>Configure featured event</h2>
            <p>
              Calendar write access is available through
              {calendarSectionNames.join(', ') || 'the community calendar section'}.
            </p>
          </div>
          <button type="button" onclick={() => loadCalendarEvents()} disabled={loadingEvents}>
            {loadingEvents ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        <label>
          <span>Header</span>
          <input bind:value={headerInput} placeholder={DEFAULT_HEADER} />
        </label>

        <label>
          <span>Calendar event</span>
          <select bind:value={selectedEventRef}>
            <option value="">Select an event</option>
            {#each sortedEvents as event (event.id)}
              <option value={calendarEventAddress(event) || event.id}>
                {getEventTitle(event)} — {formatEventDate(event)}
              </option>
            {/each}
          </select>
        </label>

        <div class="button-row">
          <button type="button" onclick={saveConfig} disabled={!selectedEventRef}>Save local preview</button>
        </div>

        {#if configuredAppUrl}
          <label>
            <span>Configured app URL for Budabit publishing</span>
            <input readonly value={configuredAppUrl} />
          </label>
        {/if}

        {#if error}
          <p class="error">{error}</p>
        {:else}
          <p class="status">{status}</p>
        {/if}
      </section>
    {/if}
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: transparent;
    color: #171717;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  main {
    box-sizing: border-box;
    width: 100%;
    padding: 0;
  }

  .event-card,
  .panel,
  .config-panel {
    box-sizing: border-box;
    border: 1px solid rgba(120, 113, 108, 0.22);
    border-radius: 18px;
    background:
      linear-gradient(135deg, rgba(255, 247, 237, 0.96), rgba(255, 255, 255, 0.92)),
      radial-gradient(circle at top right, rgba(249, 115, 22, 0.18), transparent 40%);
    box-shadow: 0 12px 32px rgba(68, 64, 60, 0.12);
  }

  .event-card {
    padding: 20px;
  }

  .eyebrow {
    margin: 0 0 10px;
    color: #c2410c;
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: #1c1917;
    font-size: clamp(1.35rem, 4vw, 2rem);
    line-height: 1.05;
  }

  .date,
  .location {
    margin: 12px 0 0;
    color: #7c2d12;
    font-weight: 700;
  }

  .location {
    color: #57534e;
    font-weight: 600;
  }

  .summary {
    margin: 14px 0 0;
    color: #44403c;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .panel {
    padding: 18px;
  }

  .panel p {
    margin: 8px 0 0;
    color: #57534e;
  }

  .warning {
    border-color: rgba(202, 138, 4, 0.4);
  }

  .muted {
    background: rgba(255, 255, 255, 0.86);
  }

  .config-panel {
    margin-top: 12px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.94);
  }

  .config-heading,
  .button-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 1rem;
  }

  .config-heading p,
  .status,
  .error {
    margin: 6px 0 0;
    color: #78716c;
    font-size: 0.86rem;
    line-height: 1.35;
  }

  label {
    display: grid;
    gap: 6px;
    margin-top: 12px;
    color: #57534e;
    font-size: 0.84rem;
    font-weight: 700;
  }

  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    border: 1px solid rgba(120, 113, 108, 0.28);
    border-radius: 10px;
    background: #fff;
    color: #1c1917;
    font: inherit;
    font-weight: 500;
    padding: 10px 11px;
  }

  input[readonly] {
    color: #57534e;
    font-size: 0.78rem;
  }

  button {
    border: none;
    border-radius: 999px;
    background: #ea580c;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 0.84rem;
    font-weight: 800;
    padding: 9px 14px;
  }

  button:disabled {
    background: #d6d3d1;
    cursor: not-allowed;
  }

  .error {
    color: #b91c1c;
  }

  @media (max-width: 520px) {
    .event-card {
      padding: 16px;
    }

    .config-heading,
    .button-row {
      display: grid;
    }
  }
</style>
