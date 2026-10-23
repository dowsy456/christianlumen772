/* activities/html-library: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.fetchFirebaseChildKeys = async function (path) {
  const cleanPath = String(path || "").replace(/^\/+|\/+$/g, "");
  if (!cleanPath) return [];
  const base = String(App.firebaseConfig?.databaseURL || "").replace(/\/+$/, "");
  if (!base) return [];
  const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
  try {
    const res = await fetch(`${base}/${encodedPath}.json?shallow=true`, {
      cache: "no-store"
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data && typeof data === "object" ? Object.keys(data) : [];
  } catch {
    return [];
  }
};
App.fetchHtmlHubChildKeys = function () {
  return App.fetchFirebaseChildKeys(App.HTML_HUB_FILES_NODE);
};
App.htmlHubButtonIconSVG = function () {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M7.3 3.5h2.1l1.1 1h3l1.1-1h2.1c2.1 0 3.5 1.4 4 3.7l1.4 10.2c.5 3.2-2.1 4.6-4 2.3l-2.4-3H8.3l-2.4 3c-1.9 2.3-4.5.9-4-2.3L3.3 7.2c.5-2.3 1.9-3.7 4-3.7ZM6.5 8v2H4.5v2h2v2h2v-2h2v-2h-2V8h-2Zm11 1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm-3 3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" clip-rule="evenodd"/></svg>`;
};
App.syncHtmlHubSidebarButton = function () {
  if (!App.btnSideHtmlHub) return;
  const tooltip = App.btnSideHtmlHub.querySelector(".dock-tooltip");
  const iconHost = App.$("btn-side-html-hub-icon");
  App.btnSideHtmlHub.dataset.mode = "hub";
  App.btnSideHtmlHub.setAttribute("aria-label", "HTML Hub");
  if (tooltip) tooltip.textContent = "HTML Hub";
  if (iconHost) iconHost.innerHTML = App.htmlHubButtonIconSVG();
};

App.register("activities/html-library", function initializeFeature() {
App.btnSideHtmlHub = App.$("btn-side-html-hub");
App.HTML_HUB_NODE = "htmlHub";
App.HTML_HUB_FILES_NODE = `${App.HTML_HUB_NODE}/files`;
App.HTML_HUB_META_NODE = `${App.HTML_HUB_NODE}/meta`;
App.HTML_HUB_BY_OWNER_NODE = `${App.HTML_HUB_NODE}/byOwner`;
App.HTML_HUB_MIGRATIONS_NODE = `${App.HTML_HUB_NODE}/migrations`;
App.LEGACY_HTML_LIBRARY_NODE = "htmlLibrary";
App.LEGACY_HTML_LIBRARY_META_NODE = "htmlLibraryMeta";
App.HTML_HUB_CHUNK_SIZE = 200000;
// This project starts with an empty database. Old-library migration remains
// available explicitly, without scanning every account during normal startup.
App.HTML_HUB_ENABLE_LEGACY_MIGRATION = false;
if (App.btnSideHtmlHub) App.btnSideHtmlHub.addEventListener("click", () => {
  if (!App.currentUser) return;
  App.openHtmlHubModal();
});
});
})(globalThis.ChatApp);
