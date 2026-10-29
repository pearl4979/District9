// One observer per already-running private service; reads never start a worker.
export function createReceiptObserver({ trades, pollMs = 750, maxDelayMs = 15000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onObserved = () => {} }) {
  if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 1000) throw new Error('Receipt interval must be 500–1000ms');
  let running = false, busy = false, timer = null, unsubscribe, failures = 0, startedAt = 0;
  const pending = () => (trades.receiptPending?.() || 0) > 0;
  function schedule(delay) {
    if (!running || busy || timer !== null || !pending()) return;
    timer = setTimer(() => { timer = null; void observe(); }, delay);
    timer?.unref?.();
  }
  async function observe() {
    if (!running || busy || !pending()) return;
    busy = true;
    try { const result = await trades.refresh(); failures = result?.errors ? failures + 1 : 0; onObserved(result); }
    catch { failures++; }
    finally {
      busy = false;
      const delay = failures ? Math.min(maxDelayMs, pollMs * 2 ** Math.min(failures, 8)) : now() - startedAt > 30000 ? 1000 : pollMs;
      schedule(delay);
    }
  }
  function wake() { if (!pending()) return; startedAt = now(); schedule(0); }
  return {
    wake(){if(!running||busy||!pending())return;clearTimer(timer);timer=null;schedule(0);},
    start() { if (running) return; running = true; unsubscribe = trades.watchReceipts?.(wake); wake(); },
    stop() { running = false; unsubscribe?.(); unsubscribe = null; clearTimer(timer); timer = null; },
  };
}
