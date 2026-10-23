/* Classic-script loading works on both file:// and Cloudflare Pages. */
(() => {
  "use strict";
  const pending = new Map();
  const base = new URL("../../", document.currentScript.src);
  // Keep dynamically loaded features on the same revision as the entry page.
  // The EXE and website use this one loader and the same web files.
  const version = new URL(document.currentScript.src).searchParams.get("v") || "20261023-file-upload-limit";
  function loadScript(relative) {
    const url = new URL(relative, base);
    url.searchParams.set("v", version);
    const key = url.href;
    if (pending.has(key)) return pending.get(key);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timeout = setTimeout(() => {
        script.onload = script.onerror = null;
        pending.delete(key);
        script.remove();
        reject(new Error(`Loading ${relative} timed out.`));
      }, 25000);
      script.src = key;
      script.async = true;
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => {
        clearTimeout(timeout);
        pending.delete(key);
        script.remove();
        reject(new Error(`Could not load ${relative}. Keep the complete app folder together.`));
      };
      document.head.appendChild(script);
    });
    pending.set(key, promise);
    return promise;
  }
  async function loadAll(entries, concurrency = entries.length) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (next < entries.length) await loadScript(entries[next++].src);
    }));
  }
  globalThis.ChatRuntime = Object.freeze({ loadScript, loadAll, base, version });
})();
