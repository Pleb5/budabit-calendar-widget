import {describe, expect, it} from 'vitest';
import type {NostrEvent} from 'budabit-sdk';
import {
  DEFAULT_HEADER,
  EVENT_TIME,
  advanceRequestEpoch,
  beginRequest,
  canonicalizeEventRefs,
  classifyCommunityError,
  classifyEventRef,
  classifySharedWidgetConfig,
  collapseCalendarEventReplacements,
  createRequestState,
  failRequest,
  getHostCapabilityCatalog,
  getHostCapabilityPolicy,
  getRetryDelay,
  isBlockingRequestError,
  isUnsupportedCapabilityError,
  matchesEventRef,
  mergeCalendarEvents,
  mergeCalendarEventsForRefs,
  normalizeWidgetConfig,
  planEventQueries,
  requestEpochIsCurrent,
  resolveSharedWidgetConfig,
  retainRequestValue,
} from './compatibility';

const author = 'a'.repeat(64);

const event = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: '1'.repeat(64),
  pubkey: author,
  created_at: 100,
  kind: EVENT_TIME,
  content: '',
  sig: 'f'.repeat(128),
  tags: [['d', 'community-call']],
  ...overrides,
});

describe('featured event refs', () => {
  it('classifies IDs and full addresses as canonical and bare d values as legacy', () => {
    expect(classifyEventRef('A'.repeat(64))).toEqual({type: 'id', value: 'a'.repeat(64)});
    expect(classifyEventRef(`${EVENT_TIME}:${author.toUpperCase()}:community-call`)).toMatchObject({
      type: 'address',
      value: `${EVENT_TIME}:${author}:community-call`,
    });
    expect(classifyEventRef('community-call')).toEqual({type: 'legacy', value: 'community-call'});
  });

  it('queries canonical refs first and discovers broadly for legacy or unresolved refs', () => {
    const address = `${EVENT_TIME}:${author}:community-call`;
    expect(planEventQueries([address], [event()])).toMatchObject({
      canonicalRefs: [address],
      legacyRefs: [],
      needsBroadDiscovery: false,
    });
    expect(planEventQueries([address], [])).toMatchObject({
      unresolvedCanonicalRefs: [address],
      needsBroadDiscovery: true,
    });
    expect(planEventQueries(['community-call'], [])).toMatchObject({
      canonicalRefs: [],
      legacyRefs: ['community-call'],
      needsBroadDiscovery: true,
    });
  });

  it('matches and canonicalizes legacy refs without dropping ambiguous matches', () => {
    const external = event({id: '2'.repeat(64), pubkey: 'b'.repeat(64)});
    expect(matchesEventRef(external, 'community-call')).toBe(true);
    expect(canonicalizeEventRefs(['community-call'], [event(), external])).toEqual([
      `${EVENT_TIME}:${author}:community-call`,
      `${EVENT_TIME}:${'b'.repeat(64)}:community-call`,
    ]);
  });
});

describe('calendar replacement collapse', () => {
  it('keeps the newest addressable replacement and uses the lower ID as a stable tie-break', () => {
    const old = event({id: '4'.repeat(64), created_at: 100});
    const tiedHigh = event({id: '3'.repeat(64), created_at: 200});
    const tiedLow = event({id: '2'.repeat(64), created_at: 200});
    expect(collapseCalendarEventReplacements([old, tiedHigh, tiedLow])).toEqual([tiedLow]);
  });

  it('merges exact and broad results while deduplicating replacements', () => {
    const exact = event({id: '4'.repeat(64), created_at: 100});
    const broad = event({id: '3'.repeat(64), created_at: 200});
    const other = event({
      id: '2'.repeat(64),
      pubkey: 'b'.repeat(64),
      tags: [['d', 'external-call']],
    });
    expect(mergeCalendarEvents([exact], [broad, other]).map(({id}) => id)).toEqual([
      broad.id,
      other.id,
    ]);
  });

  it('pins explicitly selected IDs while address refs resolve the newest replacement', () => {
    const selectedId = event({id: '4'.repeat(64), created_at: 100});
    const replacement = event({id: '3'.repeat(64), created_at: 200});
    const address = `${EVENT_TIME}:${author}:community-call`;

    expect(
      mergeCalendarEventsForRefs([selectedId.id], [selectedId], [replacement]).map(({id}) => id)
    ).toEqual([selectedId.id, replacement.id]);
    expect(
      mergeCalendarEventsForRefs([address], [selectedId], [replacement]).map(({id}) => id)
    ).toEqual([replacement.id]);
    expect(
      matchesEventRef(
        mergeCalendarEventsForRefs([selectedId.id], [selectedId], [replacement])[0],
        selectedId.id
      )
    ).toBe(true);
  });
});

