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
  const DEFAULT_HEADER = 'Featured events';
  const NO_CONFIG_TEXT = 'No featured events have been configured for this community yet.';
  const SUMMARY_MAX_LENGTH = 200;

  type WidgetTheme = 'light' | 'dark';

  type WidgetConfig = {
    header: string;
    eventRefs: string[];
  };

  const tagValue = (event: Pick<NostrEvent, 'tags'>, name: string) =>
    event.tags.find((tag) => tag[0] === name)?.[1] || '';

  const normalizeEventRefs = (refs: unknown) =>
    Array.isArray(refs)
      ? Array.from(
          new Set(refs.map((ref) => (typeof ref === 'string' ? ref.trim() : '')).filter(Boolean))
        )
      : [];

  const readUrlConfig = (): WidgetConfig => {
    const params = new URLSearchParams(window.location.search);

    return {
      header: params.get('header')?.trim() || DEFAULT_HEADER,
      eventRefs: normalizeEventRefs(params.getAll('event')),
    };
  };

  const initialUrlConfig = readUrlConfig();
  const hasUrlConfig = Boolean(initialUrlConfig.eventRefs.length);

  let bridge = $state<WidgetBridge | null>(null);
  let initPayload = $state<WidgetInitPayload | null>(null);
  let communityContext = $state<CommunityWidgetContext | null>(null);
  let events = $state<NostrEvent[]>([]);
  let config = $state<WidgetConfig>(initialUrlConfig);
  let headerInput = $state(initialUrlConfig.header);
  let selectedEventRefs = $state<string[]>(initialUrlConfig.eventRefs);
  let status = $state('Waiting for BudaBit community context...');
  let error = $state('');
  let loadingConfig = $state(false);
  let loadingEvents = $state(false);
  let savingConfig = $state(false);
  let editing = $state(false);
  let calendarCapabilities = $state<CommunityWriteCapability[]>([]);
  let widgetTheme = $state<WidgetTheme>('light');
  let mainElement = $state<HTMLElement | null>(null);
  let configPanelElement = $state<HTMLElement | null>(null);
  let resizeFrame: number | undefined;
  let lastRequestedHeight = 0;

  const canConfigure = $derived(calendarCapabilities.some((capability) => capability.canModerate));

  const calendarEventAddress = (event: NostrEvent) => {
    const identifier = tagValue(event, 'd');

    return identifier ? `${event.kind}:${event.pubkey}:${identifier}` : '';
  };

  const getEventConfigRef = (event: NostrEvent) => calendarEventAddress(event) || event.id;

  const getEventRefs = (event: NostrEvent) =>
    [calendarEventAddress(event), tagValue(event, 'd'), event.id].filter(Boolean);

  const matchesEventRef = (event: NostrEvent, ref: string) =>
    Boolean(ref && getEventRefs(event).includes(ref));

  const sortedEvents = $derived.by(() =>
    [...events].sort((a, b) => (getEventStart(a) || 0) - (getEventStart(b) || 0))
  );

  const selectedEvents = $derived.by(() =>
    sortedEvents.filter((event) => config.eventRefs.some((ref) => matchesEventRef(event, ref)))
  );

  const normalizeWidgetConfig = (value: unknown): WidgetConfig | null => {
    if (!value || typeof value !== 'object') return null;

    const partial = value as Partial<WidgetConfig>;
    const eventRefs = normalizeEventRefs(partial.eventRefs);
    if (!eventRefs.length) return null;

    return {
      header: partial.header?.trim() || DEFAULT_HEADER,
      eventRefs,
    };
  };

  const applyConfig = (next: WidgetConfig) => {
    config = {header: next.header, eventRefs: [...next.eventRefs]};
    headerInput = next.header;
    selectedEventRefs = [...next.eventRefs];
  };

  const selectedEventCountText = $derived(
    `${selectedEventRefs.length} event${selectedEventRefs.length === 1 ? '' : 's'} selected`
  );

  const isEventSelected = (event: NostrEvent) => selectedEventRefs.includes(getEventConfigRef(event));

  function toggleSelectedEvent(event: NostrEvent) {
    const ref = getEventConfigRef(event);
    if (!ref) return;

    selectedEventRefs = selectedEventRefs.includes(ref)
      ? selectedEventRefs.filter((selectedRef) => selectedRef !== ref)
      : [...selectedEventRefs, ref];
  }

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

  const getContentHeight = () => {
    const mainHeight = mainElement
      ? Math.max(mainElement.scrollHeight, mainElement.getBoundingClientRect().height)
      : 0;

    return Math.ceil(
      Math.max(
        mainHeight,
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        1
      ) + 2
    );
  };

  const requestHostResize = () => {
    if (!bridge) return;

    const height = getContentHeight();
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - lastRequestedHeight) < 2) return;

    lastRequestedHeight = height;
    void bridge.request('ui:resize', {height}).catch(() => {
      // Older hosts may ignore resize; the widget still works with iframe scrolling.
    });
  };

  const scheduleHostResize = () => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);

    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        requestHostResize();
      });
    });
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
    status = 'Loading featured events configuration...';

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
        status = 'Unable to load featured events configuration.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;

      const sharedConfig = normalizeWidgetConfig(res.config);
      if (sharedConfig) {
        applyConfig(sharedConfig);
        status = 'Featured events configuration loaded.';
      } else if (hasUrlConfig) {
        applyConfig(initialUrlConfig);
        status = 'Using featured events from widget URL.';
      } else {
        applyConfig({header: DEFAULT_HEADER, eventRefs: []});
        status = 'No featured events configured yet.';
      }
    } catch (err) {
      if (!contextIsCurrent(expectedContext)) return;
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to load featured events configuration.';
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
    if (!communityContext || !selectedEventRefs.length || !canConfigure) return;

    const expectedContext = communityContext;

    const next = {
      header: headerInput.trim() || DEFAULT_HEADER,
      eventRefs: normalizeEventRefs(selectedEventRefs),
    };

    savingConfig = true;
    error = '';
    status = 'Saving featured events for this community...';
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
        error = res?.error || 'Unable to save featured events configuration.';
        status = 'Unable to save featured events configuration.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) return;

      applyConfig(next);
      editing = false;
      status = 'Featured events saved for this community.';
      saved = true;
    } catch (err) {
      if (!contextIsCurrent(expectedContext)) return;
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to save featured events configuration.';
    } finally {
      if (contextIsCurrent(expectedContext)) savingConfig = false;
    }

    if (saved) {
      try {
        await bridge?.request('ui:toast', {message: 'Featured events saved', type: 'success'});
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
      applyConfig(initialUrlConfig);
    };

    if (!communityContext || hasUrlConfig) {
      resetConfig();
    } else {
      applyConfig({header: DEFAULT_HEADER, eventRefs: []});
    }
  }

  $effect(() => {
    const element = mainElement;
    if (!bridge || !element) return;

    lastRequestedHeight = 0;
    scheduleHostResize();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(scheduleHostResize);
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = undefined;
    };
  });

  $effect(() => {
    let scrollHideTimer: ReturnType<typeof setTimeout> | undefined;
    const markScrolling = () => {
      document.documentElement.classList.add('is-scrolling');
      if (scrollHideTimer) clearTimeout(scrollHideTimer);
      scrollHideTimer = setTimeout(() => {
        document.documentElement.classList.remove('is-scrolling');
        scrollHideTimer = undefined;
      }, 900);
    };
    const scrollOptions: AddEventListenerOptions = {capture: true, passive: true};

    document.addEventListener('scroll', markScrolling, scrollOptions);
    window.addEventListener('wheel', markScrolling, {passive: true});
    window.addEventListener('touchmove', markScrolling, {passive: true});

    return () => {
      document.removeEventListener('scroll', markScrolling, scrollOptions);
      window.removeEventListener('wheel', markScrolling);
      window.removeEventListener('touchmove', markScrolling);
      if (scrollHideTimer) clearTimeout(scrollHideTimer);
      document.documentElement.classList.remove('is-scrolling');
    };
  });

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
      lastRequestedHeight = 0;

      status = communityContext
        ? `Connected to community context ${getCommunityContextKey(communityContext)}.`
        : 'Waiting for BudaBit community context...';
      void refreshCalendarCapabilities(communityContext);
      void loadSharedConfig(communityContext);
      void loadCalendarEvents(communityContext);
      scheduleHostResize();
    });

    const offCommunityChanged = b.onEvent('community:contextChanged', (payload) => {
      applyCommunityContext(payload.communityContext ?? null);
      lastRequestedHeight = 0;

      status = communityContext
        ? `Community context updated to ${getCommunityContextKey(communityContext)}.`
        : 'Waiting for BudaBit community context...';
      void refreshCalendarCapabilities(communityContext);
      void loadSharedConfig(communityContext);
      void loadCalendarEvents(communityContext);
      scheduleHostResize();
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

<main bind:this={mainElement}>
  {#if !communityContext}
    <section class="panel muted">
      <strong>{DEFAULT_HEADER}</strong>
      <p>{status}</p>
    </section>
  {:else}
    {#if selectedEvents.length}
      <section class="featured-events" aria-labelledby="featured-events-heading">
        <div class="event-heading">
          <p id="featured-events-heading" class="eyebrow">{config.header || DEFAULT_HEADER}</p>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Edit</button>
          {/if}
        </div>

        <div class="event-list">
          {#each selectedEvents as featuredEvent (featuredEvent.id)}
            {@const eventPath = getEventPath(featuredEvent)}
            {@const eventHref = getEventHref(featuredEvent)}
            <article class="event-card">
              <h1>
                {#if eventHref}
                  <a
                    class="event-title-link"
                    href={eventHref}
                    target="_top"
                    onclick={(event) => navigateToEvent(event, eventPath, eventHref)}>
                    {getEventTitle(featuredEvent)}
                  </a>
                {:else}
                  {getEventTitle(featuredEvent)}
                {/if}
              </h1>
              <p class="date">{formatEventDate(featuredEvent)}</p>
              {#if tagValue(featuredEvent, 'location')}
                <p class="location">{tagValue(featuredEvent, 'location')}</p>
              {/if}
              {#if getEventSummary(featuredEvent)}
                <p class="summary">{getVisibleEventSummary(featuredEvent)}</p>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {:else if loadingConfig || loadingEvents}
      <section class="panel muted">
        <strong>{config.header || DEFAULT_HEADER}</strong>
        <p>{loadingConfig ? 'Loading featured events configuration...' : 'Loading calendar events...'}</p>
      </section>
    {:else if config.eventRefs.length}
      <section class="panel warning">
        <div class="event-heading">
          <strong>{config.header || DEFAULT_HEADER}</strong>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Edit</button>
          {/if}
        </div>
        <p>The configured events could not be found in this community.</p>
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
            <h2>Configure featured events</h2>
          </div>
          <button type="button" onclick={() => loadCalendarEvents()} disabled={loadingEvents}>
            {loadingEvents ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        <label>
          <span>Header</span>
          <input bind:value={headerInput} placeholder={DEFAULT_HEADER} />
        </label>

        <div class="event-picker" role="group" aria-labelledby="event-picker-heading">
          <div class="picker-heading">
            <span id="event-picker-heading">Calendar events</span>
            <span class="selected-count">{selectedEventCountText}</span>
          </div>

          {#if sortedEvents.length}
            <div class="event-options">
              {#each sortedEvents as event (event.id)}
                <label class="event-option">
                  <input
                    type="checkbox"
                    checked={isEventSelected(event)}
                    onchange={() => toggleSelectedEvent(event)} />
                  <span>
                    <strong>{getEventTitle(event)}</strong>
                    <span>{formatEventDate(event)}</span>
                  </span>
                </label>
              {/each}
            </div>
          {:else}
            <p class="picker-empty">No calendar events found.</p>
          {/if}
        </div>

        <div class="button-row">
          <button type="button" onclick={saveConfig} disabled={!selectedEventRefs.length || savingConfig}>
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

  :global(html),
  :global(body),
  .event-options {
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
  }

  :global(html.is-scrolling),
  :global(html.is-scrolling body),
  :global(html:hover),
  :global(html:hover body),
  :global(body:hover),
  .event-options:hover,
  .event-options:focus-within {
    scrollbar-color: color-mix(in srgb, var(--text-soft) 48%, transparent) transparent;
  }

  :global(html::-webkit-scrollbar),
  :global(body::-webkit-scrollbar),
  .event-options::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  :global(html::-webkit-scrollbar-track),
  :global(body::-webkit-scrollbar-track),
  .event-options::-webkit-scrollbar-track {
    background: transparent;
  }

  :global(html::-webkit-scrollbar-thumb),
  :global(body::-webkit-scrollbar-thumb),
  .event-options::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background: transparent;
    background-clip: content-box;
  }

  :global(html.is-scrolling::-webkit-scrollbar-thumb),
  :global(html.is-scrolling body::-webkit-scrollbar-thumb),
  :global(html:hover::-webkit-scrollbar-thumb),
  :global(html:hover body::-webkit-scrollbar-thumb),
  :global(body:hover::-webkit-scrollbar-thumb),
  .event-options:hover::-webkit-scrollbar-thumb,
  .event-options:focus-within::-webkit-scrollbar-thumb {
    background-color: color-mix(in srgb, var(--text-soft) 48%, transparent);
  }

  :global(html::-webkit-scrollbar-button),
  :global(body::-webkit-scrollbar-button),
  .event-options::-webkit-scrollbar-button {
    display: none;
    width: 0;
    height: 0;
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

  .featured-events,
  .event-list {
    display: grid;
    gap: 12px;
  }

  .event-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
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

  label:not(.event-option) {
    display: grid;
    gap: 6px;
    margin-top: 12px;
    color: var(--text-muted);
    font-size: 0.84rem;
    font-weight: 700;
  }

  input:not([type='checkbox']) {
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

  input:not([type='checkbox']):focus {
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

  .event-picker {
    display: grid;
    gap: 8px;
    margin-top: 12px;
    color: var(--text-muted);
    font-size: 0.84rem;
    font-weight: 700;
  }

  .picker-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .selected-count {
    color: var(--text-soft);
    white-space: nowrap;
  }

  .event-options {
    display: grid;
    gap: 8px;
    max-height: min(52vh, 360px);
    overflow: auto;
    overscroll-behavior: contain;
    padding: 2px;
  }

  .event-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: flex-start;
    gap: 10px;
    box-sizing: border-box;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel-muted);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.84rem;
    font-weight: 500;
    padding: 10px;
  }

  .event-option:has(input:checked) {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
  }

  .event-option input {
    width: 18px;
    height: 18px;
    margin: 2px 0 0;
    accent-color: var(--accent);
  }

  .event-option > span {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .event-option strong {
    color: var(--text-strong);
    font-size: 0.9rem;
    line-height: 1.25;
  }

  .event-option span span {
    color: var(--accent-muted);
    font-weight: 700;
    line-height: 1.3;
  }

  .picker-empty {
    margin: 0;
    color: var(--text-muted);
    font-weight: 500;
  }

  .error {
    color: #b91c1c;
  }

  @media (max-width: 520px) {
    .event-card {
      padding: 16px;
    }

    h1 {
      font-size: clamp(1.18rem, 7vw, 1.5rem);
    }

    .config-heading,
    .button-row {
      display: grid;
    }

    .config-heading button,
    .button-row button {
      width: 100%;
    }

    .picker-heading {
      display: grid;
      gap: 4px;
    }

    .selected-count {
      white-space: normal;
    }

    .event-options {
      max-height: 46vh;
    }

    .event-option {
      padding: 11px;
    }
  }
</style>
