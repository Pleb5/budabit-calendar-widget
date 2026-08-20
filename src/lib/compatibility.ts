import type {NostrEvent} from 'budabit-sdk';

export const EVENT_DATE = 31922;
export const EVENT_TIME = 31923;
export const DEFAULT_HEADER = 'Featured events';
export const MAX_REQUEST_ATTEMPTS = 4;

const HEX_EVENT_ID = /^[0-9a-f]{64}$/i;
const TRANSIENT_COMMUNITY_ERROR_CODES = new Set([
  'COMMUNITY_CONTEXT_NOT_READY',
  'COMMUNITY_QUERY_TIMEOUT',
]);

export type WidgetConfig = {
  header: string;
  eventRefs: string[];
};

export type ClassifiedEventRef =
  | {type: 'id'; value: string}
  | {type: 'address'; value: string; kind: number; pubkey: string; identifier: string}
  | {type: 'legacy'; value: string};

export type RequestPhase = 'idle' | 'loading' | 'retrying' | 'success' | 'error' | 'unavailable';

export type RequestState = {
  phase: RequestPhase;
  attempt: number;
  error: string;
  hasValue: boolean;
};

export type HostCapabilityAction =
  | 'community:queryEvents'
  | 'community:querySharedConfig'
  | 'community:publishSharedConfig'
  | 'community:checkWriteCapabilities';

export type HostCapabilityState = 'unknown' | 'supported' | 'unsupported';

export type HostCapabilityPolicy = Record<HostCapabilityAction, HostCapabilityState>;

// Accept the current SDK catalog plus structural aliases used by compatibility hosts.
export type HostCapabilityInitPayload = {
  capabilityCatalog?: unknown;
  hostCapabilities?: unknown;
  capabilities?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const getErrorMessage = (value: unknown) => {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string' && value.trim()) return value;
  const record = asRecord(value);
  if (typeof record?.error === 'string' && record.error.trim()) return record.error;
  return typeof record?.message === 'string' && record.message.trim()
    ? record.message
    : 'The host request failed.';
};

export const classifyEventRef = (value: unknown): ClassifiedEventRef | null => {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  if (!ref) return null;

  if (HEX_EVENT_ID.test(ref)) return {type: 'id', value: ref.toLowerCase()};

  const [kindRaw, pubkeyRaw, ...identifierParts] = ref.split(':');
  const identifier = identifierParts.join(':').trim();
  if (/^\d+$/.test(kindRaw) && HEX_EVENT_ID.test(pubkeyRaw || '') && identifier) {
    const kind = Number(kindRaw);
    const pubkey = pubkeyRaw.toLowerCase();
    if (Number.isSafeInteger(kind)) {
      return {
        type: 'address',
        value: `${kind}:${pubkey}:${identifier}`,
        kind,
        pubkey,
        identifier,
      };
    }
  }

  return {type: 'legacy', value: ref};
};

export const normalizeEventRefs = (refs: unknown): string[] => {
  if (!Array.isArray(refs)) return [];
  return Array.from(
    new Set(
      refs
        .map(classifyEventRef)
        .filter((ref): ref is ClassifiedEventRef => Boolean(ref))
        .map((ref) => ref.value)
    )
  );
};

export const normalizeWidgetConfig = (value: unknown): WidgetConfig | null => {
  const config = asRecord(value);
  if (!config) return null;

  const hasEventRefs = Object.prototype.hasOwnProperty.call(config, 'eventRefs');
  const hasLegacyEventRef = Object.prototype.hasOwnProperty.call(config, 'eventRef');
  if (!hasEventRefs && !hasLegacyEventRef) return null;
  if (hasEventRefs && !Array.isArray(config.eventRefs)) return null;
  if (hasEventRefs && !(config.eventRefs as unknown[]).every((ref) => typeof ref === 'string')) {
    return null;
  }
  if (!hasEventRefs && typeof config.eventRef !== 'string') return null;

  const eventRefs = normalizeEventRefs(hasEventRefs ? config.eventRefs : [config.eventRef]);
  const header = typeof config.header === 'string' ? config.header.trim() : '';

  return {header: header || DEFAULT_HEADER, eventRefs};
};

export const eventTagValue = (event: Pick<NostrEvent, 'tags'>, name: string) =>
  event.tags.find((tag) => Array.isArray(tag) && tag[0] === name)?.[1] || '';

export const classifySharedWidgetConfig = (
  response: unknown
):
  | {status: 'absent'}
  | {status: 'valid'; config: WidgetConfig}
  | {status: 'invalid'} => {
  const record = asRecord(response);
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'config')) return {status: 'absent'};
  const config = normalizeWidgetConfig(record.config);
  return config ? {status: 'valid', config} : {status: 'invalid'};
};

