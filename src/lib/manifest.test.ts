import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import packageJson from '../../package.json';

describe('widget manifest scripts', () => {
  const after = packageJson.scripts['manifest:after'];
  const before = packageJson.scripts['manifest:before'];

  it.each([after, before])('declares the featured calendar shared-config scope', (script) => {
    expect(script).toContain("--shared-config 'budabit-calendar-widget=featured-calendar-event'");
    expect(script).toContain("--version '0.2.9'");
    expect(script).toContain(
      "--changelog 'Bound refresh polling and preserve valid shared config'"
    );
  });

  it('keeps both placement alternatives on the existing widget identifier', () => {
    expect(after).toContain("--identifier 'featured-calendar-event'");
    expect(before).toContain("--identifier 'featured-calendar-event'");
    expect(after).toContain("--slot-type 'community-home-after-quicklinks'");
    expect(before).toContain("--slot-type 'community-home-before-quicklinks'");
  });

  it('executes the rebuilt SDK CLI and emits the declared shared-config tag', () => {
    const output = mkdtempSync(join(tmpdir(), 'budabit-calendar-manifest-'));
    const cli = realpathSync(
      fileURLToPath(new URL('../../node_modules/budabit-sdk/dist/manifest/cli.js', import.meta.url))
    );

    try {
      execFileSync(process.execPath, [
        cli,
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
      expect(event.tags).toContainEqual(['version', '0.2.9']);
    } finally {
      rmSync(output, {recursive: true, force: true});
    }
  });
});
