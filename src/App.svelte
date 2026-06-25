<script lang="ts">
  import {tick} from 'svelte';
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
  const CONFIG_NAMESPACE = 'budabit-calendar-widget';
  const CONFIG_KEY = 'featured-calendar-event';
  const DEFAULT_HEADER = 'Featured event';
  const NO_CONFIG_TEXT = 'No featured event has been configured for this community yet.';
  const SUMMARY_MAX_LENGTH = 200;

  type WidgetTheme = 'light' | 'dark';

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
  let loadingConfig = $state(false);
  let loadingEvents = $state(false);
  let savingConfig = $state(false);
  let editing = $state(false);
  let calendarCapabilities = $state<CommunityWriteCapability[]>([]);
  let widgetTheme = $state<WidgetTheme>('light');
  let configPanelElement = $state<HTMLElement | null>(null);

  const canConfigure = $derived(calendarCapabilities.some((capability) => capability.canModerate));

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

  const normalizeWidgetConfig = (value: unknown): WidgetConfig | null => {
    if (!value || typeof value !== 'object') return null;

    const partial = value as Partial<WidgetConfig>;
    const eventRef = partial.eventRef?.trim();
    if (!eventRef) return null;

    return {
      header: partial.header?.trim() || DEFAULT_HEADER,
      eventRef,
    };
  };

  const applyConfig = (next: WidgetConfig) => {
    config = next;
    headerInput = next.header;
    selectedEventRef = next.eventRef;
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

  const truncateText = (value: string, maxLength: number) =>
    value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;

  const getVisibleEventSummary = (event: NostrEvent) =>
    truncateText(getEventSummary(event), SUMMARY_MAX_LENGTH);

  const getEventRouteId = (event: NostrEvent) => tagValue(event, 'd') || event.id;

  const getAppOrigin = () =>
    typeof initPayload?.appOrigin === 'string' ? initPayload.appOrigin.replace(/\/+$/, '') : '';

  const getEventPath = (event: NostrEvent) => {
    const communityRoute = communityContext?.ncommunity || communityContext?.pubkey;
    const routeId = getEventRouteId(event);

    if (!communityRoute || !routeId) return '';

    return `/c/${encodeURIComponent(communityRoute)}/calendar/${encodeURIComponent(routeId)}`;
  };

  const getEventHref = (event: NostrEvent) => {
    const appOrigin = getAppOrigin();
    const path = getEventPath(event);

    if (!appOrigin || !path) return '';

    return `${appOrigin}${path}`;
  };

  const selectedEventPath = $derived(selectedEvent ? getEventPath(selectedEvent) : '');
  const selectedEventHref = $derived(selectedEvent ? getEventHref(selectedEvent) : '');

  async function navigateToEvent(event: MouseEvent, path: string, href: string) {
    if (!bridge || !path) return;

    event.preventDefault();
    try {
      const res = await bridge.request('ui:navigate', {path});
      if ('error' in res) throw new Error(res.error);
    } catch {
      if (href) window.open(href, '_top');
    }
  }

  const getCommunityContextKey = (ctx: CommunityWidgetContext | null) =>
    ctx ? `${ctx.contextSessionId}:${ctx.contextVersion}` : '';

  const responseMatchesContext = (
    response: {contextSessionId?: string; contextVersion?: number},
    expectedContext: CommunityWidgetContext
  ) =>
    response.contextSessionId === expectedContext.contextSessionId &&
    response.contextVersion === expectedContext.contextVersion;

  const contextIsCurrent = (expectedContext: CommunityWidgetContext) =>
    getCommunityContextKey(communityContext) === getCommunityContextKey(expectedContext);

  const normalizeTheme = (value: unknown): WidgetTheme => (value === 'dark' ? 'dark' : 'light');

  const applyTheme = (theme: unknown, themeBackground?: unknown) => {
    widgetTheme = normalizeTheme(theme);
    document.documentElement.dataset.theme = widgetTheme;
    document.body.dataset.theme = widgetTheme;

    if (typeof themeBackground === 'string' && themeBackground.trim()) {
      document.documentElement.style.setProperty('--host-background', themeBackground.trim());
    } else {
      document.documentElement.style.removeProperty('--host-background');
    }
  };

  async function startEditing() {
    editing = true;
    await tick();
    configPanelElement?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  async function refreshCalendarCapabilities(ctx = communityContext) {
    if (!bridge || !ctx) return;

    const expectedContext = ctx;
    try {
      const res = await bridge.request('community:checkWriteCapabilities', {
        descriptors: CALENDAR_DESCRIPTORS,
      });

      if (!contextIsCurrent(expectedContext)) return;

      if ('error' in res) {
        error = res.error;
        status = 'Unable to check calendar configuration access.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;
      calendarCapabilities = res.capabilities;
    } catch (err) {
      if (!contextIsCurrent(expectedContext)) return;
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to check calendar configuration access.';
    }
  }

  async function loadSharedConfig(ctx = communityContext) {
    if (!bridge || !ctx) return;

    const expectedContext = ctx;
    loadingConfig = true;
    error = '';
    status = 'Loading featured event configuration...';

    try {
      const res = await bridge.request('community:querySharedConfig', {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        descriptors: CALENDAR_DESCRIPTORS,
        limit: 100,
      });

      if (!contextIsCurrent(expectedContext)) return;

      if ('error' in res) {
        error = res.error;
        status = 'Unable to load featured event configuration.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;

      const sharedConfig = normalizeWidgetConfig(res.config);
      if (sharedConfig) {
        applyConfig(sharedConfig);
        status = 'Featured event configuration loaded.';
      } else if (hasUrlConfig) {
        applyConfig(initialUrlConfig);
        status = 'Using featured event from widget URL.';
      } else {
        applyConfig({header: DEFAULT_HEADER, eventRef: ''});
        status = 'No featured event configured yet.';
      }
    } catch (err) {
      if (!contextIsCurrent(expectedContext)) return;
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to load featured event configuration.';
    } finally {
      if (contextIsCurrent(expectedContext)) loadingConfig = false;
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
        limit: 500,
      });

      if (!contextIsCurrent(expectedContext)) return;

      if ('error' in res) {
        error = res.error;
        status = 'Unable to load calendar events.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;
      events = res.events.filter((event) => event.kind === EVENT_TIME || event.kind === EVENT_DATE);
      status = events.length ? '' : 'No events found.';
    } catch (err) {
      if (!contextIsCurrent(expectedContext)) return;
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to load calendar events.';
    } finally {
      if (contextIsCurrent(expectedContext)) loadingEvents = false;
    }
  }

  async function saveConfig() {
    if (!communityContext || !selectedEventRef || !canConfigure) return;

    const expectedContext = communityContext;

    const next = {
      header: headerInput.trim() || DEFAULT_HEADER,
      eventRef: selectedEventRef,
    };

    savingConfig = true;
    error = '';
    status = 'Saving featured event for this community...';
    let saved = false;

    try {
      const res = await bridge?.request('community:publishSharedConfig', {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        descriptors: CALENDAR_DESCRIPTORS,
        config: next,
      });

      if (!contextIsCurrent(expectedContext)) return;

      if (!res || 'error' in res) {
        error = res?.error || 'Unable to save featured event configuration.';
        status = 'Unable to save featured event configuration.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;

      applyConfig(next);
      editing = false;
      status = 'Featured event saved for this community.';
      saved = true;
    } catch (err) {
      if (!contextIsCurrent(expectedContext)) return;
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to save featured event configuration.';
    } finally {
      if (contextIsCurrent(expectedContext)) savingConfig = false;
    }

    if (saved) {
      try {
        await bridge?.request('ui:toast', {message: 'Featured event saved', type: 'success'});
      } catch {
        // Toast is best-effort.
      }
    }
  }

  function applyCommunityContext(nextContext: CommunityWidgetContext | null) {
    communityContext = nextContext;
    calendarCapabilities = [];
    events = [];
    error = '';
    loadingConfig = false;
    loadingEvents = false;
    savingConfig = false;
    editing = false;

    const resetConfig = () => {
      config = initialUrlConfig;
      headerInput = initialUrlConfig.header;
      selectedEventRef = initialUrlConfig.eventRef;
    };

    if (!communityContext || hasUrlConfig) {
      resetConfig();
    } else {
      applyConfig({header: DEFAULT_HEADER, eventRef: ''});
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
      applyTheme(payload.theme, payload.themeBackground);
      applyCommunityContext(payload.communityContext ?? null);

      status = communityContext
        ? `Connected to community context ${getCommunityContextKey(communityContext)}.`
        : 'Waiting for BudaBit community context...';
      void refreshCalendarCapabilities(communityContext);
      void loadSharedConfig(communityContext);
      void loadCalendarEvents(communityContext);
    });

    const offCommunityChanged = b.onEvent('community:contextChanged', (payload) => {
      applyCommunityContext(payload.communityContext ?? null);

      status = communityContext
        ? `Community context updated to ${getCommunityContextKey(communityContext)}.`
        : 'Waiting for BudaBit community context...';
      void refreshCalendarCapabilities(communityContext);
      void loadSharedConfig(communityContext);
      void loadCalendarEvents(communityContext);
    });

    const offThemeChanged = b.onEvent('widget:themeChanged', (payload) => {
      applyTheme(payload.theme, payload.themeBackground);
    });

    b.signalReady();

    return () => {
      offInit();
      offCommunityChanged();
      offThemeChanged();
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
        <div class="event-heading">
          <p class="eyebrow">{config.header || DEFAULT_HEADER}</p>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Edit</button>
          {/if}
        </div>
        <h1>
          {#if selectedEventHref}
            <a
              class="event-title-link"
              href={selectedEventHref}
              target="_top"
              onclick={(event) => navigateToEvent(event, selectedEventPath, selectedEventHref)}>
              {getEventTitle(selectedEvent)}
            </a>
          {:else}
            {getEventTitle(selectedEvent)}
          {/if}
        </h1>
        <p class="date">{formatEventDate(selectedEvent)}</p>
        {#if tagValue(selectedEvent, 'location')}
          <p class="location">{tagValue(selectedEvent, 'location')}</p>
        {/if}
        {#if getEventSummary(selectedEvent)}
          <p class="summary">{getVisibleEventSummary(selectedEvent)}</p>
        {/if}
      </article>
    {:else if loadingConfig || loadingEvents}
      <section class="panel muted">
        <strong>{config.header || DEFAULT_HEADER}</strong>
        <p>{loadingConfig ? 'Loading featured event configuration...' : 'Loading calendar events...'}</p>
      </section>
    {:else if config.eventRef}
      <section class="panel warning">
        <div class="event-heading">
          <strong>{config.header || DEFAULT_HEADER}</strong>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Edit</button>
          {/if}
        </div>
        <p>The configured event could not be found in this community.</p>
      </section>
    {:else}
      <section class="panel muted">
        <div class="event-heading">
          <strong>{DEFAULT_HEADER}</strong>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Configure</button>
          {/if}
        </div>
        <p>{NO_CONFIG_TEXT}</p>
      </section>
    {/if}

    {#if canConfigure && editing}
      <section class="config-panel" bind:this={configPanelElement}>
        <div class="config-heading">
          <div>
            <h2>Configure featured event</h2>
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
          <button type="button" onclick={saveConfig} disabled={!selectedEventRef || savingConfig}>
            {savingConfig ? 'Saving...' : 'Save for community'}
          </button>
          <button type="button" class="secondary" onclick={() => (editing = false)} disabled={savingConfig}>
            Cancel
          </button>
        </div>

        {#if error}
          <p class="error">{error}</p>
        {/if}
      </section>
    {/if}
  {/if}
</main>

<style>
  :global(html) {
    margin: 0;
    --host-background: transparent;
    background: var(--host-background);
  }

  :global(html[data-theme='light']) {
    --host-background: #f5f5f4;
  }

  :global(html[data-theme='dark']) {
    --host-background: #151c23;
  }

  :global(body) {
    margin: 0;
    background: var(--host-background);
    color: var(--text);
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --accent: #ea580c;
    --accent-strong: #c2410c;
    --accent-muted: #7c2d12;
    --border: rgba(120, 113, 108, 0.22);
    --border-strong: rgba(120, 113, 108, 0.34);
    --panel: rgba(255, 255, 255, 0.94);
    --panel-muted: rgba(255, 255, 255, 0.86);
    --text: #171717;
    --text-strong: #1c1917;
    --text-muted: #57534e;
    --text-soft: #78716c;
    --shadow: 0 12px 32px rgba(68, 64, 60, 0.12);
    --surface-gradient:
      linear-gradient(135deg, rgba(255, 247, 237, 0.96), rgba(255, 255, 255, 0.92)),
      radial-gradient(circle at top right, rgba(249, 115, 22, 0.18), transparent 40%);
  }

  :global(body[data-theme='dark']) {
    --accent: #fb923c;
    --accent-strong: #fdba74;
    --accent-muted: #fed7aa;
    --border: rgba(251, 146, 60, 0.28);
    --border-strong: rgba(251, 146, 60, 0.44);
    --panel: rgba(28, 25, 23, 0.94);
    --panel-muted: rgba(28, 25, 23, 0.86);
    --text: #f5f5f4;
    --text-strong: #fff7ed;
    --text-muted: #d6d3d1;
    --text-soft: #a8a29e;
    --shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
    --surface-gradient:
      linear-gradient(135deg, rgba(41, 37, 36, 0.96), rgba(28, 25, 23, 0.94)),
      radial-gradient(circle at top right, rgba(249, 115, 22, 0.2), transparent 42%);
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
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface-gradient);
    box-shadow: var(--shadow);
  }

  .event-card {
    padding: 20px;
  }

  .event-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .eyebrow {
    margin: 0 0 10px;
    color: var(--accent-strong);
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: var(--text-strong);
    font-size: clamp(1.35rem, 4vw, 2rem);
    line-height: 1.05;
  }

  .event-title-link {
    color: inherit;
    text-decoration: none;
  }

  .event-title-link:hover,
  .event-title-link:focus-visible {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 0.14em;
  }

  .date,
  .location {
    margin: 12px 0 0;
    color: var(--accent-muted);
    font-weight: 700;
  }

  .location {
    color: var(--text-muted);
    font-weight: 600;
  }

  .summary {
    margin: 14px 0 0;
    color: var(--text-muted);
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .panel {
    padding: 18px;
  }

  .panel p {
    margin: 8px 0 0;
    color: var(--text-muted);
  }

  .warning {
    border-color: rgba(202, 138, 4, 0.4);
  }

  .muted {
    background: var(--panel-muted);
  }

  .config-panel {
    margin-top: 12px;
    padding: 16px;
    background: var(--panel);
  }

  .config-heading,
  .button-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .button-row {
    margin-top: 16px;
  }

  h2 {
    margin: 0;
    color: var(--text-strong);
    font-size: 1rem;
  }

  .error {
    margin: 6px 0 0;
    color: var(--text-soft);
    font-size: 0.86rem;
    line-height: 1.35;
  }

  label {
    display: grid;
    gap: 6px;
    margin-top: 12px;
    color: var(--text-muted);
    font-size: 0.84rem;
    font-weight: 700;
  }

  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--panel-muted);
    color: var(--text-strong);
    font: inherit;
    font-weight: 500;
    padding: 10px 11px;
  }

  input:focus,
  select:focus {
    border-color: var(--accent);
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 24%, transparent);
  }

  button {
    border: none;
    border-radius: 999px;
    background: var(--accent);
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

  button.secondary {
    border: 1px solid var(--border-strong);
    background: var(--panel-muted);
    color: var(--accent-muted);
  }

  button.small {
    padding: 6px 10px;
    font-size: 0.76rem;
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
