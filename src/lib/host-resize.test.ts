import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createHostResizer} from './host-resize';

beforeEach(() => {
  vi.useFakeTimers();
  // Model a cross-origin offscreen frame that never paints.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('resizes without a paint and includes later image growth and viewport shrink', async () => {
  let height = 80;
  const request = vi.fn(async () => ({}));
  const resizer = createHostResizer({measure: () => height, request});
  resizer.schedule();
  await vi.advanceTimersByTimeAsync(99);
  resizer.schedule();
  await vi.advanceTimersByTimeAsync(1);
  height = 440;
  resizer.schedule();
  await vi.advanceTimersByTimeAsync(100);
  height = 280;
  resizer.schedule();
  await vi.advanceTimersByTimeAsync(100);
  expect(request.mock.calls).toEqual([[80], [440], [280]]);
});

it('retries an unchanged height after rejection and after host reinitialization', async () => {
  const request = vi.fn().mockResolvedValueOnce({error: 'not ready'}).mockResolvedValue({});
  const resizer = createHostResizer({measure: () => 200, request});
  resizer.schedule();
  await vi.advanceTimersByTimeAsync(100);
  resizer.schedule();
  await vi.advanceTimersByTimeAsync(100);
  resizer.reset();
  await vi.advanceTimersByTimeAsync(100);
  expect(request.mock.calls).toEqual([[200], [200], [200]]);
});

it('cancels pending work on unmount', async () => {
  const request = vi.fn(async () => ({}));
  const resizer = createHostResizer({measure: () => 200, request});
  resizer.schedule();
  resizer.cancel();
  await vi.advanceTimersByTimeAsync(100);
  expect(request).not.toHaveBeenCalled();
});
