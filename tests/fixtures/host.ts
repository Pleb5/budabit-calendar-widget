// Deterministic, view-only widget protocol. No relay connections or signing.
import {npubEncode, nprofileEncode, noteEncode, naddrEncode} from 'nostr-tools/nip19';
const frame = document.querySelector('iframe')!;
if (new URLSearchParams(location.search).has('built')) frame.src = '/dist/index.html';
const pubkey = 'a'.repeat(64);
const five = 'd04ecf33a303a59852fdb681ed8b412201ba85d8d2199aec73cb62681d62aa90';
const other = 'e'.repeat(64);
const quoteId = 'f'.repeat(64);
const article = naddrEncode({kind: 30023, pubkey: five, identifier: 'builders'});
const ref = `31923:${pubkey}:demo-day`;
const context = {
  contextSessionId: 'calendar-layout', contextVersion: 1,
  communityId: 'calendar-layout', naddr: 'calendar-layout',
  relays: ['wss://fixture.invalid'], relayHints: [],
  definitionAddress: `32222:${pubkey}:calendar-layout`,
  profile: {name: 'BudaBit'}, viewer: {pubkey, isOwner: true, isBanned: false},
  sections: [{name: 'Events', kinds: [{kind: 31923}, {kind: 31922}]}],
};
const event = {
  id: 'b'.repeat(64), pubkey, kind: 31923, created_at: 1, sig: '',
  tags: [['d', 'demo-day'], ['title', 'BudaBit Demo Day'], ['start', '1794582000'], ['location', 'Online']],
  content: '![BudaBit Demo Day — cypherpunk builders presenting in a fantasy guildhall](/tests/fixtures/banner.svg)\n\n' +
    'Demo your awesome **Freedom Tech** projects. Meet the community and share what you are building.\n\n' +
    `Host: ${npubEncode(five)}\n\nCo-host: nostr:${nprofileEncode({pubkey: other})}\n\n` +
    `[Message the host](nostr:${npubEncode(five)})\n\n${noteEncode(quoteId)}\n\n${article}\n\n` +
    '[Event details](https://example.com/' + 'very-long-address-'.repeat(20) + ')',
};
const fixture = {
  profiles: [] as any[], actions: [] as any[],
  updateName(name: string) {
    const payload = this.profiles.at(-1);
    if (payload) frame.contentWindow?.postMessage({type: 'event', action: 'profiles:updated', payload: {
      requestId: payload.requestId, revision: 5,
      profiles: [{pubkey: five, status: 'ready', profile: {pubkey: five, display_name: name,
        picture: '/tests/fixtures/banner.svg'}}],
    }}, location.origin);
  },
};
declare global { interface Window { calendarFixture: typeof fixture } }
window.calendarFixture = fixture;
window.addEventListener('message', ({source, origin, data}) => {
  if (source !== frame.contentWindow || origin !== location.origin) return;
  const {type, action, id, payload} = data || {};
  const post = (type: string, payload: unknown) => frame.contentWindow?.postMessage({type, action, id, payload}, origin);
  if (type === 'event' && action === 'widget:ready') {
    frame.contentWindow?.postMessage({type: 'event', action: 'widget:init', payload: {
      communityContext: context, theme: 'dark', appOrigin: location.origin,
      capabilities: {actions: ['community:querySharedConfig', 'community:queryEvents',
        'community:checkWriteCapabilities', 'community:publishSharedConfig', 'ui:resize',
        'profiles:resolve', 'ui:openProfile', 'nostr:query', 'ui:navigate']},
    }}, origin);
  } else if (type === 'request') {
    const identity = {contextSessionId: context.contextSessionId, contextVersion: context.contextVersion};
    if (action === 'community:querySharedConfig') post('response', {...identity,
      config: {header: 'Featured events', eventRefs: [ref]}, event: {id: 'fixture-config'}});
    else if (action === 'community:queryEvents') post('response', {...identity, events: [event]});
    else if (action === 'community:checkWriteCapabilities') post('response', {...identity, capabilities: []});
    else if (action === 'profiles:resolve') {
      fixture.profiles.push(payload);
      post('response', {status: 'ok', requestId: payload.requestId, revision: 0, profiles:
        payload.pubkeys.map((key: string) => ({pubkey: key, status: 'ready', profile: {pubkey: key,
          display_name: key === five ? 'Five' : 'Builder', picture: '/tests/fixtures/banner.svg'}}))});
    } else if (action === 'nostr:query') {
      post('response', {status: 'ok', complete: true, events: payload.filter.ids ? [{
        ...event, id: quoteId, pubkey: five, kind: 1, tags: [], content: 'Come build **Freedom Tech** together!',
      }] : [{...event, pubkey: five, kind: 30023, tags: [['d', 'builders'], ['title', 'Building in the open']],
        content: 'A community article with a [project link](https://example.com).'}]});
    } else if (action === 'ui:openProfile' || action === 'ui:navigate') {
      fixture.actions.push({action, payload});
      post('response', {status: 'ok'});
    }
    else if (action === 'ui:resize') {
      frame.style.height = `${payload.height}px`;
      post('response', {status: 'ok'});
    } else post('response', {error: `Unsupported fixture request: ${action}`});
  }
});
