/* chat/composer-state: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.normalizeReplyDisplayName = function (value, fallback = "User") {
  const clean = String(value ?? "").trim().replace(/^@+\s*/, "").trim();
  return clean || String(fallback || "User").trim().replace(/^@+\s*/, "").trim() || "User";
};
App.isVoicePendingFile = function (item) {
  return !!item?.isVoiceMessage;
};
App.countPendingVoiceMessages = function () {
  return App.pendingFiles.filter(App.isVoicePendingFile).length;
};
App.countPendingStandardFiles = function () {
  return App.pendingFiles.filter(item => !App.isVoicePendingFile(item)).length;
};
App.getTotalPendingAttachmentCount = function () {
  return App.pendingFiles.length;
};
App.beginEditMessage = function (msg) {
  const roomId = App.sanitizeRoomCode(App.currentRoomId);
  if (!App.currentUser || !roomId || !msg?._key) return;
  if (String(msg.userCode || "") !== String(App.currentUser.code || "")) return;
  App.initOverlaysUI();
  App.clearPendingPoll();
  try {
    App.clearReplyState({
      quiet: true
    });
  } catch {}
  try {
    App.clearPendingFiles({
      quiet: true
    });
  } catch {}
  try {
    App.closePingBar({
      quiet: true
    });
  } catch {}
  App.editState = {
    key: String(msg._key),
    roomId,
    originalText: String(msg.text || "")
  };
  const input = App.$("msg-input");
  if (input) {
    input.value = String(msg.text || "");
    App.lastMsgInputVal = input.value;
    input.placeholder = "Edit your message…";
    try {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {}
  }
  try {
    App.syncComposerPreviewHeight();
  } catch {}
  try {
    App.syncChatOverlayMetrics();
  } catch {}
  App.syncComposerPrimaryAction();
};
App.cancelEditMessage = function ({
  keepText = false,
  quiet = false
} = {}) {
  if (!App.editState) {
    if (!quiet) App.syncComposerPrimaryAction();
    return;
  }
  App.editState = null;
  const input = App.$("msg-input");
  if (input) {
    if (!keepText) {
      input.value = "";
      App.lastMsgInputVal = "";
    }
    input.placeholder = "Type a message…";
  }
  try {
    App.syncComposerPreviewHeight();
  } catch {}
  try {
    App.syncChatOverlayMetrics();
  } catch {}
  App.syncComposerPrimaryAction();
};
App.initOverlaysUI = function () {
  if (App.overlaysInited) return;
  App.overlaysInited = true;

  // Reply UI
  App.replyBarEl = App.$("reply-bar");
  App.replyBarTextEl = App.$("reply-bar-text");
  App.replyBarMessageEl = App.$("reply-bar-message");
  App.replyBarAvatarEl = App.$("reply-bar-avatar");
  App.replyBarCloseEl = App.$("reply-bar-close");
  App.replyBarCloseEl?.addEventListener("click", () => App.clearReplyState());

  // Ping UI
  App.pingBarEl = App.$("ping-bar");
  App.pingListEl = App.$("ping-list");
  App.pingBarQueryEl = App.$("ping-bar-query");
  App.pingBarCountEl = App.$("ping-bar-count");
  App.pingBarCloseEl = App.$("ping-bar-close");
  App.pingBarCloseEl?.addEventListener("click", () => App.closePingBar());

  // Files UI
  App.chatOverlaysEl = App.$("chat-overlays");
  App.filesBarEl = App.$("files-bar");
  App.filesListEl = App.$("files-list");
  App.filesBarLimitEl = App.$("files-bar-limit");
  App.filesBarCloseEl = App.$("files-bar-close");
  App.filesBarCloseEl?.addEventListener("click", () => App.clearPendingFiles());
  window.addEventListener("resize", () => App.syncChatOverlayMetrics(), {
    passive: true
  });
  requestAnimationFrame(App.syncChatOverlayMetrics);
};
App.syncChatOverlayMetrics = function () {
  const main = document.querySelector(".chat-main");
  const composer = App.$("composer") || document.querySelector(".composer");
  if (!main || !composer) return;
  const composerH = Math.round(composer.getBoundingClientRect().height || 0);
  main.style.setProperty("--composer-h", `${composerH}px`);
  const overlays = App.chatOverlaysEl || App.$("chat-overlays");
  const anyOpen = !!App.replyBarEl && !App.replyBarEl.hidden || !!App.pingBarEl && !App.pingBarEl.hidden || !!App.filesBarEl && !App.filesBarEl.hidden || !!App.pendingPoll;
  overlays?.setAttribute("aria-hidden", String(!anyOpen));
  const overlaysH = overlays && anyOpen ? Math.round(overlays.getBoundingClientRect().height || 0) : 0;
  main.style.setProperty("--overlays-h", `${overlaysH}px`);
  App.syncChatScrollAfterLayout?.({ reason: "composer-metrics" });
};

App.POLL_DURATION_UNITS = [{ name: "days", seconds: 86400 }, { name: "hours", seconds: 3600, max: 23 }, { name: "minutes", seconds: 60, max: 59 }, { name: "seconds", seconds: 1, max: 59 }];
App.pollDurationSeconds = function (draft) {
  if (draft?.duration) {
    return App.POLL_DURATION_UNITS.reduce((total, unit) => {
      const value = Number(draft.duration[unit.name] || 0);
      if (!Number.isSafeInteger(value) || value < 0 || (unit.max != null && value > unit.max)) throw new Error(`Enter whole ${unit.name} from 0${unit.max != null ? ` to ${unit.max}` : " upward"}.`);
      return total + value * unit.seconds;
    }, 0);
  }
  // Preserve drafts created by older versions of the app.
  return Number(draft?.durationSeconds ?? Number(draft?.durationHours) * 3600);
};
App.pollDurationParts = function (seconds) {
  const parts = {};
  for (const unit of App.POLL_DURATION_UNITS) {
    parts[unit.name] = Math.floor(seconds / unit.seconds);
    seconds %= unit.seconds;
  }
  return parts;
};
App.pollRemainingText = function (remaining) {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const unit = App.POLL_DURATION_UNITS.find(unit => seconds >= unit.seconds) || App.POLL_DURATION_UNITS[3];
  const amount = Math.ceil(seconds / unit.seconds);
  return `${amount} ${amount === 1 ? unit.name.slice(0, -1) : unit.name} left`;
};
App.POLL_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 20V10m7 10V4m7 16v-7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
App.pollActionIcon = function (action) {
  const paths = {
    close: "m6 6 12 12M18 6 6 18",
    vote: "m5 12 4 4L19 6",
    change: "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z",
    remove: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5",
    end: "M7 3h10l4 4v10l-4 4H7l-4-4V7l4-4ZM9 9h6v6H9V9Z"
  };
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${paths[action] || paths.vote}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
};
App.closePollPopover = function ({ immediate = false, restoreFocus = false } = {}) {
  const menu = App.$("poll-popover");
  if (!menu || menu.hidden) return;
  menu._pollVotesCleanup?.();
  menu._pollVotesCleanup = null;
  menu.querySelectorAll("select").forEach(select => App.closeCustomSelect?.(App.customSelectState?.get(select)));
  const anchor = menu._chatPopupAnchor || App.$("btn-poll");
  clearTimeout(App.pollPopoverCloseTimer);
  menu.classList.remove("open");
  menu.classList.add("closing");
  menu.style.opacity = "0";
  App.$("btn-poll")?.setAttribute("aria-expanded", "false");
  const finish = () => { menu.hidden = true; menu.classList.remove("closing"); };
  if (immediate) finish();
  else App.pollPopoverCloseTimer = setTimeout(finish, 150);
  if (restoreFocus && anchor?.isConnected) anchor.focus?.({ preventScroll: true });
};
App.openPollMenu = function ({ title, bodyHTML, actionsHTML = "", anchor = null, closeId = "poll-menu-close", populate = null }) {
  App.dismissChatPopovers?.();
  App.hideTimestampTooltip?.();
  clearTimeout(App.pollPopoverCloseTimer);
  let menu = App.$("poll-popover");
  if (!menu) {
    menu = document.createElement("section");
    menu.id = "poll-popover";
    menu.className = "chat-popup poll-popover";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-modal", "false");
    menu.setAttribute("aria-labelledby", "poll-menu-title");
    document.body.appendChild(menu);
  }
  menu._chatPopupAnchor = anchor;
  delete menu.dataset.pollRoom;
  delete menu.dataset.pollKey;
  menu.innerHTML = `<header class="chat-popup-heading"><span class="chat-popup-mark" aria-hidden="true">${App.POLL_ICON}</span><div class="chat-popup-heading-copy"><strong id="poll-menu-title"></strong></div><button class="chat-popup-close chat-icon-button" id="${closeId}" type="button" aria-label="Close ${App.escapeAttr(title)}">${App.pollActionIcon("close")}</button></header><div class="poll-menu-body">${bodyHTML}</div>${actionsHTML ? `<div class="poll-menu-actions">${actionsHTML}</div>` : ""}`;
  menu.querySelector("#poll-menu-title").textContent = title;
  menu.querySelector(".chat-popup-close").addEventListener("click", () => App.closePollPopover({ restoreFocus: true }));
  // Fill and enhance the contents before the first measurement/fade so the
  // voters menu opens at its final size beside the clicked vote count.
  populate?.(menu);
  App.enhanceNativeSelects?.(menu);
  menu.classList.remove("open", "closing");
  menu.hidden = false;
  menu.style.opacity = "0";
  App.$("btn-poll")?.setAttribute("aria-expanded", String(!anchor));
  App.layoutChatPopovers?.();
  // Measure the final bounds before fading in, including when replacing a menu.
  void menu.offsetHeight;
  menu.classList.add("open");
  menu.style.opacity = "1";
  return menu;
};
App.validatePollDraft = function (draft) {
  const question = String(draft?.question || "").trim();
  const answers = (Array.isArray(draft?.answers) ? draft.answers : []).map(answer => String(answer || "").trim());
  if (!question || question.length > 300) throw new Error("Enter a question of 1–300 characters.");
  if (answers.length < 2 || answers.length > 10 || answers.some(answer => !answer || answer.length > 55)) throw new Error("Add 2–10 answers, each 1–55 characters long.");
  if (new Set(answers.map(answer => answer.toLocaleLowerCase())).size !== answers.length) throw new Error("Each answer must be different.");
  const durationSeconds = App.pollDurationSeconds(draft);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds * 1000 + Date.now() > 8640000000000000) throw new Error("Enter a duration of at least 1 second within the supported date range.");
  return { question, answers, durationSeconds, allowMultiple: !!draft.allowMultiple };
};
App.clearPendingPoll = function () {
  App.closePollPopover?.({ immediate: true });
  App.pendingPoll = null;
  App.$("poll-draft-bar")?.remove();
  App.syncChatOverlayMetrics();
};
App.renderPendingPoll = function () {
  App.$("poll-draft-bar")?.remove();
  if (!App.pendingPoll) return;
  const bar = document.createElement("div");
  bar.id = "poll-draft-bar";
  bar.className = "poll-draft-bar overlay-box";
  bar.innerHTML = `<div class="overlay-box-head"><div class="overlay-panel-title"><span class="poll-symbol" aria-hidden="true">${App.POLL_ICON}</span><span>Poll</span></div><button class="poll-draft-remove overlay-close" type="button" aria-label="Remove Poll">${App.pollActionIcon("close")}</button></div><button class="poll-draft-edit overlay-preview-row" type="button" aria-label="Edit Poll"><span class="poll-draft-question"></span><svg class="poll-draft-edit-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 5 5 5M4 20l4.5-1L20 7.5a2.1 2.1 0 0 0 0-3l-.5-.5a2.1 2.1 0 0 0-3 0L5 15.5 4 20Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  bar.querySelector(".poll-draft-question").textContent = App.pendingPoll.question;
  bar.querySelector(".poll-draft-edit").addEventListener("click", App.openPollComposer);
  bar.querySelector(".poll-draft-remove").addEventListener("click", App.clearPendingPoll);
  (App.$("chat-overlays") || App.$("composer")).appendChild(bar);
  requestAnimationFrame(App.syncChatOverlayMetrics);
};
App.openPollComposer = function () {
  if (!App.canChat() || App.editState) return;
  App.closeComposerMoreMenu?.(true);
  const roomId = App.currentRoomId;
  const draft = App.pendingPoll || { question: "", answers: ["", ""], durationSeconds: 86400, allowMultiple: false };
  App.openPollMenu({ title: "Create Poll", bodyHTML: `<div class="poll-editor">
    <label for="poll-question">Question</label><textarea id="poll-question" class="input" maxlength="300" rows="2" placeholder="Ask a question…"></textarea>
    <div class="poll-editor-label">Answers <span class="muted small">2–10 options</span></div><div id="poll-editor-answers"></div>
    <button class="btn" id="poll-add-answer" type="button">Add Answer</button>
    <fieldset class="poll-duration"><legend>Duration</legend><div class="poll-duration-fields">${App.POLL_DURATION_UNITS.map(unit => `<label><span>${unit.name[0].toUpperCase() + unit.name.slice(1)}</span><input id="poll-duration-${unit.name}" class="input" type="number" inputmode="numeric" min="0" ${unit.max != null ? `max="${unit.max}"` : ""} step="1" aria-label="${unit.name[0].toUpperCase() + unit.name.slice(1)}" /></label>`).join("")}</div></fieldset>
    <label class="poll-multiple"><input type="checkbox" id="poll-multiple"> Allow Multiple Answers</label>
    <div id="poll-editor-error" class="poll-error" role="alert"></div></div>`,
    actionsHTML: '<button class="btn primary" id="poll-attach" type="button">Attach Poll</button>' });
  App.$("poll-question").value = draft.question;
  const duration = App.pollDurationParts(App.pollDurationSeconds(draft));
  for (const unit of App.POLL_DURATION_UNITS) App.$(`poll-duration-${unit.name}`).value = String(duration[unit.name]);
  App.$("poll-popover").querySelector(".poll-editor").addEventListener("input", () => { App.$("poll-editor-error").textContent = ""; });
  App.$("poll-multiple").checked = draft.allowMultiple;
  const answers = App.$("poll-editor-answers");
  const refresh = () => {
    App.$("poll-add-answer").disabled = answers.children.length >= 10;
    [...answers.children].forEach((row, index) => {
      row.querySelector("input").setAttribute("aria-label", `Answer ${index + 1}`);
      row.querySelector("input").placeholder = `Answer ${index + 1}`;
      row.querySelector("button").disabled = answers.children.length <= 2;
    });
  };
  const addAnswer = (value = "") => {
    if (answers.children.length >= 10) return;
    const row = document.createElement("div"); row.className = "poll-editor-answer";
    const input = document.createElement("input"); input.className = "input"; input.maxLength = 55; input.value = value;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "chat-icon-button"; remove.innerHTML = App.pollActionIcon("close"); remove.setAttribute("aria-label", "Remove Answer");
    remove.addEventListener("click", () => { row.remove(); refresh(); });
    row.append(input, remove); answers.appendChild(row); refresh();
    return input;
  };
  draft.answers.forEach(addAnswer);
  App.$("poll-add-answer").addEventListener("click", () => addAnswer()?.focus());
  App.$("poll-attach").addEventListener("click", () => {
    if (!App.canChat() || App.currentRoomId !== roomId) { App.closePollPopover(); return; }
    try {
      App.pendingPoll = App.validatePollDraft({ question: App.$("poll-question").value, answers: [...answers.querySelectorAll("input")].map(input => input.value), duration: Object.fromEntries(App.POLL_DURATION_UNITS.map(unit => [unit.name, App.$(`poll-duration-${unit.name}`).value])), allowMultiple: App.$("poll-multiple").checked });
      App.closePollPopover(); App.renderPendingPoll(); App.$("msg-input")?.focus();
    } catch (error) { App.$("poll-editor-error").textContent = error.message; }
  });
  App.$("poll-question").focus();
};
App.register("chat/composer-state", function initializeFeature() {
document.addEventListener("pointerdown", event => {
  const menu = App.$("poll-popover");
  if (!menu || menu.hidden || !menu.classList.contains("open")) return;
  if (menu.contains(event.target) || App.$("btn-poll")?.contains(event.target)) return;
  // Select options live in a body portal but still belong to this menu.
  if ([...menu.querySelectorAll("select")].some(select => App.customSelectState?.get(select)?.pop?.contains(event.target))) return;
  App.closePollPopover();
});
document.addEventListener("keydown", event => {
  const menu = App.$("poll-popover");
  if (event.key === "Escape" && menu && !menu.hidden) App.closePollPopover({ restoreFocus: true });
});
App.pendingPoll = null;
App.msgElByKey = new Map();
App.msgDataByKey = new Map();
App.replyState = null;
App.replyBarEl = null;
App.replyBarTextEl = null;
App.replyBarMessageEl = null;
App.replyBarAvatarEl = null;
App.replyBarCloseEl = null;
App.chatOverlaysEl = null;
App.pingBarEl = null;
App.pingListEl = null;
App.pingBarQueryEl = null;
App.pingBarCountEl = null;
App.pingBarCloseEl = null;
App.pingTokenStart = -1;
App.pingRosterRef = null;
App.pingRosterCb = null;
App.pingRosterValCache = null;
App.filesBarEl = null;
App.filesListEl = null;
App.filesBarLimitEl = null;
App.filesBarCloseEl = null;
App.pendingFiles = [];
App.overlaysInited = false;
App.msgMenuEl = null;
App.msgMenuUserEl = null;
App.msgMenuBtns = null;
App.msgMenuCtx = null;
App.msgMenuCloseSeq = 0;
App.msgMenuCloseOnEnd = null;
App.msgMenuAnchorEl = null;
App.msgMenuAnchorBubble = null;
App.editState = null;
App._scrollLocked = false;
App._preventScroll = e => {
  e.preventDefault();
};
});
})(globalThis.ChatApp);
