import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createBoundedPoll} from './boundedPoll';

describe('bounded poll', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs each delayed poll once and leaves no timer after the bound', () => {
    const callback = vi.fn();
    const poll = createBoundedPoll([100, 200, 400]);

    poll.start(callback);
    vi.advanceTimersByTime(699);
    expect(callback).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('cancels pending work and invalidates a previous run when restarted', () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const poll = createBoundedPoll([100, 200]);

    poll.start(firstCallback);
    vi.advanceTimersByTime(50);
    poll.start(secondCallback);
    vi.advanceTimersByTime(100);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);

    poll.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(secondCallback).toHaveBeenCalledTimes(1);
  });
});
