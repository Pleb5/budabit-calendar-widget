import {decode, npubEncode} from 'nostr-tools/nip19';
import type {TokenizerAndRendererExtension, Tokens} from 'marked';
import type {NostrEvent} from 'budabit-sdk';

export const PREVIEW_KINDS = [1, 11, 1111, 30023, 30617, 31922, 31923, 32222];
export type ContentProfile = {pubkey: string; name?: string; display_name?: string; picture?: string};
export type ContentState = {
  profiles: Record<string, ContentProfile>;
  events: Record<string, NostrEvent>;
};
export const emptyContentState = (): ContentState => ({profiles: {}, events: {}});
export type NostrReference = {
  entity: string;
  key: string;
  type: 'profile' | 'event' | 'address';
  pubkey?: string;
  id?: string;
  kind?: number;
  identifier?: string;
  relays: string[];
};

export function parseNostrReference(value: string): NostrReference | undefined {
  const entity = value.trim().replace(/^nostr:\s*/i, '');
  try {
    const result = decode(entity);
    if (result.type === 'npub' || result.type === 'nprofile') {
      const pubkey = result.type === 'npub' ? result.data : result.data.pubkey;
      return {entity, key: pubkey, type: 'profile', pubkey,
        relays: result.type === 'nprofile' ? result.data.relays || [] : []};
    }
    if (result.type === 'note' || result.type === 'nevent') {
      const pointer = result.type === 'note' ? {id: result.data} : result.data;
      return {entity, key: pointer.id, type: 'event', ...pointer, relays: pointer.relays || []};
    }
    if (result.type === 'naddr') {
      const {kind, pubkey, identifier, relays = []} = result.data;
      return {entity, key: `${kind}:${pubkey}:${identifier}`, type: 'address',
        kind, pubkey, identifier, relays};
    }
  } catch { /* Invalid identifiers remain ordinary text. */ }
}

// Match the normal calendar Markdown renderer's standalone-token boundaries.
// This deliberately excludes identifiers inside URLs and ordinary words.
const before = /[\s([{<"'`]/;
const after = /[\s)\]}>"'`.,!?;:]/;
export function findNostrReference(source: string) {
  const pattern = /(?:nostr:\s*)?n(?:event|ote|pub|profile|addr)1[ac-hj-np-z02-9]{6,}/gi;
  for (const match of source.matchAll(pattern)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (start > 0 && !before.test(source[start - 1])) continue;
    if (end < source.length && !after.test(source[end])) continue;
    if (/[?#]/.test(source[end] || '') && source[end + 1] && !after.test(source[end + 1])) continue;
    const reference = parseNostrReference(match[0]);
    if (reference) return {index: start, raw: match[0], reference};
  }
}

export function createNostrExtension(
  render: (reference: NostrReference) => string,
): TokenizerAndRendererExtension {
  return {
    name: 'nostr', level: 'inline',
    start: source => findNostrReference(source)?.index,
    tokenizer(source) {
      const found = findNostrReference(source);
      if (found?.index === 0) return {type: 'nostr', raw: found.raw, reference: found.reference};
    },
    renderer: token => render((token as Tokens.Generic).reference as NostrReference),
  };
}

export function entityPath(reference: NostrReference) {
  const prefix = reference.type === 'profile' ? '/people/' : reference.kind === 32222 ? '/c/' : '/';
  return `${prefix}${encodeURIComponent(reference.entity)}`;
}

export function profileLabel(pubkey: string, profile?: ContentProfile) {
  const name = profile?.display_name?.trim() || profile?.name?.trim();
  const fallback = npubEncode(pubkey);
  return `@${name || `${fallback.slice(0, 12)}…${fallback.slice(-6)}`}`;
}

export function eventDescription(event: Pick<NostrEvent, 'content' | 'tags'>) {
  return event.content.trim() ||
    event.tags.find(tag => tag[0] === 'description')?.[1]?.trim() ||
    event.tags.find(tag => tag[0] === 'summary')?.[1]?.trim() || '';
}
