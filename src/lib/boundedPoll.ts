export type BoundedPoll = {
  start: (callback: () => void) => void;
  stop: () => void;
};

export const createBoundedPoll = (delaysMs: readonly number[]): BoundedPoll => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const stop = () => {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const start = (callback: () => void) => {
    stop();
    const runGeneration = generation;
    let nextDelay = 0;

    const scheduleNext = () => {
      const delay = delaysMs[nextDelay];
      if (delay === undefined || runGeneration !== generation) return;

      timer = setTimeout(() => {
        timer = undefined;
        if (runGeneration !== generation) return;

        nextDelay += 1;
        callback();
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  };

  return {start, stop};
};