describe('widget config normalization', () => {
  it('accepts an intentionally empty shared selection', () => {
    expect(normalizeWidgetConfig({header: 'Nothing featured', eventRefs: []})).toEqual({
      header: 'Nothing featured',
      eventRefs: [],
    });
  });

  it('reads legacy eventRef and safely rejects malformed eventRefs', () => {
    expect(normalizeWidgetConfig({header: 42, eventRef: 'community-call'})).toEqual({
      header: DEFAULT_HEADER,
      eventRefs: ['community-call'],
    });
    expect(normalizeWidgetConfig({header: 'Broken', eventRefs: 'community-call'})).toBeNull();
    expect(normalizeWidgetConfig({header: 'Broken', eventRefs: [42]})).toBeNull();
    expect(normalizeWidgetConfig({header: 'Missing refs'})).toBeNull();
  });

  it('distinguishes an absent shared config from an intentionally empty one', () => {
    expect(classifySharedWidgetConfig({status: 'ok'})).toEqual({status: 'absent'});
    expect(classifySharedWidgetConfig({config: {header: 'Empty', eventRefs: []}})).toEqual({
      status: 'valid',
      config: {header: 'Empty', eventRefs: []},
    });
    expect(classifySharedWidgetConfig({config: undefined})).toEqual({status: 'invalid'});
  });

  it('keeps valid empty config authoritative and recovers malformed config safely', () => {
    const fallback = {header: 'Legacy events', eventRefs: ['legacy-event']};
    const previous = {header: 'Previously loaded', eventRefs: ['previous-event']};

    expect(
      resolveSharedWidgetConfig({config: {header: 'Empty', eventRefs: []}}, fallback, previous)
    ).toEqual({
      status: 'valid',
      source: 'shared',
      config: {header: 'Empty', eventRefs: []},
    });
    expect(resolveSharedWidgetConfig({status: 'ok'}, fallback, previous)).toEqual({
      status: 'absent',
      source: 'fallback',
      config: fallback,
    });
    expect(resolveSharedWidgetConfig({config: {eventRefs: 'broken'}}, fallback, previous)).toEqual({
      status: 'invalid',
      source: 'previous',
      config: previous,
    });
    expect(resolveSharedWidgetConfig({config: null}, fallback)).toEqual({
      status: 'invalid',
      source: 'fallback',
      config: fallback,
    });
  });
});

describe('request retry policy', () => {
  it.each(['COMMUNITY_CONTEXT_NOT_READY', 'COMMUNITY_QUERY_TIMEOUT'])(
    'retries %s with bounded exponential backoff',
    (code) => {
      const first = failRequest(beginRequest(createRequestState(), 1), {error: code, code});
      expect(classifyCommunityError({code})).toBe('transient');
      expect(first.state.phase).toBe('retrying');
      expect(first.retryDelayMs).toBe(1000);
      expect(getRetryDelay(20)).toBe(8000);

      const exhausted = failRequest(beginRequest(first.state, 4), {error: code, code});
      expect(exhausted.state.phase).toBe('error');
      expect(exhausted.retryDelayMs).toBeNull();
    }
  );

  it('settles terminal errors immediately while preserving a prior value', () => {
    const failed = failRequest(beginRequest(createRequestState(true), 1), {
      error: 'Permission denied',
      code: 'FORBIDDEN',
    });
    expect(failed.state).toMatchObject({phase: 'error', hasValue: true, error: 'Permission denied'});
  });

  it('keeps exact partial results nonblocking when broad discovery exhausts', () => {
    const partial = retainRequestValue(beginRequest(createRequestState(), 4));
    const exhausted = failRequest(partial, {
      error: 'Community relay query is still loading',
      code: 'COMMUNITY_QUERY_TIMEOUT',
    });
    expect(exhausted.state).toMatchObject({phase: 'error', hasValue: true});
    expect(isBlockingRequestError(exhausted.state)).toBe(false);
  });
});

describe('host capability states', () => {
  it('keeps an absent catalog optimistic and unknown', () => {
    expect(getHostCapabilityPolicy(getHostCapabilityCatalog({}))).toEqual({
      'community:queryEvents': 'unknown',
      'community:querySharedConfig': 'unknown',
      'community:publishSharedConfig': 'unknown',
      'community:checkWriteCapabilities': 'unknown',
    });
  });

  it('treats a present catalog additively', () => {
    const catalog = getHostCapabilityCatalog({
      capabilities: {
        actions: ['community:queryEvents', 'community:checkWriteCapabilities'],
      },
    });
    expect(getHostCapabilityPolicy(catalog)).toEqual({
      'community:queryEvents': 'supported',
      'community:querySharedConfig': 'unsupported',
      'community:publishSharedConfig': 'unsupported',
      'community:checkWriteCapabilities': 'supported',
    });
  });

  it('lets runtime unsupported responses narrow an absent or optimistic catalog', () => {
    expect(
      getHostCapabilityPolicy(null, ['community:querySharedConfig'])[
        'community:querySharedConfig'
      ]
    ).toBe('unsupported');
    expect(
      isUnsupportedCapabilityError({code: 'UNSUPPORTED_CAPABILITY', error: 'Not supported'})
    ).toBe(true);
    expect(isUnsupportedCapabilityError({code: 'FORBIDDEN'})).toBe(false);
  });
});

describe('request epochs', () => {
  it('rejects config responses from before save and requests started during save', () => {
    let current = 3;
    const beforeSave = current;
    current = advanceRequestEpoch(current);
    expect(requestEpochIsCurrent(beforeSave, current)).toBe(false);

    const duringSave = current;
    current = advanceRequestEpoch(current);
    expect(requestEpochIsCurrent(duringSave, current)).toBe(false);
    expect(requestEpochIsCurrent(current, current)).toBe(true);
  });
});
