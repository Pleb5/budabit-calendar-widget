<script lang="ts">
  import {renderEventDescription} from './lib/event-description';
  import {emptyContentState, type ContentState} from './lib/nostr-content';
  import type {CommunityWidgetContext, WidgetBridge} from 'budabit-sdk';

  let {content, state = emptyContentState(), bridge = null, context, appOrigin = ''}: {
    content: string;
    state?: ContentState;
    bridge?: WidgetBridge | null;
    context?: CommunityWidgetContext;
    appOrigin?: string;
  } = $props();
  const html = $derived(renderEventDescription(content, {state, appOrigin}));

  async function openReference(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element)?.closest<HTMLAnchorElement>('a[data-profile], a[data-path]');
    if (!link || !bridge) return;
    event.preventDefault();
    const pubkey = link.dataset.profile;
    const path = link.dataset.path;
    const currentBridge = bridge;
    const currentContext = context;
    try {
      const response = await currentBridge.request(pubkey ? 'ui:openProfile' : 'ui:navigate', pubkey ? {
        pubkey, contextSessionId: currentContext?.contextSessionId, contextVersion: currentContext?.contextVersion,
      } : {path}) as {error?: string};
      if (!response?.error) return;
    } catch { /* Fall back to the host route on older hosts. */ }
    if (bridge !== currentBridge || context !== currentContext) return;
    if (pubkey) {
      try {
        await currentBridge.request('ui:navigate', {path: new URL(link.href).pathname});
      } catch { /* Keep the ordinary link available for a new-tab action. */ }
    }
  }

  function bindLinks(element: HTMLElement) {
    element.addEventListener('click', openReference);
    return {destroy() { element.removeEventListener('click', openReference); }};
  }
</script>

<!-- Links retain native keyboard activation; delegation handles their host actions. -->
<div class="description" use:bindLinks>{@html html}</div>

<style>
  .description {
    min-width: 0;
    margin-top: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .description :global(:first-child) { margin-top: 0; }
  .description :global(:last-child) { margin-bottom: 0; }
  .description :global(p) { margin: 0.75em 0; }
  .description :global(img) {
    display: block;
    max-width: 100%;
    max-height: 360px;
    width: auto;
    height: auto;
    margin: 12px auto;
    border-radius: 12px;
    object-fit: contain;
  }
  .description :global(a) { color: var(--accent-strong); }
  .description :global(.nostr-profile) {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    max-width: 100%;
    vertical-align: middle;
    text-decoration: none;
    font-weight: 600;
  }
  .description :global(.nostr-profile:hover) { text-decoration: underline; }
  .description :global(img.profile-avatar) {
    display: inline-block;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    margin: 0;
    border-radius: 50%;
    object-fit: cover;
  }
  .description :global(.nostr-quote) {
    display: block;
    min-width: 0;
    margin: 12px 0;
    padding: 14px;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--panel-muted);
  }
  .description :global(.quote-title), .description :global(.quote-author),
  .description :global(.quote-body) { display: block; }
  .description :global(.quote-title) { font-weight: 700; }
  .description :global(.quote-author) { margin: 4px 0 10px; font-size: 0.85em; }
  .description :global(.quote-body) {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 8;
    line-clamp: 8;
    overflow: hidden;
  }
  .description :global(video), .description :global(audio) { max-width: 100%; }
  .description :global(table) { width: 100%; table-layout: fixed; border-collapse: collapse; }
  .description :global(th), .description :global(td) { border: 1px solid var(--border); padding: 8px; }
  .description :global(pre) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .description :global(blockquote) {
    margin: 12px 0;
    padding-left: 12px;
    border-left: 3px solid var(--border-strong);
  }
  .description :global(ul), .description :global(ol) { padding-left: 1.5em; }
  .description :global(h1), .description :global(h2),
  .description :global(h3), .description :global(h4) {
    font-size: 1.1em;
    line-height: 1.3;
  }
</style>
