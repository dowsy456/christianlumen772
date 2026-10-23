/* ui/layout: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.applyScrollFixes = function () {
  try {
    document.querySelector(".chat-shell")?.style?.setProperty("height", document.body.dataset.mobileUi === "1" ? "var(--mobile-viewport-height, 100dvh)" : "100dvh");
    const main = document.querySelector(".chat-main");
    const shell = document.querySelector(".chat-shell");
    const body = document.querySelector(".chat-body");
    const sidebar = document.querySelector(".sidebar:not(.members-sidebar)");
    if (shell) shell.style.minHeight = "0";
    if (main) main.style.minHeight = "0";
    if (body) body.style.minHeight = "0";
    if (sidebar) sidebar.style.minHeight = "0";
    App.messagesEl.style.minHeight = "0";
    App.messagesEl.style.overflowY = "auto";
    App.messagesEl.style.scrollbarGutter = "stable";
  } catch {}
};

App.register("ui/layout", function initializeFeature() {

});
})(globalThis.ChatApp);
