// Offscreen cross-origin frames can suspend animation frames. Layout signals
// must not postpone the timer fallback, including while images are loading.
export function createHostResizer({
  measure,
  request,
}: {
  measure: () => number | undefined;
  request: (height: number) => Promise<unknown>;
}) {
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHeight: number | undefined;
  let requestId = 0;

  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
  }

  async function resize() {
    cancel();
    const measured = measure();
    if (measured === undefined || !Number.isFinite(measured) || measured < 1) return;
    const height = Math.ceil(measured);
    if (height === lastHeight) return;
    lastHeight = height;
    const id = ++requestId;
    try {
      const response = await request(height);
      if (response && typeof response === 'object' && 'error' in response) {
        if (id === requestId) lastHeight = undefined;
      }
    } catch {
      if (id === requestId) lastHeight = undefined;
    }
  }

  function schedule() {
    if (frame !== undefined || timer !== undefined) return;
    frame = requestAnimationFrame(() => void resize());
    timer = setTimeout(() => void resize(), 100);
  }

  return {
    schedule,
    cancel,
    reset() {
      requestId += 1;
      lastHeight = undefined;
      schedule();
    },
  };
}
