/* Feature methods are registered in parallel; startup side effects run once,
 * in the manifest's explicit dependency order. State lives in one namespace. */
(() => {
  "use strict";
  const initializers = new Map();
  const application = Object.create(null);
  // Live data changes patch existing nodes. A single keyed queue combines
  // bursts of snapshots and yields between features to keep input responsive.
  const liveJobs = new Map();
  let liveFrame = 0;
  let liveUsesTimer = false;
  const flushLiveJobs = () => {
    liveFrame = 0;
    const startedAt = performance.now();
    for (const [key, job] of liveJobs) {
      liveJobs.delete(key);
      try { job(); } catch (error) { console.error("Live update failed:", key, error); }
      if (performance.now() - startedAt >= 6) break;
    }
    if (liveJobs.size) scheduleLiveJobs();
  };
  const scheduleLiveJobs = () => {
    if (liveFrame) return;
    liveUsesTimer = document.hidden;
    liveFrame = liveUsesTimer ? setTimeout(flushLiveJobs, 32) : requestAnimationFrame(flushLiveJobs);
  };
  document.addEventListener?.("visibilitychange", () => {
    if (liveFrame) {
      if (liveUsesTimer) clearTimeout(liveFrame); else cancelAnimationFrame(liveFrame);
      liveFrame = 0;
    }
    if (liveJobs.size) scheduleLiveJobs();
  });
  application.queueLiveUpdate = (key, job) => { liveJobs.set(key, job); scheduleLiveJobs(); };
  application.cancelLiveUpdate = key => liveJobs.delete(key);
  application.reconcileChildren = (parent, nodes) => {
    const wanted = new Set(nodes);
    for (const node of Array.from(parent.childNodes)) if (!wanted.has(node)) node.remove();
    let cursor = parent.firstChild;
    for (const node of nodes) {
      if (node !== cursor) parent.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
  };
  let started = false;
  Object.defineProperties(application, {
    register: { value(id, initialize) {
      if (initializers.has(id)) throw new Error(`Duplicate application module: ${id}`);
      initializers.set(id, initialize);
    } },
    initialize: { value(entries) {
      if (started) return;
      for (const entry of entries) {
        if (!initializers.has(entry.id)) throw new Error(`Module did not register: ${entry.id}`);
      }
      started = true;
      for (const entry of entries) {
        try { initializers.get(entry.id)(); }
        catch (cause) { throw new Error(`Startup failed in ${entry.id}`, { cause }); }
      }
      initializers.clear();
      document.documentElement.dataset.appReady = "true";
      window.dispatchEvent(new Event("chatapp:ready"));
    } }
  });
  globalThis.ChatApp = application;
})();
