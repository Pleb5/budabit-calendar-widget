// Deterministic, view-only widget protocol. No relay connections or signing.
const frame = document.querySelector('iframe')!;
if (new URLSearchParams(location.search).has('built')) frame.src = '/dist/index.html';
const pubkey = 'a'.repeat(64);
const ref = `31923:${pubkey}:demo-day`;
const context = {
  contextSessionId: 'calendar-layout', contextVersion: 1,
  communityId: 'calendar-layout', naddr: 'calendar-layout',
  definitionAddress: `32222:${pubkey}:calendar-layout`,
  profile: {name: 'BudaBit'}, viewer: {pubkey, isOwner: true, isBanned: false},
  sections: [{name: 'Events', kinds: [{kind: 31923}, {kind: 31922}]}],
};
const event = {
  id: 'b'.repeat(64), pubkey, kind: 31923, created_at: 1, sig: '',
  tags: [['d', 'demo-day'], ['title', 'BudaBit Demo Day'], ['start', '1794582000'], ['location', 'Online']],
  content: '![BudaBit Demo Day — cypherpunk builders presenting in a fantasy guildhall](/tests/fixtures/banner.svg)\n\n' +
    'Demo your awesome **Freedom Tech** projects. Meet the community and share what you are building.\n\n' +
    '[Event details](https://example.com/' + 'very-long-address-'.repeat(20) + ')\n\n' +
    'https://example.com/' + 'unbroken-content-'.repeat(24),
};
window.addEventListener('message', ({source, origin, data}) => {
  if (source !== frame.contentWindow || origin !== location.origin) return;
  const {type, action, id, payload} = data || {};
  const post = (type: string, payload: unknown) => frame.contentWindow?.postMessage({type, action, id, payload}, origin);
  if (type === 'event' && action === 'widget:ready') {
    frame.contentWindow?.postMessage({type: 'event', action: 'widget:init', payload: {
      communityContext: context, theme: 'dark', appOrigin: location.origin,
      capabilities: {actions: ['community:querySharedConfig', 'community:queryEvents',
        'community:checkWriteCapabilities', 'community:publishSharedConfig', 'ui:resize']},
    }}, origin);
  } else if (type === 'request') {
    const identity = {contextSessionId: context.contextSessionId, contextVersion: context.contextVersion};
    if (action === 'community:querySharedConfig') post('response', {...identity,
      config: {header: 'Featured events', eventRefs: [ref]}, event: {id: 'fixture-config'}});
    else if (action === 'community:queryEvents') post('response', {...identity, events: [event]});
    else if (action === 'community:checkWriteCapabilities') post('response', {...identity, capabilities: []});
    else if (action === 'ui:resize') {
      frame.style.height = `${payload.height}px`;
      post('response', {status: 'ok'});
    } else post('response', {error: `Unsupported fixture request: ${action}`});
  }
});