export const resolveSharedWidgetConfig = (
  response: unknown,
  fallback: WidgetConfig,
  previous: WidgetConfig | null = null
): {
  status: 'valid' | 'absent' | 'invalid';
  source: 'shared' | 'previous' | 'fallback';
  config: WidgetConfig;
} => {
  const shared = classifySharedWidgetConfig(response);
  if (shared.status === 'valid') {
    return {status: 'valid', source: 'shared', config: shared.config};
  }
  if (shared.status === 'absent') {
    return {status: 'absent', source: 'fallback', config: fallback};
  }
  return previous
    ? {status: 'invalid', source: 'previous', config: previous}
    : {status: 'invalid', source: 'fallback', config: fallback};
};

export const getCalendarEventAddress = (event: NostrEvent) => {
  const identifier = eventTagValue(event, 'd').trim();
  const pubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
  return identifier && HEX_EVENT_ID.test(pubkey)
    ? `${event.kind}:${pubkey}:${identifier}`
    : '';
};

export const getEventConfigRef = (event: NostrEvent) =>
  getCalendarEventAddress(event) || classifyEventRef(event.id)?.value || '';

export const matchesEventRef = (event: NostrEvent, value: unknown) => {
  const ref = classifyEventRef(value);
  if (!ref) return false;
  if (ref.type === 'id') return event.id.toLowerCase() === ref.value;
  if (ref.type === 'address') return getCalendarEventAddress(event) === ref.value;
  return eventTagValue(event, 'd') === ref.value;
};

export const planEventQueries = (refs: unknown, exactEvents: NostrEvent[] = []) => {
  const normalizedRefs = normalizeEventRefs(refs);
  const classified = normalizedRefs
    .map(classifyEventRef)
    .filter((ref): ref is ClassifiedEventRef => Boolean(ref));
  const canonicalRefs = classified
    .filter((ref) => ref.type === 'id' || ref.type === 'address')
    .map((ref) => ref.value);
  const legacyRefs = classified.filter((ref) => ref.type === 'legacy').map((ref) => ref.value);
  const unresolvedCanonicalRefs = canonicalRefs.filter(
    (ref) => !exactEvents.some((event) => matchesEventRef(event, ref))
  );

  return {
    normalizedRefs,
    canonicalRefs,
    legacyRefs,
    unresolvedCanonicalRefs,
    needsBroadDiscovery:
      normalizedRefs.length === 0 || legacyRefs.length > 0 || unresolvedCanonicalRefs.length > 0,
  };
};

const isPreferredReplacement = (candidate: NostrEvent, current: NostrEvent | undefined) => {
  if (!current) return true;
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at;
  return candidate.id.localeCompare(current.id) < 0;
};

export const collapseCalendarEventReplacements = (values: NostrEvent[]) => {
  const byAddress = new Map<string, NostrEvent>();
  const byId = new Map<string, NostrEvent>();

  for (const event of values) {
    if (!event || (event.kind !== EVENT_TIME && event.kind !== EVENT_DATE)) continue;
    if (typeof event.id !== 'string' || typeof event.pubkey !== 'string' || !Array.isArray(event.tags)) {
      continue;
    }

    const address = getCalendarEventAddress(event);
    if (address) {
      if (isPreferredReplacement(event, byAddress.get(address))) byAddress.set(address, event);
    } else {
      const id = event.id.toLowerCase();
      if (isPreferredReplacement(event, byId.get(id))) byId.set(id, event);
    }
  }

  return [...byAddress.values(), ...byId.values()];
};

export const mergeCalendarEvents = (...groups: NostrEvent[][]) =>
  collapseCalendarEventReplacements(groups.flat());

export const mergeCalendarEventsForRefs = (refs: unknown, ...groups: NostrEvent[][]) => {
  const explicitIds = new Set(
    normalizeEventRefs(refs)
      .map(classifyEventRef)
      .filter((ref): ref is Extract<ClassifiedEventRef, {type: 'id'}> => ref?.type === 'id')
      .map((ref) => ref.value)
  );
  const events = groups.flat();
  const pinnedById = new Map<string, NostrEvent>();

  for (const event of events) {
    const id = typeof event?.id === 'string' ? event.id.toLowerCase() : '';
    if (explicitIds.has(id) && !pinnedById.has(id)) pinnedById.set(id, event);
  }

  return [
    ...pinnedById.values(),
    ...collapseCalendarEventReplacements(
      events.filter(
        (event) => typeof event?.id !== 'string' || !pinnedById.has(event.id.toLowerCase())
      )
    ),
  ];
};

export const canonicalizeEventRefs = (refs: unknown, values: NostrEvent[]) => {
  const events = collapseCalendarEventReplacements(values);
  const canonical: string[] = [];

  for (const value of normalizeEventRefs(refs)) {
    const ref = classifyEventRef(value);
    if (!ref) continue;
    if (ref.type !== 'legacy') {
      canonical.push(ref.value);
      continue;
    }

    const matches = events.filter((event) => matchesEventRef(event, ref.value));
    if (matches.length) {
      canonical.push(...matches.map(getEventConfigRef).filter(Boolean));
    } else {
      canonical.push(ref.value);
    }
  }

  return Array.from(new Set(canonical));
};

