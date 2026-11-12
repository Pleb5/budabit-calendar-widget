// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {npubEncode, noteEncode} from 'nostr-tools/nip19';
import type {CommunityWidgetContext, NostrEvent} from 'budabit-sdk';
import {createDescriptionResolver} from './description-resolver';

const key = 'a'.repeat(64);
const other = 'b'.repeat(64);
const event = (content: string): NostrEvent => ({id: 'c'.repeat(64), pubkey: key, kind: 31923,
  created_at: 1, tags: [], sig: '', content});
const context = {contextSessionId: 'test-context', contextVersion: 1,
  relays: ['wss://relay.example'], relayHints: []} as unknown as CommunityWidgetContext;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function host() {
  let onProfiles: (value: unknown) => void = () => {};
  const off = vi.fn();
  const request = vi.fn<(action: string, payload: any) => Promise<any>>().mockResolvedValue({});
  const onEvent = vi.fn((_action: string, handler: (value: unknown) => void) => {
    onProfiles = handler;
    return off;
  });
  return {bridge: {request, onEvent}, request, off, emit: (value: unknown) => onProfiles(value)};
}

it('batches all featured event mentions and keeps live profile updates newer than initial responses', async () => {
  const h = host();
  const changed = vi.fn();
  const resolver = createDescriptionResolver(h.bridge, context, changed);
  resolver.update([event(npubEncode(key)), event(npubEncode(other))]);
  const [action, payload] = h.request.mock.calls[0];
  expect(action).toBe('profiles:resolve');
  expect(payload).toMatchObject({contextSessionId: context.contextSessionId,
    contextVersion: context.contextVersion, pubkeys: [key, other]});
  const profiles = [{pubkey: key, status: 'ready', profile: {pubkey: key, display_name: 'Five'}}];
  h.emit({requestId: payload.requestId, revision: 2, profiles});
  h.emit({requestId: payload.requestId, revision: 1, profiles: []});
  await flush();
  expect(changed.mock.lastCall?.[0].profiles[key].display_name).toBe('Five');
  resolver.update([event(npubEncode(key)), event(npubEncode(other))]);
  expect(h.request).toHaveBeenCalledTimes(1);
  resolver.destroy();
  expect(h.off).toHaveBeenCalledOnce();
});

it('rejects stale profile updates after a community context replacement', async () => {
  const h = host();
  const oldChanges = vi.fn();
  const old = createDescriptionResolver(h.bridge, context, oldChanges);
  old.update([event(npubEncode(key))]);
  const oldId = h.request.mock.calls[0][1].requestId;
  old.destroy();
  const changed = vi.fn();
  const current = createDescriptionResolver(h.bridge, {...context, contextVersion: 2}, changed);
  current.update([event(npubEncode(key))]);
  const newId = h.request.mock.calls[1][1].requestId;
  expect(newId).not.toBe(oldId);
  h.emit({requestId: oldId, revision: 5, profiles: [{pubkey: key, status: 'ready', profile: {name: 'Wrong community'}}]});
  await flush();
  expect(changed).not.toHaveBeenCalled();
  expect(oldChanges).not.toHaveBeenCalled();
  current.destroy();
});

it('loads exact event references once and resolves quote authors through the same profile batch', async () => {
  const h = host();
  const id = 'd'.repeat(64);
  h.request.mockImplementation(async action => action === 'nostr:query'
    ? {events: [{...event('A quoted note'), id, pubkey: other, kind: 1}]} : {});
  const changed = vi.fn();
  const resolver = createDescriptionResolver(h.bridge, context, changed);
  resolver.update([event(noteEncode(id))]);
  await flush();
  expect(h.request).toHaveBeenCalledWith('nostr:query', {
    relays: ['wss://relay.example'], filter: {ids: [id], kinds: [1, 11, 1111, 30023, 30617, 31922, 31923, 32222], limit: 1},
  });
  expect(changed.mock.lastCall?.[0].events[id].content).toBe('A quoted note');
  expect(h.request).toHaveBeenCalledWith('profiles:resolve', expect.objectContaining({pubkeys: [other]}));
  resolver.update([event(noteEncode(id))]);
  expect(h.request.mock.calls.filter(([action]) => action === 'nostr:query')).toHaveLength(1);
  resolver.destroy();
});
