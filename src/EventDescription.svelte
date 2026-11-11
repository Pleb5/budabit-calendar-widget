<script lang="ts">
  import {renderEventDescription} from './lib/event-description';

  let {content}: {content: string} = $props();
  const html = $derived(renderEventDescription(content));
</script>

<div class="description">{@html html}</div>

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
