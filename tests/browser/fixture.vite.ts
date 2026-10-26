import {mergeConfig} from 'vite';
import base from '../../vite.config';

if (!process.env.BUDABIT_CHECKOUT) throw new Error('Set BUDABIT_CHECKOUT to the host checkout under review');
export default mergeConfig(base, {
  server: {host: '127.0.0.1', port: 1859, strictPort: true, fs: {allow: [process.cwd(), process.env.BUDABIT_CHECKOUT]}},
});