const parseCalendarTimestamp = (value: string) => {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
};

export const getCalendarEventEnd = (event: NostrEvent) => {
  const end =
    parseCalendarTimestamp(eventTagValue(event, 'end')) ||
    parseCalendarTimestamp(eventTagValue(event, 'start'));
  return event.kind === EVENT_DATE && end ? end + 86_399 : end;
};

export const selectCalendarPickerEvents = (
  values: NostrEvent[],
  selectedRefs: unknown,
  now: number,
  maxEvents: number
) => {
  const refs = normalizeEventRefs(selectedRefs);
  const isSelected = (event: NostrEvent) => refs.some((ref) => matchesEventRef(event, ref));
  const selected = values.filter(isSelected);
  const available = collapseCalendarEventReplacements(values).filter((event) => {
    const end = getCalendarEventEnd(event);
    return !end || end >= now;
  });
  const byAddress = new Map<string, NostrEvent>();

  for (const event of [...selected, ...available]) {
    const key = getEventConfigRef(event) || event.id;
    if (!byAddress.has(key)) byAddress.set(key, event);
  }

  const merged = Array.from(byAddress.values()).sort(
    (a, b) =>
      (parseCalendarTimestamp(eventTagValue(a, 'start')) || 0) -
      (parseCalendarTimestamp(eventTagValue(b, 'start')) || 0)
  );
  const selectedRows = merged.filter(isSelected);
  const candidateRows = merged.filter((event) => !isSelected(event));
  return [
    ...selectedRows,
    ...candidateRows.slice(0, Math.max(0, Math.floor(maxEvents) - selectedRows.length)),
  ];
};

export const classifyCommunityError = (value: unknown) => {
  const record = asRecord(value);
  return typeof record?.code === 'string' && TRANSIENT_COMMUNITY_ERROR_CODES.has(record.code)
    ? ('transient' as const)
    : ('terminal' as const);
};

export const getRetryDelay = (attempt: number) =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);

export const createRequestState = (hasValue = false): RequestState => ({
  phase: 'idle',
  attempt: 0,
  error: '',
  hasValue,
});

export const beginRequest = (state: RequestState, attempt: number): RequestState => ({
  ...state,
  phase: 'loading',
  attempt,
  error: '',
});

export const completeRequest = (state: RequestState): RequestState => ({
  ...state,
  phase: 'success',
  error: '',
  hasValue: true,
});

export const retainRequestValue = (state: RequestState): RequestState => ({
  ...state,
  hasValue: true,
});

export const isBlockingRequestError = (state: RequestState, required = true) =>
  required && state.phase === 'error' && !state.hasValue;

export const failRequest = (
  state: RequestState,
  value: unknown,
  maxAttempts = MAX_REQUEST_ATTEMPTS
): {state: RequestState; retryDelayMs: number | null} => {
  const retry = classifyCommunityError(value) === 'transient' && state.attempt < maxAttempts;
  return {
    state: {
      ...state,
      phase: retry ? 'retrying' : 'error',
      error: getErrorMessage(value),
    },
    retryDelayMs: retry ? getRetryDelay(state.attempt) : null,
  };
};

export const unavailableRequest = (state: RequestState, error: string, hasValue = state.hasValue) => ({
  ...state,
  phase: 'unavailable' as const,
  attempt: 0,
  error,
  hasValue,
});

const stringCatalog = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string')));
};

export const getHostCapabilityCatalog = (payload: unknown): string[] | null => {
  const record = asRecord(payload) as HostCapabilityInitPayload | null;
  if (!record) return null;
  const candidate = record.capabilityCatalog ?? record.hostCapabilities ?? record.capabilities;
  const direct = stringCatalog(candidate);
  if (direct) return direct;
  const catalog = asRecord(candidate);
  return catalog ? stringCatalog(catalog.actions ?? catalog.bridgeActions) : null;
};

export const getHostCapabilityPolicy = (
  catalog: readonly string[] | null,
  runtimeUnsupported: readonly string[] = []
): HostCapabilityPolicy => {
  const unavailable = new Set(runtimeUnsupported);
  const state = (action: HostCapabilityAction): HostCapabilityState =>
    unavailable.has(action)
      ? 'unsupported'
      : catalog === null
        ? 'unknown'
        : catalog.includes(action)
          ? 'supported'
          : 'unsupported';

  return {
    'community:queryEvents': state('community:queryEvents'),
    'community:querySharedConfig': state('community:querySharedConfig'),
    'community:publishSharedConfig': state('community:publishSharedConfig'),
    'community:checkWriteCapabilities': state('community:checkWriteCapabilities'),
  };
};

export const hostCanAttempt = (state: HostCapabilityState) => state !== 'unsupported';

export const isUnsupportedCapabilityError = (value: unknown) =>
  asRecord(value)?.code === 'UNSUPPORTED_CAPABILITY';

export const advanceRequestEpoch = (epoch: number) => epoch + 1;

export const requestEpochIsCurrent = (expected: number, current: number) => expected === current;
