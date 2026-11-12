import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import packageJson from '../../package.json';

describe('widget manifest scripts', () => {
  const script = readFileSync(new URL('../../scripts/manifest.mjs', import.meta.url), 'utf8');
  const after = script;
  const before = script;

  it.each([after, before])('declares the featured calendar shared-config scope', (script) => {
    expect(script).toContain("'budabit-calendar-widget=featured-calendar-event'");
    expect(script).toContain("'--version', version");
    expect(script).toContain("'profiles:resolve'");
    expect(script).toContain("'ui:openProfile'");
  });

  it('requires tagged community relays for every publish command', () => {
    const publishScripts = Object.entries(packageJson.scripts)
      .filter(([name]) => name.startsWith('widget:publish:'))
      .map(([, script]) => script);
    expect(publishScripts).toHaveLength(4);
    publishScripts.forEach((script) =>
      expect(script).toContain('--relay ${COMMUNITY_RELAYS:')
    );
  });

  it('keeps both placement alternatives on the existing widget identifier', () => {
    expect(script).toContain("'--identifier', 'featured-calendar-event'");
    expect(packageJson.scripts['manifest:after']).toBe('node scripts/manifest.mjs after');
    expect(packageJson.scripts['manifest:before']).toBe('node scripts/manifest.mjs before');
    expect(script).toContain('community-home-${placement}-quicklinks');
  });

  it('executes the rebuilt SDK CLI and emits the declared shared-config tag', () => {
    const output = mkdtempSync(join(tmpdir(), 'budabit-calendar-manifest-'));
    const cli = realpathSync(
      fileURLToPath(new URL('../../scripts/manifest.mjs', import.meta.url))
    );

    try {
      execFileSync(process.execPath, [
        cli,
        'after',
        '--title',
        'Featured Calendar Events',
        '--type',
        'tool',
        '--app-url',
        'https://example.com/budabit-calendar-widget/index.html',
        '--icon',
        'https://example.com/icon.svg',
        '--image',
        'https://example.com/image.svg',
        '--identifier',
        'featured-calendar-event',
        '--version',
        packageJson.version,
        '--shared-config',
        'budabit-calendar-widget=featured-calendar-event',
        '--slot-type',
        'community-home-after-quicklinks',
        '--slot-label',
        'Featured events',
        '--output',
        output,
      ]);

      const event = JSON.parse(readFileSync(join(output, 'event.json'), 'utf8')) as {
        tags: string[][];
      };
      expect(event.tags).toContainEqual([
        'shared-config',
        'budabit-calendar-widget',
        'featured-calendar-event',
      ]);
      expect(event.tags).toContainEqual(['d', 'featured-calendar-event']);
      expect(event.tags).toContainEqual(['version', packageJson.version]);
      expect(event.tags).toContainEqual(['permission', 'profiles:resolve']);
      expect(event.tags).toContainEqual(['permission', 'ui:openProfile']);
      expect(event.tags).toContainEqual(['permission', 'nostr:query']);
      expect(event.tags).toContainEqual(['nostrKinds', '1']);
      expect(event.tags).toContainEqual(['nostrKinds', '30023']);
    } finally {
      rmSync(output, {recursive: true, force: true});
    }
  });
});
