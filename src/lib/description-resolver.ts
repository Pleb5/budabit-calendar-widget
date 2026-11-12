import type {CommunityWidgetContext, NostrEvent, WidgetBridge} from 'budabit-sdk';
import {renderEventDescription} from './event-description';
import {emptyContentState, eventDescription, PREVIEW_KINDS, type ContentProfile, type ContentState, type NostrReference} from './nostr-content';

let resolverSequence = 0;

export function createDescriptionResolver(
  bridge: Pick<WidgetBridge, 'request' | 'onEvent'>,
  context: CommunityWidgetContext,
  changed: (state: ContentState) => void,
) {
  let state = emptyContentState();
  const resolverId = ++resolverSequence;
  let active = true;
  let profileRequest = '';
  let profileRevision = -1;
  let sequence = 0;
  let profileKey = '';
  const references = new Map<string, NostrReference>();
  const requested = new Set<string>();
  const queue: NostrReference[] = [];
  let running = 0;
  const scope = {contextSessionId: context.contextSessionId, contextVersion: context.contextVersion};
  const notify = () => { if (active) changed({...state, profiles: {...state.profiles}, events: {...state.events}}); };

  function acceptProfiles(value: unknown) {
    const response = value as {requestId?: string; revision?: number; profiles?: {pubkey: string; status: string; profile?: ContentProfile}[]};
    if (!active || response?.requestId !== profileRequest || !Array.isArray(response.profiles)) return;
    if (typeof response.revision !== 'number' || response.revision <= profileRevision) return;
    profileRevision = response.revision;
    for (const item of response.profiles) {
      if (item.status === 'ready' && /^[0-9a-f]{64}$/.test(item.pubkey) && item.profile) {
        state.profiles[item.pubkey] = item.profile;
      }
    }
    notify();
  }

  function resolveProfiles() {
    const pubkeys = [...new Set([
      ...[...references.values()].filter(ref => ref.type === 'profile').map(ref => ref.pubkey!),
      ...Object.values(state.events).map(event => event.pubkey),
    ])].sort().slice(0, 512);
    const key = pubkeys.join(',');
    if (!pubkeys.length || key === profileKey) return;
    profileKey = key;
    profileRequest = `calendar-content-${resolverId}-${++sequence}`;
    profileRevision = -1;
    void bridge.request('profiles:resolve', {...scope, requestId: profileRequest, pubkeys})
      .then(acceptProfiles).catch(() => {});
  }

  async function resolveQuote(reference: NostrReference) {
    const kinds = reference.kind === undefined ? PREVIEW_KINDS : [reference.kind];
    if (kinds.some(kind => !PREVIEW_KINDS.includes(kind))) return;
    const relays = [...new Set([...reference.relays, ...(context.relays || []), ...(context.relayHints || [])])]
      .filter(relay => /^wss?:\/\//.test(relay)).slice(0, 8);
    if (!relays.length) return;
    const filter = reference.id ? {ids: [reference.id], kinds, limit: 1} :
      {kinds, authors: [reference.pubkey!], '#d': [reference.identifier!], limit: 1};
    try {
      const result = await bridge.request('nostr:query', {relays, filter}) as {events?: NostrEvent[]};
      if (!active || !Array.isArray(result?.events)) return;
      const event = result.events.filter(event => reference.id ? event.id === reference.id :
        event.kind === reference.kind && event.pubkey === reference.pubkey &&
        event.tags.some(tag => tag[0] === 'd' && tag[1] === reference.identifier))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
      if (!event) return;
      state.events[reference.key] = event;
      renderEventDescription(eventDescription(event), {references});
      notify();
      resolveProfiles();
    } catch { /* Keep a working host link when a preview is unavailable. */ }
  }

  function pump() {
    while (active && running < 3 && queue.length) {
      const reference = queue.shift()!;
      running++;
      void resolveQuote(reference).finally(() => { running--; pump(); });
    }
  }

  const offProfiles = bridge.onEvent('profiles:updated', acceptProfiles);
  return {
    update(events: NostrEvent[]) {
      if (!active) return;
      references.clear();
      for (const event of events) renderEventDescription(eventDescription(event), {references, state});
      resolveProfiles();
      for (const reference of [...references.values()].filter(ref => ref.type !== 'profile').slice(0, 16)) {
        if (requested.has(reference.key)) continue;
        requested.add(reference.key);
        queue.push(reference);
      }
      pump();
    },
    destroy() { active = false; queue.length = 0; offProfiles(); },
  };
}
