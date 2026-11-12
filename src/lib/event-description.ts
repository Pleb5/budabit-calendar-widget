import DOMPurify from 'dompurify';
import {Marked, type Tokens} from 'marked';
import {npubEncode} from 'nostr-tools/nip19';
import {
  createNostrExtension, emptyContentState, entityPath, eventDescription,
  parseNostrReference, profileLabel,
  type ContentState, type NostrReference,
} from './nostr-content';

type DescriptionOptions = {
  state?: ContentState;
  appOrigin?: string;
  references?: Map<string, NostrReference>;
  depth?: number;
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
const safeMedia = (value?: string) => {
  try {
    const url = new URL(value || '', location.href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
};

// Parse the complete Markdown before rendering: truncating source text can cut
// an image URL in half and expose its markup instead of the image.
export function renderEventDescription(content: string, options: DescriptionOptions = {}): string {
  const {state = emptyContentState(), appOrigin = '', references = new Map(), depth = 0} = options;
  const renderReference = (reference: NostrReference): string => {
    references.set(reference.key, reference);
    const href = escapeHtml(`${appOrigin}${entityPath(reference)}`);
    if (reference.type === 'profile') {
      const profile = state.profiles[reference.pubkey!];
      const picture = safeMedia(profile?.picture);
      return `<a class="nostr-profile" data-profile="${reference.pubkey}" href="${href}" title="${escapeHtml(reference.entity)}">` +
        (picture ? `<img class="profile-avatar" src="${escapeHtml(picture)}" alt="" />` : '') +
        `<span>${escapeHtml(profileLabel(reference.pubkey!, profile))}</span></a>`;
    }
    const quoted = state.events[reference.key];
    const kind = quoted?.kind ?? reference.kind;
    const label = kind === 32222 ? 'Community' : kind === 30023 ? 'Article' :
      kind === 31922 || kind === 31923 ? 'Calendar event' : kind === 30617 ? 'Repository' : 'Note';
    if (!quoted || depth > 0) {
      const title = `${reference.entity.slice(0, 12)}…${reference.entity.slice(-6)}`;
      return `<a class="nostr-reference" data-path="${escapeHtml(entityPath(reference))}" href="${href}">${label} · ${title}</a>`;
    }
    const title = quoted.tags.find(tag => ['title', 'name'].includes(tag[0]))?.[1] || label;
    // Generate the canonical profile path rather than reusing an event identifier.
    const authorLabel = renderReference({entity: npubEncode(quoted.pubkey), key: quoted.pubkey,
      pubkey: quoted.pubkey, type: 'profile', relays: []});
    const excerpt = eventDescription(quoted);
    const body = renderEventDescription(excerpt,
      {...options, references, state, depth: depth + 1});
    return `<div class="nostr-quote"><a class="quote-title" data-path="${escapeHtml(entityPath(reference))}" href="${href}">${escapeHtml(title)}</a>` +
      `<span class="quote-author">${authorLabel}</span><div class="quote-body">${body}</div></div>`;
  };
  const parser = new Marked({
    breaks: true,
    extensions: [createNostrExtension(renderReference)],
    renderer: {
      link(token: Tokens.Link) {
        const reference = parseNostrReference(token.href);
        if (reference) return renderReference(reference);
        return false;
      },
      paragraph(token: Tokens.Paragraph) {
        const only = token.tokens.length === 1 ? token.tokens[0] : undefined;
        if (only?.type === 'link') {
          const src = safeMedia(only.href);
          const pathname = src ? new URL(src).pathname : '';
          if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(pathname)) {
            return `<p><img src="${escapeHtml(src)}" alt="${escapeHtml(only.text)}" /></p>`;
          }
          if (/\.(mp4|webm|mov|mp3|ogg|wav|m4a)$/i.test(pathname)) {
            const tag = /\.(mp3|ogg|wav|m4a)$/i.test(pathname) ? 'audio' : 'video';
            return `<p><${tag} controls preload="none" src="${escapeHtml(src)}"></${tag}></p>`;
          }
        }
        const body = this.parser.parseInline(token.tokens);
        return body.includes('class="nostr-quote"')
          ? `<div class="description-paragraph">${body}</div>`
          : `<p>${body}</p>`;
      },
    },
  });
  const fragment = DOMPurify.sanitize(parser.parse(content.trim(), {async: false}), {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'a', 'img', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'div', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'video', 'audio',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'data-profile', 'data-path', 'controls', 'preload', 'align'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.setAttribute('target', link.hasAttribute('data-profile') || link.hasAttribute('data-path') ? '_top' : '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
