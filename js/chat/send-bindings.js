/* chat/send-bindings: methods register before ordered initialization. */
(function (App) {
  "use strict";


App.register("chat/send-bindings", function initializeFeature() {
const pollButton = document.createElement("button");
pollButton.id = "btn-poll"; pollButton.type = "button"; pollButton.className = "icon-btn composer-tool-btn";
pollButton.dataset.tooltip = "Poll"; pollButton.setAttribute("aria-label", "Poll"); pollButton.setAttribute("aria-haspopup", "dialog"); pollButton.setAttribute("aria-controls", "poll-popover"); pollButton.setAttribute("aria-expanded", "false");
pollButton.innerHTML = `${App.POLL_ICON}<span class="composer-action-label">Poll</span>`;
pollButton.addEventListener("click", () => {
  const menu = App.$("poll-popover");
  if (menu && !menu.hidden && menu.classList.contains("open") && !menu._chatPopupAnchor) App.closePollPopover();
  else App.openPollComposer();
});
App.$("composer-actions-direct")?.appendChild(pollButton);
App.$("btn-send").addEventListener("click", () => {
  if (App.editState) {
    App.cancelEditMessage();
    return;
  }
  App.sendTextMessage();
});
App.$("msg-input").addEventListener("keydown", e => {
  if (e.key === "Tab" && App.pingBarEl && !App.pingBarEl.hidden) {
    const activeItem = App.pingListEl?.querySelector(".ping-item.is-active") || App.pingListEl?.querySelector(".ping-item");
    const pingName = String(activeItem?.getAttribute("data-ping-name") || "").trim();
    if (pingName) {
      e.preventDefault();
      App.applyPingSuggestion(pingName);
      return;
    }
  }
  if (e.key !== "Enter") return;
  if (e.shiftKey) return;
  e.preventDefault();
  App.sendTextMessage();
});
App.$("composer-row")?.addEventListener("pointerdown", e => {
  const input = App.$("msg-input");
  if (!input || input.disabled) return;
  if (e.target.closest("button, a, textarea, input, .emoji-popover, .voice-popover")) return;
  e.preventDefault();
  input.focus();
  try {
    const end = String(input.value || "").length;
    input.setSelectionRange(end, end);
  } catch {}
});
document.addEventListener("keydown", e => {
  if (e.defaultPrevented) return;
  if (e.repeat) return;
  if (e.key !== "/") return;
  if (!App.currentUser || !App.currentRoomId) return;
  const input = App.$("msg-input");
  if (!input || input.disabled) return;
  const active = document.activeElement;
  const tag = String(active?.tagName || "").toUpperCase();
  if (active === input) return;
  if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) return;
  let hasSelection = false;
  try {
    const sel = window.getSelection ? window.getSelection() : null;
    hasSelection = !!(sel && !sel.isCollapsed);
  } catch {}
  if (hasSelection) return;
  e.preventDefault();
  input.focus();
  try {
    const end = String(input.value || "").length;
    input.setSelectionRange(end, end);
  } catch {}
});
});
})(globalThis.ChatApp);
