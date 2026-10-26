// Run with the widget Vite server. hostSource points at the reviewed Budabit checkout
// (for example /@fs/.../src/app/extensions/exact-ref-resolution.ts).
export {};
const params = new URLSearchParams(location.search);
const source = params.get('hostSource');
if (!source?.startsWith('/@fs/')) throw new Error('Supply the local hostSource resolver path');
const {resolveExactRefs, exactRefDeletionFilters} = await import(/* @vite-ignore */ source);
const {finalizeEvent, getPublicKey} = await import(/* @vite-ignore */ params.get('nostrSource')!);
const key = new Uint8Array(32).fill(52); // public disposable fixture identity
const author = getPublicKey(key);
const refs = ['first', 'second'].map(d => `31923:${author}:${d}`);
const now = Number(params.get('now')) || Math.floor(Date.now() / 1000);
const deleted = refs.map(ref => finalizeEvent({kind: 5, created_at: now - 10, tags: [['a', ref]], content: ''}, key));
const mode = params.get('mode') || 'fixed';
const events = mode === 'mixed' ? [finalizeEvent({kind: 31923, created_at: now, tags: [['d', 'first'], ['title', 'Explicit past featured event'], ['start', '1700000000']], content: ''}, key)] : [];
const context = {communityAddress: `32222:${author}:fixture`, communityId: 'fixture', ownerPubkey: author, relays: ['wss://fixture.invalid'], contextSessionId: 'fixture', contextVersion: 1};
const frame = document.querySelector('iframe')!;
const trace: unknown[] = [];
(window as any).fixtureTrace = trace;
// Opt-in transport for the host repository's MockRelay Playwright regression.
// Both names are reserved .invalid domains; the test intercepts every connection.
const queryRelay = (url: string, filters: unknown[]) => new Promise<{events: any[]; complete: boolean}>(resolve => {
  const socket = new WebSocket(url);
  const received: any[] = [];
  let settled = false;
  const finish = (complete: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.close();
    resolve({events: received, complete});
  };
  const timer = setTimeout(() => finish(false), 250);
  socket.onopen = () => socket.send(JSON.stringify(['REQ', 'featured', ...filters]));
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message[0] === 'EVENT') received.push(message[2]);
    if (message[0] === 'EOSE') finish(true);
    if (message[0] === 'CLOSED') finish(false);
  };
  socket.onerror = () => finish(false);
  socket.onclose = () => finish(false);
});
window.addEventListener('message', async event => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data;
  const send = (message: unknown) => frame.contentWindow!.postMessage(message, '*');
  if (msg.action === 'widget:ready') {
    send({type: 'event', action: 'widget:init', payload: {theme: 'light', communityContext: context}});
    return;
  }
  if (msg.type !== 'request') return;
  let payload: any = {status: 'ok', contextSessionId: 'fixture', contextVersion: 1};
  if (msg.action === 'community:querySharedConfig') payload = {...payload, config: {header: 'Featured events', eventRefs: refs}};
  else if (msg.action === 'community:checkWriteCapabilities') payload = {...payload, capabilities: []};
  else if (msg.action === 'community:queryEvents') {
    trace.push(msg.payload);
    let result = resolveExactRefs(refs, events, mode === 'missing' ? [] : deleted, mode === 'missing');
    if (params.get('transport') === 'mock') {
      const filters = refs.map(ref => ({kinds: [31923], authors: [author], '#d': [ref.split(':')[2]], limit: 1}));
      const responses = await Promise.all(['wss://featured.invalid', 'wss://incomplete.invalid'].map(url => queryRelay(url, [...filters, ...exactRefDeletionFilters(filters)])));
      const received = responses.flatMap(response => response.events);
      result = resolveExactRefs(refs, received.filter(event => event.kind === 31923), received.filter(event => event.kind === 5), responses.every(response => response.complete));
    }
    payload = mode === 'baseline' || mode === 'timeout' ? {error: 'Community query timed out', code: 'COMMUNITY_QUERY_TIMEOUT'} : {...payload, ...result, hasMore: false};
    document.querySelector('#trace')!.textContent = JSON.stringify(trace, null, 2);
  } else if (msg.action !== 'ui:resize') payload = {error: 'Fixture denies this action', code: 'FORBIDDEN'};
  send({type: 'response', id: msg.id, action: msg.action, payload});
});
frame.src = mode === 'baseline' ? './.artifacts/baseline.html' : '/';
