import {describe, expect, it} from 'vitest';
import type {NostrEvent} from 'budabit-sdk';
import {
  DEFAULT_HEADER,
  EVENT_DATE,
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
  formatCalendarEventDate,
  getCalendarEventRouteId,
  getDateEventInclusiveEnd,
  getHostCapabilityCatalog,
  getHostCapabilityPolicy,
  getRetryDelay,
  isBlockingRequestError,
  isConfigRevisionConflict,
  isUnsupportedCapabilityError,
  matchesEventRef,
  mergeCalendarEvents,
  mergeCalendarEditorEvents,
  mergeCalendarEventsForRefs,
  normalizeWidgetConfig,
  planEventQueries,
  requestEpochIsCurrent,
  resolveSharedWidgetConfig,
  retainRequestValue,
  selectCalendarPickerEvents,
  getSharedConfigRevision,
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

  it('retains selected events when broad editor discovery omits them', () => {
    const selected = event({id: '4'.repeat(64), tags: [['d', 'selected']]});
    const discovered = event({id: '3'.repeat(64), tags: [['d', 'discovered']]});

    expect(
      mergeCalendarEditorEvents([selected.id], [selected], [], [discovered]).map(({id}) => id)
    ).toEqual([selected.id, discovered.id]);
    expect(
      mergeCalendarEditorEvents(['selected'], [selected], [], [discovered]).map(({id}) => id)
    ).toContain(selected.id);
  });

  it('bounds picker candidates, drops completed events, and retains selected history', () => {
    const completed = event({
      id: '4'.repeat(64),
      tags: [['d', 'completed'], ['start', '100'], ['end', '200']],
    });
    const selectedCompleted = event({
      id: '3'.repeat(64),
      tags: [['d', 'selected-completed'], ['start', '100'], ['end', '200']],
    });
    const upcoming = event({
      id: '2'.repeat(64),
      tags: [['d', 'upcoming'], ['start', '2000'], ['end', '2100']],
    });
    const later = event({
      id: '5'.repeat(64),
      tags: [['d', 'later'], ['start', '3000'], ['end', '3100']],
    });

    expect(
      selectCalendarPickerEvents(
        [completed, selectedCompleted, upcoming, later],
        [selectedCompleted.id],
        1000,
        2
      ).map(({id}) => id)
    ).toEqual([selectedCompleted.id, upcoming.id]);
  });
});

describe('calendar semantics', () => {
  it('treats date-event ends as exclusive calendar dates', () => {
    const dateEvent = event({
      kind: EVENT_DATE,
      tags: [['d', 'conference'], ['start', '2026-03-07'], ['end', '2026-03-10']],
    });

    expect(getDateEventInclusiveEnd(dateEvent)).toBe('2026-03-09');
    expect(formatCalendarEventDate(dateEvent)).toBe('2026-03-07 to 2026-03-09');

    const oneDay = event({
      kind: EVENT_DATE,
      tags: [['d', 'one-day'], ['start', '2026-03-07']],
    });
    expect(getDateEventInclusiveEnd(oneDay)).toBe('2026-03-07');
    expect(formatCalendarEventDate(oneDay)).toBe('2026-03-07');
  });

  it('uses calendar dates across DST when filtering date events', () => {
    const dateEvent = event({
      kind: EVENT_DATE,
      tags: [['d', 'dst'], ['start', '2026-03-08'], ['end', '2026-03-09']],
    });
    const noonOnStart = Math.floor(new Date(2026, 2, 8, 12).getTime() / 1000);
    const noonAfterEnd = Math.floor(new Date(2026, 2, 9, 12).getTime() / 1000);

    expect(selectCalendarPickerEvents([dateEvent], [], noonOnStart, 10)).toEqual([dateEvent]);
    expect(selectCalendarPickerEvents([dateEvent], [], noonAfterEnd, 10)).toEqual([]);
  });

  it('always displays local time for timed events at UTC midnight', () => {
    const midnight = event({
      tags: [['d', 'midnight'], ['start', '1780272000']],
    });

    expect(formatCalendarEventDate(midnight, 'en-US', 'UTC')).toMatch(/12:00 AM/);
    expect(formatCalendarEventDate(midnight, 'en-US', 'America/New_York')).toMatch(/8:00 PM/);
  });

  it('routes by exact ID and extracts config revisions', () => {
    const value = event({id: '2'.repeat(64), tags: [['d', 'duplicate']]});
    const duplicate = event({
      id: '3'.repeat(64),
      pubkey: 'b'.repeat(64),
      tags: [['d', 'duplicate']],
    });
    expect(getCalendarEventRouteId(value)).toBe(value.id);
    expect(getCalendarEventRouteId(duplicate)).toBe(duplicate.id);
    expect(getCalendarEventRouteId(value)).not.toBe(getCalendarEventRouteId(duplicate));
    expect(getSharedConfigRevision({event: value})).toBe(value.id);
    expect(getSharedConfigRevision({status: 'ok'})).toBeNull();
    expect(isConfigRevisionConflict({code: 'CONFIG_REVISION_CONFLICT'})).toBe(true);
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
