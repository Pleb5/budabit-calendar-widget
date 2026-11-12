import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';

const placement = process.argv[2];
if (!['after', 'before'].includes(placement)) throw new Error('Expected before or after placement');
const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const icon = 'https://blossom.budabit.club/daad5d8b18f221978a1609b2eefa511254c703b5914beda9184e6226b6527e18.svg';
execFileSync(process.execPath, [
  realpathSync(new URL('../node_modules/budabit-sdk/dist/manifest/cli.js', import.meta.url)),
  '--title', 'Featured Calendar Events', '--type', 'tool',
  '--app-url', process.env.WIDGET_APP_URL || 'https://example.com/budabit-calendar-widget/index.html',
  '--icon', icon, '--image', icon, '--identifier', 'featured-calendar-event', '--version', version,
  '--changelog', 'Render Nostr profiles, event references, media, and Markdown like calendar descriptions',
  '--permissions', ['community:checkWriteCapabilities', 'community:queryEvents', 'community:querySharedConfig',
    'community:publishSharedConfig', 'profiles:resolve', 'ui:openProfile', 'nostr:query',
    'ui:toast', 'ui:navigate', 'ui:resize'].join(','),
  '--nostr-kinds', '1,11,1111,30023,30617,31922,31923,32222',
  '--shared-config', 'budabit-calendar-widget=featured-calendar-event',
  '--slot-type', `community-home-${placement}-quicklinks`, '--slot-label', 'Featured events',
  '--output', `dist/widget-${placement}`,
  ...process.argv.slice(3),
], {stdio: 'inherit'});
