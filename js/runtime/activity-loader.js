/* Lazy activity loading. Classic scripts preserve direct file:// launch support. */
(() => {
  "use strict";
  const scripts = Object.freeze({
  "bopl-royale": "./activities/bopl-royale/document.js?v=20261023-file-upload-limit",
  "merge-party": "./activities/merge-party/document.js?v=20261023-file-upload-limit"
});
  const documents = new Map();
  const pending = new Map();
  const appURL = new URL("../../", document.currentScript.src);

  function register(id, html) {
    if (!Object.prototype.hasOwnProperty.call(scripts, id)) throw new Error("Unknown activity: " + id);
    if (typeof html !== "string" || !html.trim()) throw new Error("Empty activity document: " + id);
    // Each iframe remains about:srcdoc/blob with its inherited origin. Absolute
    // resource URLs continue working under nested Pages paths and direct files.
    const base = appURL.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const resolved = html.replace(/<head\b[^>]*>/i, (head) => head + '<base href="' + base + '">');
    documents.set(id, resolved);
  }

  function load(id) {
    if (!Object.prototype.hasOwnProperty.call(scripts, id)) return Promise.reject(new Error("Unknown activity: " + id));
    if (documents.has(id)) return Promise.resolve(documents.get(id));
    if (pending.has(id)) return pending.get(id);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(scripts[id], appURL).href;
      script.async = true;
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        if (error) reject(error);
        else resolve(documents.get(id));
      };
      const timer = setTimeout(() => finish(new Error("Activity loading timed out. Try again.")), 20000);
      script.onload = () => finish(documents.has(id) ? null : new Error("The activity document could not be read."));
      script.onerror = () => finish(new Error("The activity files could not load. Check your connection or extracted ZIP folder."));
      document.head.appendChild(script);
    });
    pending.set(id, promise);
    promise.then(() => pending.delete(id), () => pending.delete(id));
    return promise;
  }

  Object.defineProperty(window, "ChatActivities", {
    value: Object.freeze({ load, register }),
    configurable: false,
    writable: false,
  });
})();
