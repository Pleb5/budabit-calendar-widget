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
  import {
    DEFAULT_HEADER,
    EVENT_DATE,
    EVENT_TIME,
    advanceRequestEpoch,
    beginRequest,
    canonicalizeEventRefs,
    collapseCalendarEventReplacements,
    completeRequest,
    createRequestState,
    eventTagValue,
    failRequest,
    formatCalendarEventDate,
    getCalendarEventRouteId,
    getEventConfigRef,
    getHostCapabilityCatalog,
    getHostCapabilityPolicy,
    getLocalCalendarDate,
    hostCanAttempt,
    isBlockingRequestError,
    isConfigRevisionConflict,
    isUnsupportedCapabilityError,
    matchesEventRef,
    mergeCalendarEditorEvents,
    mergeCalendarEventsForRefs,
    normalizeEventRefs,
    normalizeWidgetConfig,
    parseCalendarTimestamp,
    planEventQueries,
    requestEpochIsCurrent,
    resolveSharedWidgetConfig,
    getSharedConfigRevision,
    retainRequestValue,
    selectCalendarPickerEvents,
    unavailableRequest,
    type HostCapabilityAction,
    type RequestState,
    type WidgetConfig,
  } from './lib/compatibility';
  import {createBoundedPoll} from './lib/boundedPoll';

  const CALENDAR_DESCRIPTORS: CommunityEventDescriptor[] = [{kind: EVENT_TIME}, {kind: EVENT_DATE}];
  const CONFIG_NAMESPACE = 'budabit-calendar-widget';
  const CONFIG_KEY = 'featured-calendar-event';
  const NO_CONFIG_TEXT = 'No featured events have been configured for this community yet.';
  const SUMMARY_MAX_LENGTH = 200;
  const MAX_PICKER_EVENTS = 120;
  const BROAD_PAGE_SIZE = 500;
  const MAX_BROAD_PAGES = 3;
  const POST_INIT_REFRESH_DELAYS_MS = [1500, 3000, 5000, 8000, 12000] as const;
  const RESUME_REFRESH_DEBOUNCE_MS = 300;
  const BRIDGE_TIMEOUT_MS = 60_000;

  type WidgetTheme = 'light' | 'dark';

  type LoadCalendarEventsOptions = {
    refs?: string[];
    broad?: boolean;
    attempt?: number;
    runId?: number;
    background?: boolean;
  };

  type LoadRequestOptions = {
    attempt?: number;
    runId?: number;
    background?: boolean;
  };

  type PendingEventsLoad = Pick<LoadCalendarEventsOptions, 'refs' | 'broad' | 'background'>;

  const tagValue = eventTagValue;

  const readUrlConfig = (): WidgetConfig => {
    const params = new URLSearchParams(window.location.search);

    return {
      header: params.get('header')?.trim() || DEFAULT_HEADER,
      eventRefs: normalizeEventRefs([...params.getAll('event'), ...params.getAll('eventRef')]),
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
  let configRequest = $state<RequestState>(createRequestState());
  let eventsRequest = $state<RequestState>(createRequestState());
  let capabilitiesRequest = $state<RequestState>(createRequestState());
  let savingConfig = $state(false);
  let editing = $state(false);
  let configRevision = $state<string | null>(null);
  let editingBaseRevision = $state<string | null>(null);
  let calendarCapabilities = $state<CommunityWriteCapability[]>([]);
  let hostCapabilityCatalog = $state<string[] | null>(null);
  let runtimeUnsupportedActions = $state<HostCapabilityAction[]>([]);
  let widgetTheme = $state<WidgetTheme>('light');
  let mainElement = $state<HTMLElement | null>(null);
  let configPanelElement = $state<HTMLElement | null>(null);
  let resizeFrame: number | undefined;
  let lastRequestedHeight = 0;
  let contextGeneration = 0;
  let configRunId = 0;
  let eventsRunId = 0;
  let capabilitiesRunId = 0;
  let configRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let eventsRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let capabilitiesRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingConfigRefresh = false;
  let pendingCapabilitiesRefresh = false;
  let pendingEventsLoad: PendingEventsLoad | null = null;
  let currentEventsLoadKey = '';
  const postInitRefreshPoll = createBoundedPoll(POST_INIT_REFRESH_DELAYS_MS);

  const hostCapabilityPolicy = $derived(
    getHostCapabilityPolicy(hostCapabilityCatalog, runtimeUnsupportedActions)
  );
  const queryEventsSupported = $derived(
    hostCanAttempt(hostCapabilityPolicy['community:queryEvents'])
  );
  const querySharedConfigSupported = $derived(
    hostCanAttempt(hostCapabilityPolicy['community:querySharedConfig'])
  );
  const publishSharedConfigSupported = $derived(
    hostCanAttempt(hostCapabilityPolicy['community:publishSharedConfig'])
  );
  const checkCapabilitiesSupported = $derived(
    hostCanAttempt(hostCapabilityPolicy['community:checkWriteCapabilities'])
  );
  const loadingEvents = $derived(
    eventsRequest.phase === 'loading' || eventsRequest.phase === 'retrying'
  );

  const clearLoadRetries = () => {
    if (configRetryTimer) clearTimeout(configRetryTimer);
    if (eventsRetryTimer) clearTimeout(eventsRetryTimer);
    if (capabilitiesRetryTimer) clearTimeout(capabilitiesRetryTimer);
    configRetryTimer = undefined;
    eventsRetryTimer = undefined;
    capabilitiesRetryTimer = undefined;
  };

  const clearRefreshTimers = () => {
    postInitRefreshPoll.stop();
    if (resumeRefreshTimer) clearTimeout(resumeRefreshTimer);
    resumeRefreshTimer = undefined;
  };

  const canConfigure = $derived(
    queryEventsSupported &&
      querySharedConfigSupported &&
      publishSharedConfigSupported &&
      checkCapabilitiesSupported &&
      calendarCapabilities.some((capability) => capability.canModerate)
  );

  const compatibilityMessage = $derived.by(() => {
    if (!queryEventsSupported) {
      return 'This BudaBit host does not support the community event query required by this widget.';
    }
    if (!querySharedConfigSupported) {
      return 'Shared community configuration is unavailable on this host. URL or legacy local configuration is read-only.';
    }
    if (!checkCapabilitiesSupported || !publishSharedConfigSupported) {
      return 'Shared configuration editing is disabled because this host does not support the required moderator check and publish actions.';
    }
    return '';
  });

  const requestErrorText = $derived.by(() => {
    const failures = [
      ['configuration', configRequest],
      ['calendar events', eventsRequest],
      ['moderator access', capabilitiesRequest],
    ] as const;
    return failures
      .filter(([, request]) => request.phase === 'error')
      .map(([label, request]) => `${label}: ${request.error}`)
      .join(' ');
  });

  const hasRequestError = $derived(Boolean(requestErrorText));
  const blockingLoadError = $derived(
    isBlockingRequestError(configRequest) ||
      isBlockingRequestError(eventsRequest, config.eventRefs.length > 0)
  );
  const waitingForInitialData = $derived(
    (!configRequest.hasValue &&
      (configRequest.phase === 'idle' ||
        configRequest.phase === 'loading' ||
        configRequest.phase === 'retrying')) ||
      (configRequest.hasValue &&
        config.eventRefs.length > 0 &&
        !eventsRequest.hasValue &&
        (eventsRequest.phase === 'idle' ||
          eventsRequest.phase === 'loading' ||
          eventsRequest.phase === 'retrying'))
  );

  const sortedEvents = $derived.by(() =>
    [...events].sort((a, b) => (getEventStart(a) || 0) - (getEventStart(b) || 0))
  );

  const selectedEvents = $derived.by(() =>
    sortedEvents.filter((event) => config.eventRefs.some((ref) => matchesEventRef(event, ref)))
  );

  const getFallbackConfig = () => {
    if (hasUrlConfig) {
      return {
        config: initialUrlConfig,
        status: 'Using featured events from widget URL.',
      };
    }
    return {
      config: {header: DEFAULT_HEADER, eventRefs: []},
      status: 'No featured events configured yet.',
    };
  };

  const applyConfig = (next: WidgetConfig, preserveDraft = false) => {
    config = {header: next.header, eventRefs: [...next.eventRefs]};
    if (!preserveDraft) {
      headerInput = next.header;
      selectedEventRefs = [...next.eventRefs];
    }
  };

  const selectedEventCountText = $derived(
    `${selectedEventRefs.length} event${selectedEventRefs.length === 1 ? '' : 's'} selected`
  );

  const unresolvedSelectedEventRefs = $derived.by(() =>
    selectedEventRefs.filter((ref) => !sortedEvents.some((event) => matchesEventRef(event, ref)))
  );

  const isEventSelected = (event: NostrEvent) =>
    selectedEventRefs.some((ref) => matchesEventRef(event, ref));

  function toggleSelectedEvent(event: NostrEvent) {
    const ref = getEventConfigRef(event);
    if (!ref) return;

    const selected = selectedEventRefs.some((selectedRef) => matchesEventRef(event, selectedRef));

    selectedEventRefs = selected
      ? selectedEventRefs.filter((selectedRef) => !matchesEventRef(event, selectedRef))
      : [...selectedEventRefs, ref];
  }

  function removeSelectedEventRef(ref: string) {
    selectedEventRefs = selectedEventRefs.filter((selectedRef) => selectedRef !== ref);
  }

  function getEventStart(event: NostrEvent) {
    return parseCalendarTimestamp(tagValue(event, 'start'));
  }

  const formatEventDate = formatCalendarEventDate;

  const getEventTitle = (event: NostrEvent) =>
    tagValue(event, 'title') || tagValue(event, 'name') || 'Untitled event';

  const getEventSummary = (event: NostrEvent) => event.content.trim();

  const pickerEvents = $derived(
    selectCalendarPickerEvents(
      events,
      selectedEventRefs,
      Math.floor(Date.now() / 1000),
      MAX_PICKER_EVENTS
    )
  );

  const truncateText = (value: string, maxLength: number) =>
    value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;

  const getVisibleEventSummary = (event: NostrEvent) =>
    truncateText(getEventSummary(event), SUMMARY_MAX_LENGTH);

  const getEventRouteId = getCalendarEventRouteId;

  const getAppOrigin = () =>
    typeof initPayload?.appOrigin === 'string' ? initPayload.appOrigin.replace(/\/+$/, '') : '';

  const getEventPath = (event: NostrEvent) => {
    const publicContext = initPayload?.context as {community?: {naddr?: string}} | undefined;
    const legacyContext = communityContext as
      | (CommunityWidgetContext & {ncommunity?: string; pubkey?: string})
      | null;
    const communityRoute =
      communityContext?.naddr ||
      publicContext?.community?.naddr ||
      legacyContext?.ncommunity ||
      legacyContext?.pubkey;
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

  const contextIsCurrent = (
    expectedContext: CommunityWidgetContext,
    generation = contextGeneration
  ) =>
    generation === contextGeneration &&
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
    if (!mainElement) return 1;

    return Math.ceil(
      Math.max(mainElement.scrollHeight, mainElement.getBoundingClientRect().height, 1) + 2
    );
  };

  const requestHostResize = () => {
    if (!bridge) return;

    const height = getContentHeight();
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - lastRequestedHeight) < 2)
      return;

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
    if (editing) {
      await cancelEditing();
      return;
    }

    editingBaseRevision = configRevision;
    editing = true;
    void loadCalendarEvents(communityContext, {
      refs: selectedEventRefs,
      broad: true,
      background: true,
    });
    await tick();
    configPanelElement?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  async function cancelEditing(event?: Event) {
    event?.preventDefault();
    if (savingConfig || !editing) return;

    headerInput = config.header;
    selectedEventRefs = [...config.eventRefs];
    editing = false;
    editingBaseRevision = null;
    void loadCalendarEvents(communityContext, {
      refs: config.eventRefs,
      broad: false,
      background: true,
    });
    await tick();
    scheduleHostResize();
  }

  const isRequestBusy = (request: RequestState) =>
    request.phase === 'loading' || request.phase === 'retrying';

  const staleResponseError = {
    error: 'The host returned data for an older community context.',
    code: 'COMMUNITY_CONTEXT_NOT_READY',
  };

  const markRuntimeUnsupported = (action: HostCapabilityAction) => {
    if (!runtimeUnsupportedActions.includes(action)) {
      runtimeUnsupportedActions = [...runtimeUnsupportedActions, action];
    }
  };

  const filterCalendarEvents = (value: unknown) =>
    collapseCalendarEventReplacements(Array.isArray(value) ? (value as NostrEvent[]) : []);

  const handleCapabilitiesFailure = (
    value: unknown,
    ctx: CommunityWidgetContext,
    generation: number,
    runId: number,
    attempt: number
  ) => {
    if (isUnsupportedCapabilityError(value)) {
      markRuntimeUnsupported('community:checkWriteCapabilities');
      pendingCapabilitiesRefresh = false;
      capabilitiesRequest = unavailableRequest(
        capabilitiesRequest,
        'This host does not support community moderator capability checks.'
      );
      status = 'Calendar configuration access is unavailable on this host.';
      return;
    }

    const failure = failRequest(capabilitiesRequest, value);
    capabilitiesRequest = failure.state;
    if (failure.retryDelayMs !== null) {
      status = 'Waiting for community moderator access to become ready...';
      capabilitiesRetryTimer = setTimeout(() => {
        capabilitiesRetryTimer = undefined;
        if (contextIsCurrent(ctx, generation) && runId === capabilitiesRunId) {
          void refreshCalendarCapabilities(ctx, {
            attempt: attempt + 1,
            runId,
            background: true,
          });
        }
      }, failure.retryDelayMs);
    } else {
      pendingCapabilitiesRefresh = false;
      status = 'Unable to check calendar configuration access.';
    }
  };

  async function refreshCalendarCapabilities(
    ctx = communityContext,
    options: LoadRequestOptions = {}
  ) {
    if (!bridge || !ctx) return;
    if (!checkCapabilitiesSupported) {
      capabilitiesRequest = unavailableRequest(
        capabilitiesRequest,
        'This host does not support community moderator capability checks.'
      );
      return;
    }

    const retryingRun = options.runId !== undefined;
    if (isRequestBusy(capabilitiesRequest) && !retryingRun) {
      if (capabilitiesRequest.phase === 'loading') pendingCapabilitiesRefresh = true;
      return;
    }

    const expectedContext = ctx;
    const generation = contextGeneration;
    const runId = options.runId ?? ++capabilitiesRunId;
    const attempt = options.attempt ?? 1;
    if (runId !== capabilitiesRunId || !contextIsCurrent(expectedContext, generation)) return;
    if (capabilitiesRetryTimer) clearTimeout(capabilitiesRetryTimer);
    capabilitiesRetryTimer = undefined;
    capabilitiesRequest = beginRequest(capabilitiesRequest, attempt);
    if (!options.background && !capabilitiesRequest.hasValue) {
      status = 'Checking calendar configuration access...';
    }

    const requestBridge = bridge;
    try {
      const res = await requestBridge.request('community:checkWriteCapabilities', {
        descriptors: CALENDAR_DESCRIPTORS,
      });
      if (!contextIsCurrent(expectedContext, generation) || runId !== capabilitiesRunId) {
        return;
      }
      if ('error' in res) {
        handleCapabilitiesFailure(res, expectedContext, generation, runId, attempt);
        return;
      }
      if (!responseMatchesContext(res, expectedContext)) {
        handleCapabilitiesFailure(staleResponseError, expectedContext, generation, runId, attempt);
        return;
      }

      calendarCapabilities = Array.isArray(res.capabilities) ? res.capabilities : [];
      capabilitiesRequest = completeRequest(capabilitiesRequest);
    } catch (err) {
      if (contextIsCurrent(expectedContext, generation) && runId === capabilitiesRunId) {
        handleCapabilitiesFailure(err, expectedContext, generation, runId, attempt);
      }
    } finally {
      if (
        contextIsCurrent(expectedContext, generation) &&
        runId === capabilitiesRunId &&
        capabilitiesRequest.phase === 'success' &&
        pendingCapabilitiesRefresh
      ) {
        pendingCapabilitiesRefresh = false;
        queueMicrotask(
          () =>
            void refreshCalendarCapabilities(expectedContext, {
              background: true,
            })
        );
      }
    }
  }

  const handleConfigFailure = (
    value: unknown,
    ctx: CommunityWidgetContext,
    generation: number,
    runId: number,
    attempt: number
  ) => {
    if (isUnsupportedCapabilityError(value)) {
      markRuntimeUnsupported('community:querySharedConfig');
      pendingConfigRefresh = false;
      editing = false;
      editingBaseRevision = null;
      applyFallbackConfiguration(ctx, true);
      return;
    }

    const failure = failRequest(configRequest, value);
    configRequest = failure.state;
    if (failure.retryDelayMs !== null) {
      status = 'Waiting for featured events configuration to become ready...';
      configRetryTimer = setTimeout(() => {
        configRetryTimer = undefined;
        if (contextIsCurrent(ctx, generation) && requestEpochIsCurrent(runId, configRunId)) {
          void loadSharedConfig(ctx, {
            attempt: attempt + 1,
            runId,
            background: true,
          });
        }
      }, failure.retryDelayMs);
    } else {
      pendingConfigRefresh = false;
      status = 'Unable to load featured events configuration.';
    }
  };

  const loadEventsForConfig = (
    ctx: CommunityWidgetContext,
    nextConfig: WidgetConfig,
    background = false
  ) => {
    if (editing) return;
    void loadCalendarEvents(ctx, {
      refs: nextConfig.eventRefs,
      broad: false,
      background,
    });
  };

  const applyFallbackConfiguration = (ctx: CommunityWidgetContext, unavailable = false) => {
    const fallback = getFallbackConfig();
    applyConfig(fallback.config, editing);
    configRevision = null;
    status = fallback.status;
    configRequest = unavailable
      ? unavailableRequest(
          configRequest,
          'This host does not support shared community configuration.',
          true
        )
      : completeRequest(configRequest);
    loadEventsForConfig(ctx, fallback.config, eventsRequest.hasValue);
  };

  async function loadSharedConfig(ctx = communityContext, options: LoadRequestOptions = {}) {
    if (!bridge || !ctx) return;
    if (savingConfig) {
      pendingConfigRefresh = true;
      return;
    }
    if (!querySharedConfigSupported) {
      applyFallbackConfiguration(ctx, true);
      return;
    }

    const retryingRun = options.runId !== undefined;
    if (isRequestBusy(configRequest) && !retryingRun) {
      if (configRequest.phase === 'loading') pendingConfigRefresh = true;
      return;
    }

    const expectedContext = ctx;
    const generation = contextGeneration;
    if (options.runId === undefined) configRunId = advanceRequestEpoch(configRunId);
    const runId = options.runId ?? configRunId;
    const attempt = options.attempt ?? 1;
    if (
      !requestEpochIsCurrent(runId, configRunId) ||
      !contextIsCurrent(expectedContext, generation)
    ) {
      return;
    }
    if (configRetryTimer) clearTimeout(configRetryTimer);
    configRetryTimer = undefined;
    configRequest = beginRequest(configRequest, attempt);
    if (!options.background && !configRequest.hasValue) {
      status = 'Loading featured events configuration...';
    }

    const requestBridge = bridge;
    try {
      const res = await requestBridge.request('community:querySharedConfig', {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        descriptors: CALENDAR_DESCRIPTORS,
        limit: 100,
      });
      if (
        !contextIsCurrent(expectedContext, generation) ||
        !requestEpochIsCurrent(runId, configRunId)
      ) {
        return;
      }
      if ('error' in res) {
        handleConfigFailure(res, expectedContext, generation, runId, attempt);
        return;
      }
      if (!responseMatchesContext(res, expectedContext)) {
        handleConfigFailure(staleResponseError, expectedContext, generation, runId, attempt);
        return;
      }

      const fallback = getFallbackConfig();
      configRevision = getSharedConfigRevision(res);
      const sharedConfig = resolveSharedWidgetConfig(
        res,
        fallback.config,
        configRequest.hasValue ? config : null
      );
      const nextConfig = sharedConfig.config;
      if (sharedConfig.status === 'valid') {
        status = 'Featured events configuration loaded.';
      } else if (sharedConfig.status === 'invalid') {
        const failure = failRequest(retainRequestValue(configRequest), {
          error: 'The shared featured events configuration is malformed.',
          code: 'INVALID_CONFIG',
        });
        applyConfig(nextConfig, editing);
        configRequest = failure.state;
        status =
          sharedConfig.source === 'previous'
            ? 'Shared featured events configuration is malformed. Showing the last loaded configuration.'
            : `Shared featured events configuration is malformed. ${fallback.status}`;
        loadEventsForConfig(
          expectedContext,
          nextConfig,
          options.background || eventsRequest.hasValue
        );
        return;
      } else {
        status = fallback.status;
      }

      applyConfig(nextConfig, editing);
      configRequest = completeRequest(configRequest);
      loadEventsForConfig(
        expectedContext,
        nextConfig,
        options.background || eventsRequest.hasValue
      );
    } catch (err) {
      if (
        contextIsCurrent(expectedContext, generation) &&
        requestEpochIsCurrent(runId, configRunId)
      ) {
        handleConfigFailure(err, expectedContext, generation, runId, attempt);
      }
    } finally {
      if (
        contextIsCurrent(expectedContext, generation) &&
        requestEpochIsCurrent(runId, configRunId) &&
        configRequest.phase === 'success' &&
        pendingConfigRefresh
      ) {
        pendingConfigRefresh = false;
        queueMicrotask(() => void loadSharedConfig(expectedContext, {background: true}));
      }
    }
  }

  const getEventsLoadKey = (refs: string[], broad: boolean) => JSON.stringify([broad, refs]);

  const handleEventsFailure = (
    value: unknown,
    ctx: CommunityWidgetContext,
    generation: number,
    runId: number,
    attempt: number,
    refs: string[],
    broad: boolean
  ) => {
    if (isUnsupportedCapabilityError(value)) {
      markRuntimeUnsupported('community:queryEvents');
      pendingEventsLoad = null;
      eventsRequest = unavailableRequest(
        eventsRequest,
        'This host does not support community calendar event queries.'
      );
      status = 'Community calendar events are unavailable on this host.';
      return;
    }

    const failure = failRequest(eventsRequest, value);
    eventsRequest = failure.state;
    if (failure.retryDelayMs !== null) {
      status = 'Waiting for community calendar events to become ready...';
      eventsRetryTimer = setTimeout(() => {
        eventsRetryTimer = undefined;
        if (contextIsCurrent(ctx, generation) && runId === eventsRunId) {
          void loadCalendarEvents(ctx, {
            refs,
            broad,
            attempt: attempt + 1,
            runId,
            background: true,
          });
        }
      }, failure.retryDelayMs);
    } else {
      status = 'Unable to load calendar events.';
    }
  };

  async function loadCalendarEvents(
    ctx = communityContext,
    options: LoadCalendarEventsOptions = {}
  ) {
    if (!bridge || !ctx) return;
    if (!queryEventsSupported) {
      eventsRequest = unavailableRequest(
        eventsRequest,
        'This host does not support community calendar event queries.'
      );
      return;
    }

    const refs = normalizeEventRefs(options.refs ?? config.eventRefs);
    const broad = options.broad === true;
    const loadKey = getEventsLoadKey(refs, broad);
    const retryingRun = options.runId !== undefined;
    if (isRequestBusy(eventsRequest) && !retryingRun) {
      if (loadKey !== currentEventsLoadKey) {
        pendingEventsLoad = {refs, broad, background: true};
      }
      return;
    }

    const expectedContext = ctx;
    const generation = contextGeneration;
    const runId = options.runId ?? ++eventsRunId;
    const attempt = options.attempt ?? 1;
    if (runId !== eventsRunId || !contextIsCurrent(expectedContext, generation)) return;
    if (eventsRetryTimer) clearTimeout(eventsRetryTimer);
    eventsRetryTimer = undefined;
    currentEventsLoadKey = loadKey;
    const previousEvents = events;

    if (!refs.length && !broad) {
      events = [];
      eventsRequest = completeRequest(eventsRequest);
      status = 'No featured events configured yet.';
      return;
    }

    eventsRequest = beginRequest(eventsRequest, attempt);
    if (!options.background && !eventsRequest.hasValue) {
      status = 'Loading community calendar events...';
    }

    const requestBridge = bridge;
    const discoveryNow = Math.floor(Date.now() / 1000);
    const queryEvents = async (exactRefs?: string[], until?: number) => {
      const res = await requestBridge.request('community:queryEvents', {
        descriptors: CALENDAR_DESCRIPTORS,
        limit: BROAD_PAGE_SIZE,
        ...(exactRefs?.length ? {refs: exactRefs} : {}),
        ...(until ? {until} : {}),
        ...(!exactRefs?.length
          ? ({
              calendarStart: discoveryNow,
              calendarDate: getLocalCalendarDate(discoveryNow),
            } as Record<string, unknown>)
          : {}),
      });
      if (!contextIsCurrent(expectedContext, generation) || runId !== eventsRunId) return null;
      if ('error' in res) throw res;
      if (!responseMatchesContext(res, expectedContext)) throw staleResponseError;
      const rawEvents = Array.isArray(res.events) ? res.events : [];
      const paged = res as typeof res & {hasMore?: boolean; nextUntil?: number};
      return {
        events: filterCalendarEvents(rawEvents),
        rawCount: rawEvents.length,
        oldestCreatedAt: rawEvents.reduce(
          (oldest, event) => Math.min(oldest, event.created_at),
          Number.POSITIVE_INFINITY
        ),
        hasPaginationMetadata: typeof paged.hasMore === 'boolean',
        hasMore: paged.hasMore,
        nextUntil: paged.nextUntil,
      };
    };

    try {
      const initialPlan = planEventQueries(refs);
      const exactPage = initialPlan.canonicalRefs.length
        ? await queryEvents(initialPlan.canonicalRefs)
        : null;
      if (initialPlan.canonicalRefs.length && exactPage === null) return;
      const exactEvents = exactPage?.events ?? [];

      if (exactEvents.length) {
        events = mergeCalendarEventsForRefs(refs, events, exactEvents);
        eventsRequest = retainRequestValue(eventsRequest);
      }
      const resolvedPlan = planEventQueries(refs, exactEvents);
      const broadEvents: NostrEvent[] = [];
      if (broad || resolvedPlan.needsBroadDiscovery) {
        let until: number | undefined;
        for (let pageNumber = 0; pageNumber < MAX_BROAD_PAGES; pageNumber += 1) {
          const page = await queryEvents(undefined, until);
          if (page === null) return;
          broadEvents.push(...page.events);

          const hasMore = page.hasPaginationMetadata
            ? page.hasMore === true
            : page.rawCount >= BROAD_PAGE_SIZE;
          if (!hasMore) break;

          const nextUntil =
            page.nextUntil ??
            (!page.hasPaginationMetadata && Number.isFinite(page.oldestCreatedAt)
              ? page.oldestCreatedAt - 1
              : undefined);
          if (!nextUntil || nextUntil <= 0 || (until !== undefined && nextUntil >= until)) break;
          until = nextUntil;
        }
      }

      events =
        broad || resolvedPlan.needsBroadDiscovery
          ? mergeCalendarEditorEvents(refs, previousEvents, exactEvents, broadEvents)
          : mergeCalendarEventsForRefs(refs, exactEvents);
      eventsRequest = completeRequest(eventsRequest);
      status = events.length ? '' : 'No events found.';
    } catch (err) {
      if (contextIsCurrent(expectedContext, generation) && runId === eventsRunId) {
        handleEventsFailure(err, expectedContext, generation, runId, attempt, refs, broad);
      }
    } finally {
      if (
        contextIsCurrent(expectedContext, generation) &&
        runId === eventsRunId &&
        pendingEventsLoad
      ) {
        const pending = pendingEventsLoad;
        const pendingKey = getEventsLoadKey(
          normalizeEventRefs(pending.refs ?? []),
          pending.broad === true
        );
        pendingEventsLoad = null;
        if (eventsRequest.phase === 'success' || pendingKey !== currentEventsLoadKey) {
          queueMicrotask(() => void loadCalendarEvents(expectedContext, pending));
        }
      }
    }
  }

  const invalidateConfigQueries = () => {
    configRunId = advanceRequestEpoch(configRunId);
    if (configRetryTimer) clearTimeout(configRetryTimer);
    configRetryTimer = undefined;
    pendingConfigRefresh = false;
    configRequest = configRequest.hasValue ? completeRequest(configRequest) : createRequestState();
  };

  const handleUnsupportedConfigPublish = () => {
    markRuntimeUnsupported('community:publishSharedConfig');
    editing = false;
    editingBaseRevision = null;
    error = '';
    status = 'Shared configuration editing is unavailable on this host.';
  };

  async function saveConfig() {
    if (!communityContext || !canConfigure) return;

    if (configRevision !== editingBaseRevision) {
      error =
        'Featured events changed while you were editing. Review the refreshed configuration before saving.';
      status = 'Unable to save because the shared configuration was refreshed.';
      return;
    }

    const expectedContext = communityContext;
    const generation = contextGeneration;

    const next = {
      header: headerInput.trim() || DEFAULT_HEADER,
      eventRefs: canonicalizeEventRefs(selectedEventRefs, events),
    };

    savingConfig = true;
    invalidateConfigQueries();
    error = '';
    status = 'Saving featured events for this community...';
    let saved = false;

    try {
      const res = await bridge?.request('community:publishSharedConfig', {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        descriptors: CALENDAR_DESCRIPTORS,
        config: next,
        ...({expectedRevision: editingBaseRevision} as Record<string, unknown>),
      });

      if (!contextIsCurrent(expectedContext, generation)) return;

      if (!res || 'error' in res) {
        if (res && isConfigRevisionConflict(res)) {
          error =
            'Featured events changed while you were editing. Refresh or cancel before saving again.';
          status = 'Unable to save because another moderator updated the configuration.';
          pendingConfigRefresh = false;
          queueMicrotask(() => void loadSharedConfig(expectedContext, {background: true}));
          return;
        }
        if (res && isUnsupportedCapabilityError(res)) {
          handleUnsupportedConfigPublish();
          return;
        }
        error = res?.error || 'Unable to save featured events configuration.';
        status = 'Unable to save featured events configuration.';
        return;
      }

      if (!responseMatchesContext(res, expectedContext)) {
        error = staleResponseError.error;
        status = 'Unable to save featured events configuration.';
        return;
      }

      invalidateConfigQueries();
      applyConfig(next);
      configRevision = typeof res.eventId === 'string' ? res.eventId : configRevision;
      editingBaseRevision = null;
      configRequest = completeRequest(configRequest);
      editing = false;
      status = 'Featured events saved for this community.';
      saved = true;
    } catch (err) {
      if (!contextIsCurrent(expectedContext, generation)) return;
      if (isUnsupportedCapabilityError(err)) {
        handleUnsupportedConfigPublish();
        return;
      }
      error = err instanceof Error ? err.message : String(err);
      status = 'Unable to save featured events configuration.';
    } finally {
      if (contextIsCurrent(expectedContext, generation)) {
        savingConfig = false;
        if (!saved && pendingConfigRefresh) {
          pendingConfigRefresh = false;
          queueMicrotask(() => void loadSharedConfig(expectedContext, {background: true}));
        }
      }
    }

    if (saved) {
      try {
        await bridge?.request('ui:toast', {
          message: 'Featured events saved',
          type: 'success',
        });
      } catch {
        // Toast is best-effort.
      }
    }
  }

  const refreshAll = (ctx = communityContext) => {
    if (!ctx) return;
    void refreshCalendarCapabilities(ctx, {background: true});
    if (querySharedConfigSupported) {
      void loadSharedConfig(ctx, {background: true});
    } else if (configRequest.hasValue) {
      void loadCalendarEvents(ctx, {
        refs: editing ? selectedEventRefs : config.eventRefs,
        broad: editing,
        background: true,
      });
    }
  };

  const schedulePostInitRefresh = (ctx: CommunityWidgetContext) => {
    const generation = contextGeneration;
    postInitRefreshPoll.start(() => {
      if (contextIsCurrent(ctx, generation)) {
        refreshAll(ctx);
      } else {
        postInitRefreshPoll.stop();
      }
    });
  };

  const scheduleResumeRefresh = () => {
    if (resumeRefreshTimer) clearTimeout(resumeRefreshTimer);
    resumeRefreshTimer = setTimeout(() => {
      resumeRefreshTimer = undefined;
      refreshAll();
    }, RESUME_REFRESH_DEBOUNCE_MS);
  };

  const retryFailedLoads = () => {
    const ctx = communityContext;
    if (!ctx) return;
    if (capabilitiesRequest.phase === 'error') {
      void refreshCalendarCapabilities(ctx);
    }
    if (configRequest.phase === 'error') void loadSharedConfig(ctx);
    if (eventsRequest.phase === 'error') {
      void loadCalendarEvents(ctx, {
        refs: editing ? selectedEventRefs : config.eventRefs,
        broad: editing,
      });
    }
  };

  const reconcileHostCapabilityPolicy = (ctx: CommunityWidgetContext) => {
    if (!checkCapabilitiesSupported) {
      capabilitiesRunId += 1;
      if (capabilitiesRetryTimer) clearTimeout(capabilitiesRetryTimer);
      capabilitiesRetryTimer = undefined;
      capabilitiesRequest = unavailableRequest(
        capabilitiesRequest,
        'This host does not support community moderator capability checks.'
      );
    }
    if (!queryEventsSupported) {
      eventsRunId += 1;
      if (eventsRetryTimer) clearTimeout(eventsRetryTimer);
      eventsRetryTimer = undefined;
      eventsRequest = unavailableRequest(
        eventsRequest,
        'This host does not support community calendar event queries.'
      );
    }
    if (!querySharedConfigSupported && configRequest.phase !== 'unavailable') {
      configRunId = advanceRequestEpoch(configRunId);
      if (configRetryTimer) clearTimeout(configRetryTimer);
      configRetryTimer = undefined;
      applyFallbackConfiguration(ctx, true);
    }
  };

  const startContextLoads = (ctx: CommunityWidgetContext) => {
    reconcileHostCapabilityPolicy(ctx);
    if (checkCapabilitiesSupported) void refreshCalendarCapabilities(ctx);
    if (querySharedConfigSupported) void loadSharedConfig(ctx);
    schedulePostInitRefresh(ctx);
  };

  function applyCommunityContext(nextContext: CommunityWidgetContext | null) {
    contextGeneration += 1;
    configRunId = advanceRequestEpoch(configRunId);
    eventsRunId += 1;
    capabilitiesRunId += 1;
    communityContext = nextContext;
    calendarCapabilities = [];
    events = [];
    error = '';
    configRequest = createRequestState();
    eventsRequest = createRequestState();
    capabilitiesRequest = createRequestState();
    clearLoadRetries();
    clearRefreshTimers();
    pendingConfigRefresh = false;
    pendingCapabilitiesRefresh = false;
    pendingEventsLoad = null;
    currentEventsLoadKey = '';
    savingConfig = false;
    editing = false;
    configRevision = null;
    editingBaseRevision = null;
    lastRequestedHeight = 0;

    applyConfig({header: DEFAULT_HEADER, eventRefs: []});
    status = nextContext
      ? `Connected to community context ${getCommunityContextKey(nextContext)}.`
      : 'Waiting for BudaBit community context...';
    if (nextContext) startContextLoads(nextContext);
    scheduleHostResize();
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
    const scrollOptions: AddEventListenerOptions = {
      capture: true,
      passive: true,
    };

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
    window.addEventListener('pageshow', scheduleResumeRefresh);
    window.addEventListener('focus', scheduleResumeRefresh);
    window.addEventListener('online', scheduleResumeRefresh);

    return () => {
      window.removeEventListener('pageshow', scheduleResumeRefresh);
      window.removeEventListener('focus', scheduleResumeRefresh);
      window.removeEventListener('online', scheduleResumeRefresh);
      if (resumeRefreshTimer) clearTimeout(resumeRefreshTimer);
      resumeRefreshTimer = undefined;
    };
  });

  $effect(() => {
    const b = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: '*',
      timeoutMs: BRIDGE_TIMEOUT_MS,
    });

    bridge = b;

    const offInit = b.onEvent('widget:init', (payload) => {
      initPayload = payload;
      applyTheme(payload.theme, payload.themeBackground);
      const catalog = getHostCapabilityCatalog(payload);
      if (catalog !== null) {
        hostCapabilityCatalog = catalog;
        runtimeUnsupportedActions = [];
      } else if (hostCapabilityCatalog === null) {
        hostCapabilityCatalog = null;
      }
      const nextContext = payload.communityContext ?? null;
      if (
        nextContext &&
        communityContext &&
        getCommunityContextKey(nextContext) === getCommunityContextKey(communityContext)
      ) {
        reconcileHostCapabilityPolicy(communityContext);
        schedulePostInitRefresh(communityContext);
        return;
      }
      if (!nextContext && !communityContext) return;
      applyCommunityContext(nextContext);
    });

    const offCommunityChanged = b.onEvent('community:contextChanged', (payload) => {
      const nextContext = payload.communityContext ?? null;
      if (
        nextContext &&
        communityContext &&
        getCommunityContextKey(nextContext) === getCommunityContextKey(communityContext)
      ) {
        schedulePostInitRefresh(communityContext);
        return;
      }
      applyCommunityContext(nextContext);
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
      clearLoadRetries();
      clearRefreshTimers();
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
    {#if !queryEventsSupported}
      <section class="panel warning">
        <strong>{config.header || DEFAULT_HEADER}</strong>
        <p>{compatibilityMessage}</p>
      </section>
    {:else if selectedEvents.length}
      <section class="featured-events" aria-labelledby="featured-events-heading">
        <div class="event-heading">
          <p id="featured-events-heading" class="eyebrow">
            {config.header || DEFAULT_HEADER}
          </p>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Edit</button>
          {/if}
        </div>

        <div class="event-list">
          {#each selectedEvents as featuredEvent (featuredEvent.id)}
            {@const eventPath = getEventPath(featuredEvent)}
            {@const eventHref = getEventHref(featuredEvent)}
            {#if eventHref}
              <a
                class="event-card event-card-link"
                href={eventHref}
                target="_top"
                onclick={(event) => navigateToEvent(event, eventPath, eventHref)}
              >
                <h1>{getEventTitle(featuredEvent)}</h1>
                <p class="date">{formatEventDate(featuredEvent)}</p>
                {#if tagValue(featuredEvent, 'location')}
                  <p class="location">{tagValue(featuredEvent, 'location')}</p>
                {/if}
                {#if getEventSummary(featuredEvent)}
                  <p class="summary">{getVisibleEventSummary(featuredEvent)}</p>
                {/if}
              </a>
            {:else}
              <article class="event-card">
                <h1>{getEventTitle(featuredEvent)}</h1>
                <p class="date">{formatEventDate(featuredEvent)}</p>
                {#if tagValue(featuredEvent, 'location')}
                  <p class="location">{tagValue(featuredEvent, 'location')}</p>
                {/if}
                {#if getEventSummary(featuredEvent)}
                  <p class="summary">{getVisibleEventSummary(featuredEvent)}</p>
                {/if}
              </article>
            {/if}
          {/each}
        </div>
      </section>
    {:else if blockingLoadError}
      <section class="panel warning">
        <div class="config-heading">
          <strong>{config.header || DEFAULT_HEADER}</strong>
          <button type="button" class="secondary small" onclick={retryFailedLoads}>Retry</button>
        </div>
        <p>Unable to finish loading featured events.</p>
        <p class="error">{requestErrorText}</p>
      </section>
    {:else if waitingForInitialData}
      <section class="panel muted">
        <strong>{config.header || DEFAULT_HEADER}</strong>
        <p>{status}</p>
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
          <strong>{config.header || DEFAULT_HEADER}</strong>
          {#if canConfigure}
            <button type="button" class="secondary small" onclick={startEditing}>Configure</button>
          {/if}
        </div>
        <p>{NO_CONFIG_TEXT}</p>
      </section>
    {/if}

    {#if hasRequestError && !blockingLoadError}
      <section class="panel warning load-recovery">
        <div class="config-heading">
          <strong>Some calendar data could not be refreshed.</strong>
          <button type="button" class="secondary small" onclick={retryFailedLoads}>Retry</button>
        </div>
        <p class="error">{requestErrorText}</p>
      </section>
    {/if}

    {#if compatibilityMessage && queryEventsSupported}
      <section class="panel muted compatibility-note">
        <p>{compatibilityMessage}</p>
      </section>
    {/if}

    {#if canConfigure && editing}
      <section class="config-panel" bind:this={configPanelElement}>
        <div class="config-heading">
          <div>
            <h2>Configure featured events</h2>
          </div>
          <button
            type="button"
            onclick={() =>
              loadCalendarEvents(communityContext, {refs: selectedEventRefs, broad: true})}
            disabled={loadingEvents}
          >
            {loadingEvents ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        <label>
          <span>Header</span>
          <input bind:value={headerInput} placeholder={DEFAULT_HEADER} />
        </label>

        {#if unresolvedSelectedEventRefs.length}
          <div class="unresolved-events">
            <p>
              These configured event refs were not found. Remove them or choose another event below.
            </p>
            <div class="missing-ref-list">
              {#each unresolvedSelectedEventRefs as ref (ref)}
                <div class="missing-ref">
                  <code>{ref}</code>
                  <button
                    type="button"
                    class="secondary small"
                    onclick={() => removeSelectedEventRef(ref)}
                  >
                    Remove
                  </button>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="event-picker" role="group" aria-labelledby="event-picker-heading">
          <div class="picker-heading">
            <span id="event-picker-heading">Calendar events</span>
            <span class="selected-count">{selectedEventCountText}</span>
          </div>

          {#if pickerEvents.length}
            <div class="event-options">
              {#each pickerEvents as event (event.id)}
                <label class="event-option">
                  <input
                    type="checkbox"
                    checked={isEventSelected(event)}
                    onchange={() => toggleSelectedEvent(event)}
                  />
                  <span>
                    <strong>{getEventTitle(event)}</strong>
                    <span>{formatEventDate(event)}</span>
                  </span>
                </label>
              {/each}
            </div>
          {:else if loadingEvents}
            <p class="picker-empty">Loading calendar events...</p>
          {:else}
            <p class="picker-empty">No calendar events found.</p>
          {/if}
        </div>

        <div class="button-row">
          <button type="button" onclick={saveConfig} disabled={savingConfig}>
            {savingConfig ? 'Saving...' : 'Save for community'}
          </button>
          <button
            type="button"
            class="secondary"
            onclick={cancelEditing}
            disabled={savingConfig}
          >
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
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      sans-serif;
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

  .featured-events {
    display: grid;
    gap: 8px;
  }

  .event-list {
    display: grid;
    gap: 12px;
  }

  .event-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 12px;
  }

  .eyebrow {
    grid-column: 2;
    margin: 0;
    color: var(--accent-strong);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-align: center;
    text-transform: uppercase;
  }

  .event-heading button {
    grid-column: 3;
    justify-self: end;
  }

  h1 {
    margin: 0;
    color: var(--text-strong);
    font-size: clamp(1.35rem, 4vw, 2rem);
    line-height: 1.05;
  }

  .event-card-link {
    display: block;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .event-card-link:hover h1,
  .event-card-link:focus-visible h1 {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 0.14em;
  }

  .event-card-link:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
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

  .load-recovery,
  .compatibility-note {
    margin-top: 12px;
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

  .unresolved-events {
    display: grid;
    gap: 8px;
    margin-top: 12px;
    border: 1px solid rgba(202, 138, 4, 0.34);
    border-radius: 12px;
    background: color-mix(in srgb, #fef3c7 36%, var(--panel-muted));
    color: var(--text-muted);
    font-size: 0.84rem;
    padding: 10px;
  }

  .unresolved-events p {
    margin: 0;
    font-weight: 600;
    line-height: 1.35;
  }

  .missing-ref-list {
    display: grid;
    gap: 6px;
  }

  .missing-ref {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .missing-ref code {
    color: var(--text-strong);
    font-size: 0.78rem;
    font-weight: 700;
    overflow-wrap: anywhere;
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
