// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {renderEventDescription} from './event-description';
import {npubEncode, nprofileEncode, noteEncode, neventEncode, naddrEncode} from 'nostr-tools/nip19';
import {emptyContentState, eventDescription} from './nostr-content';

const pubkey = 'd04ecf33a303a59852fdb681ed8b412201ba85d8d2199aec73cb62681d62aa90';
const npub = npubEncode(pubkey);
const read = (content: string, options = {}) => {
  const element = document.createElement('div');
  element.innerHTML = renderEventDescription(content, options);
  return element;
};

describe('calendar event descriptions', () => {
  it('renders bare, URI, nprofile, and Markdown-linked mentions with host names and avatars', () => {
    const state = emptyContentState();
    state.profiles[pubkey] = {pubkey, display_name: 'Five', picture: 'https://example.com/avatar.png'};
    const nprofile = nprofileEncode({pubkey, relays: ['wss://relay.example']});
    const element = read(`Host: ${npub}\n\nnostr:${npub}, nostr:${nprofile}! [Host](nostr:${npub})`, {
      state, appOrigin: 'https://budabit.club',
    });
    const mentions = [...element.querySelectorAll('a[data-profile]')];
    expect(mentions).toHaveLength(4);
    for (const mention of mentions) {
      expect(mention.textContent).toBe('@Five');
      expect(mention.getAttribute('href')).toMatch(/^https:\/\/budabit.club\/people\//);
      expect(mention.querySelector('img')?.getAttribute('src')).toBe('https://example.com/avatar.png');
    }
  });

  it('uses compact, clickable fallbacks and hydrates missing profiles without exposing HTML', () => {
    const initial = read(`Host: ${npub}`);
    expect(initial.querySelector('a')?.textContent).toMatch(/^@npub1.*…/);
    expect(initial.textContent).not.toContain(npub);
    const state = emptyContentState();
    state.profiles[pubkey] = {pubkey, name: '<img src=x onerror=alert(1)>', picture: 'javascript:alert(1)'};
    const updated = read(npub, {state});
    expect(updated.querySelector('a')?.textContent).toBe('@<img src=x onerror=alert(1)>');
    expect(updated.querySelector('img, script, [onerror]')).toBeNull();
  });

  it('leaves code, malformed identifiers, and npubs in ordinary URLs untouched', () => {
    const invalid = `${npub.slice(0, -1)}${npub.endsWith('a') ? 'b' : 'a'}`;
    const element = read(`\`${npub}\`\n\n\`\`\`text\nnostr:${npub}\n\`\`\`\n\n${invalid}\n\nhttps://example.com/${npub}`);
    expect(element.querySelectorAll('[data-profile]')).toHaveLength(0);
    expect(element.querySelectorAll('code')).toHaveLength(2);
    expect(element.textContent).toContain(invalid);
    expect(element.querySelector('a')?.getAttribute('href')).toBe(`https://example.com/${npub}`);
  });

  it('renders note, event, and address references as working host links and loaded quote cards', () => {
    const id = 'b'.repeat(64);
    const note = noteEncode(id);
    const nevent = neventEncode({id, relays: ['wss://relay.example']});
    const address = naddrEncode({pubkey, kind: 30023, identifier: 'demo'});
    const community = naddrEncode({pubkey, kind: 32222, identifier: pubkey});
    const references = new Map();
    const initial = read(`${note}\n\n${nevent}\n\n[Article](nostr:${address})\n\n${community}`, {references});
    expect(initial.querySelectorAll('[data-path]')).toHaveLength(4);
    expect(initial.querySelector(`[data-path^="/c/"]`)).not.toBeNull();
    expect(references.size).toBe(3);
    const state = emptyContentState();
    state.events[id] = {id, pubkey, kind: 1, content: '**Hello builders**', created_at: 1, tags: [], sig: ''};
    const loaded = read(note, {state});
    expect(loaded.querySelector('.nostr-quote strong')?.textContent).toBe('Hello builders');
    expect(loaded.querySelector('.quote-title')?.getAttribute('data-path')).toBe(`/${note}`);
  });

  it('matches the normal calendar description and summary tag fallbacks', () => {
    expect(eventDescription({content: '', tags: [['description', `Host: ${npub}`]]})).toBe(`Host: ${npub}`);
    expect(eventDescription({content: '', tags: [['summary', 'Summary']]})).toBe('Summary');
  });

  it('renders standalone media and Markdown tables without turning inline URLs into block media', () => {
    const element = read('https://example.com/banner.png\n\nhttps://example.com/demo.mp4\n\n' +
      'See https://example.com/banner.png inline.\n\n| Who | When |\n| --- | --- |\n| Builders | Today |');
    expect(element.querySelectorAll('img')).toHaveLength(1);
    expect(element.querySelector('video')?.hasAttribute('controls')).toBe(true);
    expect(element.querySelector('table td')?.textContent).toBe('Builders');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com/banner.png');
  });
  it('renders a complete long Markdown image URL and the text after it', () => {
    const src = `https://blossom.example/${'a'.repeat(64)}.png`;
    const content = `![${'A detailed event illustration '.repeat(8)}](${src})\n\nDemo your **Freedom Tech** projects.`;
    const element = document.createElement('div');
    element.innerHTML = renderEventDescription(content);
    expect(element.querySelector('img')?.getAttribute('src')).toBe(src);
    expect(element.querySelector('strong')?.textContent).toBe('Freedom Tech');
    expect(element.textContent).not.toContain('![');
  });

  it('preserves paragraphs, lists, and links without allowing executable event HTML', () => {
    const element = document.createElement('div');
    element.innerHTML = renderEventDescription(
      'Welcome\n\n- Bring ideas\n- [Details](https://example.com)\n\n' +
      '<script>alert(1)</script><img src="https://example.com/image.png" onerror="alert(1)">' +
      '<a href="javascript:alert(1)">bad link</a><iframe src="https://example.com"></iframe>'
    );
    expect(element.querySelectorAll('li')).toHaveLength(2);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(element.querySelector('script, iframe, [onerror], [href^="javascript:"]')).toBeNull();
  });
});
