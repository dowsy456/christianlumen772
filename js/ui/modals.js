/* ui/modals: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.clearModalCloseTimer = function () {
  if (!App.modalCloseTimer) return;
  clearTimeout(App.modalCloseTimer);
  App.modalCloseTimer = 0;
};
App.stopModalMedia = function () {
  try {
    App.modalEl.querySelectorAll("video, audio").forEach(media => {
      try {
        media.pause?.();
      } catch {}
      try {
        media.removeAttribute("src");
      } catch {}
      try {
        media.srcObject = null;
      } catch {}
      try {
        media.load?.();
      } catch {}
    });
  } catch {}
};
App.getModalFocusableElements = function () {
  if (!App.modalCard) return [];
  const selector = ["a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])"].join(",");
  const candidates = Array.from(App.modalCard.querySelectorAll(selector));
  if (App.htmlHubMenuEl && !App.htmlHubMenuEl.hidden) {
    candidates.push(...App.htmlHubMenuEl.querySelectorAll(selector));
  }
  return candidates.filter(el => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    return true;
  });
};
App.setModalChrome = function ({
  title = "Modal",
  subtitle = ""
} = {}) {
  const titleEl = App.$("modal-title");
  const subtitleEl = App.$("modal-subtitle");
  if (titleEl) titleEl.textContent = title || "Modal";
  if (subtitleEl) subtitleEl.textContent = subtitle || "";
};
App.resetModalShell = function () {
  App.clearModalCloseTimer();
  App.modalCard.removeEventListener("transitionend", App.modalCard.__modalTransitionEnd || (() => {}));
  App.modalCard.__modalTransitionEnd = null;
  App.modalClosing = false;
  App.modalEl.classList.remove("is-closing");
  App.modalCard.style.removeProperty("width");
  App.modalCard.style.removeProperty("height");
};
App.resetModalSupplementalActions = function () {
  const chat = App.$("btn-time-display-chat");
  if (chat) { chat.hidden = true; chat.onclick = null; chat.setAttribute("aria-pressed", "false"); }
  const expand = App.$("btn-time-display-expand");
  const remove = App.$("btn-sticker-delete");
  const save = App.$("btn-sticker-save");
  const create = App.$("btn-media-create-sticker");
  if (expand) {
    expand.hidden = true;
    expand.onclick = null;
    expand.setAttribute("aria-pressed", "false");
    expand.setAttribute("aria-label", "Expand Time Display");
    expand.dataset.tooltip = "Expand Time Display";
  }
  if (remove) {
    remove.hidden = true;
    remove.onclick = null;
    delete remove.dataset.deleteStickerId;
  }
  if (save) {
    save.hidden = true;
    save.onclick = null;
    save.classList.remove("is-saved");
    save.setAttribute("aria-pressed", "false");
    save.setAttribute("aria-label", "Save Sticker");
    save.dataset.tooltip = "Save Sticker";
  }
  if (create) {
    create.hidden = true;
    create.onclick = null;
  }
  const actionWrap = document.querySelector(".modal-head-actions");
  actionWrap?.classList.remove("media-original-actions", "sticker-viewer-actions");
};
App.openModal = function ({
  title,
  bodyHTML,
  actionsHTML,
  size = "default",
  subtitle = "",
  onBeforeClose = null
}) {
  if (size !== "time-display" && App.isTimeDisplayExpanded?.() && !App.timeDisplayStage) App.parkTimeDisplay?.();
  const motionId = ++App.modalMotionId;
  const wasHidden = App.modalEl.hidden;
  const active = document.activeElement;
  if (!wasHidden && App.modalBeforeClose) {
    const previousBeforeClose = App.modalBeforeClose;
    App.modalBeforeClose = null;
    try {
      previousBeforeClose();
    } catch (e) {
      console.error("modal beforeClose failed:", e);
    }
  }
  if (active && active !== document.body && active !== document.documentElement) {
    App.modalLastFocus = active;
  }
  App.resetModalShell();
  App.resetModalSupplementalActions();
  App.setModalChrome({
    title,
    subtitle,
    size
  });
  const bodyEl = App.$("modal-body");
  const actions = String(actionsHTML || "").trim();
  bodyEl.innerHTML = actions ? `${bodyHTML || ""}<div class="modal-body-actions" id="modal-body-actions">${actions}</div>` : bodyHTML || "";
  const actionsEl = App.$("modal-actions");
  if (actionsEl) {
    actionsEl.innerHTML = "";
    actionsEl.hidden = true;
  }
  App.modalBeforeClose = typeof onBeforeClose === "function" ? onBeforeClose : null;
  App.modalEl.dataset.size = size || "default";
  App.modalEl.setAttribute("aria-busy", "false");
  delete App.modalEl.dataset.busy;
  App.modalEl.hidden = false;
  App.modalEl.classList.remove("is-closing");
  if (wasHidden) App.modalEl.classList.remove("is-open");else App.modalEl.classList.add("is-open");
  const openNow = () => {
    if (motionId !== App.modalMotionId || App.modalEl.hidden) return;
    App.modalEl.classList.add("is-open");
    const focusTarget = App.getModalFocusableElements().find(el => {
      if (el.id === "btn-modal-close") return false;
      return !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName || "");
    }) || App.$("btn-modal-close");
    try {
      focusTarget?.focus?.({
        preventScroll: true
      });
    } catch {}
  };
  if (wasHidden) {
    requestAnimationFrame(() => requestAnimationFrame(openNow));
  } else {
    openNow();
  }
};
App.closeModal = function () {
  if (App.modalEl.hidden || App.modalClosing) return;
  if (App.modalEl.dataset.busy === "1") return;
  const motionId = ++App.modalMotionId;
  App.modalClosing = true;
  App.clearModalCloseTimer();
  try {
    if (App.modalBeforeClose) App.modalBeforeClose();
  } catch (e) {
    console.error("modal beforeClose failed:", e);
  }
  App.modalBeforeClose = null;
  App.stopModalMedia();
  const finish = () => {
    if (motionId !== App.modalMotionId) return;
    const focused = document.activeElement;
    const shouldRestoreFocus = !focused || focused === document.body || App.modalEl.contains(focused);
    App.modalEl.classList.remove("is-open", "is-closing");
    App.modalEl.hidden = true;
    App.modalCard.style.removeProperty("width");
    App.modalCard.style.removeProperty("height");
    delete App.modalEl.dataset.size;
    delete App.modalEl.dataset.busy;
    delete App.modalEl.dataset.timeDisplayExpanded;
    App.modalEl.removeAttribute("aria-busy");
    App.setModalChrome({
      title: "Modal",
      subtitle: ""
    });
    try {
      App.$("modal-body").innerHTML = "";
    } catch {}
    try {
      const actionsEl = App.$("modal-actions");
      if (actionsEl) {
        actionsEl.innerHTML = "";
        actionsEl.hidden = true;
      }
    } catch {}
    App.resetModalSupplementalActions();
    App.modalClosing = false;
    App.clearModalCloseTimer();
    const restoreTarget = App.modalLastFocus;
    App.modalLastFocus = null;
    if (shouldRestoreFocus && restoreTarget && document.contains(restoreTarget)) {
      try {
        restoreTarget.focus?.({
          preventScroll: true
        });
      } catch {}
    }
  };
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    finish();
    return;
  }
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    App.modalCard.removeEventListener("transitionend", onEnd);
    if (App.modalCard.__modalTransitionEnd === onEnd) App.modalCard.__modalTransitionEnd = null;
    finish();
  };
  const onEnd = e => {
    if (e.target !== App.modalCard) return;
    cleanup();
  };
  App.modalCard.__modalTransitionEnd = onEnd;
  App.modalCard.addEventListener("transitionend", onEnd);
  App.modalEl.classList.add("is-closing");
  App.modalEl.classList.remove("is-open");
  App.modalCloseTimer = setTimeout(cleanup, 260);
};
App.handleModalKeydown = function (e) {
  if (App.cloakHotkeyEditing) return;
  if (App.modalEl.hidden && App.timeDisplayStage?.contains(e.target) && e.key === "Escape") {
    e.preventDefault();
    App.collapseTimeDisplay();
    return;
  }
  if (App.modalEl.hidden || App.modalClosing) return;
  // Expanded Time Display and chat are peer panes, not a modal focus trap.
  if (!App.timeDisplayStage && App.isTimeDisplayExpanded?.() && App.timeChatOpen && (e.key === "Tab" || !App.modalEl.contains(e.target))) return;
  if (e.key === "Escape") {
    if (App.modalEl.dataset.timeDisplayExpanded === "1") {
      e.preventDefault();
      e.stopPropagation();
      App.collapseTimeDisplay();
      return;
    }
    if (App.htmlHubMenuEl && !App.htmlHubMenuEl.hidden) {
      e.preventDefault();
      e.stopPropagation();
      App.closeHtmlHubContextMenu(true, true);
      return;
    }
    // Escape may dismiss a local menu, but closing the modal is an explicit
    // close-button/backdrop action. It can also be part of the cloak binding.
    return;
  }
  if (e.key !== "Tab") return;
  const focusable = App.getModalFocusableElements();
  if (!focusable.length) {
    e.preventDefault();
    try {
      App.modalCard?.focus?.({
        preventScroll: true
      });
    } catch {}
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const activeWithin = App.modalCard.contains(active) || !!(App.htmlHubMenuEl && !App.htmlHubMenuEl.hidden && App.htmlHubMenuEl.contains(active));
  if (e.shiftKey && (active === first || !activeWithin)) {
    e.preventDefault();
    last.focus({
      preventScroll: true
    });
  } else if (!e.shiftKey && (active === last || !activeWithin)) {
    e.preventDefault();
    first.focus({
      preventScroll: true
    });
  }
};
App.isEditableKeyboardTarget = function (target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = String(target.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable;
};
App.isPingAutocompleteTab = function (e) {
  if (e.key !== "Tab") return false;
  const input = App.$("msg-input");
  const bar = App.$("ping-bar");
  return !!(input && e.target === input && bar && !bar.hidden);
};
App.handleMediaViewerVideoSpace = function (e) {
  const isSpace = e.key === " " || e.key === "Spacebar" || e.code === "Space";
  if (!isSpace) return false;
  if (App.modalEl.hidden || App.modalEl.dataset.size !== "media") return false;
  if (App.isEditableKeyboardTarget(e.target)) return false;
  const video = App.modalEl.querySelector('.media-viewer-video .vpu-video');
  if (!(video instanceof HTMLVideoElement)) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (video.paused) video.play().catch(() => {});else video.pause();
  return true;
};
App.isEnhanceableNativeSelect = function (select) {
  if (!(select instanceof HTMLSelectElement)) return false;
  if (select.multiple || Number(select.size || 0) > 1) return false;
  if (select.classList.contains("font-native")) return false;
  if (select.dataset.nativeSelect === "1") return false;
  return true;
};
App.customSelectLabel = function (select) {
  const opt = select.selectedOptions && select.selectedOptions[0] ? select.selectedOptions[0] : select.options[select.selectedIndex];
  return String(opt?.textContent || select.value || "Select").trim() || "Select";
};
App.restoreCustomSelectPop = function (state) {
  if (!state?.pop || !state.popHomeParent) return;
  try {
    if (state.popHomeNext && state.popHomeNext.parentNode === state.popHomeParent) state.popHomeParent.insertBefore(state.pop, state.popHomeNext);else state.popHomeParent.appendChild(state.pop);
  } catch {}
  state.pop.classList.remove("portal");
  state.pop.style.left = "";
  state.pop.style.top = "";
  state.pop.style.width = "";
  state.pop.style.maxHeight = "";
  state.pop.style.zIndex = "";
};
App.closeCustomSelect = function (state) {
  if (!state) return;
  if (state.pop?.hidden && !state.portalOpen && !state.wrap?.classList.contains("open")) return;
  if (state.pop) state.pop.hidden = true;
  if (state.wrap) state.wrap.classList.remove("open");
  state.portalOpen = false;
  try {
    state.cleanupPointer?.();
  } catch {}
  try {
    state.cleanupScroll?.();
  } catch {}
  try {
    state.cleanupResize?.();
  } catch {}
  state.cleanupPointer = null;
  state.cleanupScroll = null;
  state.cleanupResize = null;
  App.restoreCustomSelectPop(state);
  state.popHomeParent = state.popHomeNext = null;
  App.syncCustomSelectControl(state.select);
};
App.syncCustomSelectControl = function (select) {
  const state = App.customSelectState.get(select);
  if (!state) return;
  if (state.btn) {
    state.btn.textContent = App.customSelectLabel(select);
    state.btn.disabled = !!select.disabled;
    state.btn.setAttribute("aria-expanded", state.pop && !state.pop.hidden ? "true" : "false");
  }
  if (state.pop) {
    state.pop.querySelectorAll(".font-dd-opt").forEach(btn => {
      btn.classList.toggle("is-selected", String(btn.dataset.value || "") === String(select.value || ""));
    });
  }
};
App.rebuildCustomSelectOptions = function (state) {
  const select = state?.select;
  const pop = state?.pop;
  if (!select || !pop) return;
  pop.innerHTML = Array.from(select.options).map((opt, idx) => `
    <button
      class="font-dd-opt custom-select-opt"
      type="button"
      data-custom-select-index="${idx}"
      data-value="${App.escapeHtml(String(opt.value || ""))}"
      ${opt.disabled ? "disabled" : ""}
    >${App.escapeHtml(String(opt.textContent || opt.value || "Select"))}</button>
  `).join("");
  App.syncCustomSelectControl(select);
};
App.positionCustomSelectPop = function (state) {
  const btn = state?.btn;
  const pop = state?.pop;
  if (!btn || !pop) return;
  const rect = btn.getBoundingClientRect();
  const gap = 6;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const width = Math.max(120, rect.width);
  pop.style.width = `${width}px`;
  pop.style.maxHeight = "204px";
  let left = rect.left;
  let top = rect.bottom + gap;
  left = Math.max(0, Math.min(left, Math.max(0, vw - width)));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  try {
    const pr = pop.getBoundingClientRect();
    if (pr.bottom > vh - 8 && rect.top > pr.height + gap + 8) {
      top = rect.top - pr.height - gap;
      pop.style.top = `${Math.max(8, top)}px`;
    }
  } catch {}
};
App.openCustomSelect = function (state) {
  if (!state?.pop || !state?.btn || state.select?.disabled) return;
  document.querySelectorAll(".custom-select-dd.open").forEach(wrap => {
    const sel = wrap.previousElementSibling;
    if (sel instanceof HTMLSelectElement) App.closeCustomSelect(App.customSelectState.get(sel));
  });
  App.rebuildCustomSelectOptions(state);
  state.popHomeParent = state.pop.parentNode;
  state.popHomeNext = state.pop.nextSibling;
  try {
    document.body.appendChild(state.pop);
  } catch {}
  state.pop.classList.add("portal");
  // Portaled options must sit above the surface containing their control.
  let layer = parseInt(getComputedStyle(state.pop).zIndex, 10) || 400;
  for (let owner = state.btn; owner; owner = owner.parentElement) {
    layer = Math.max(layer, (parseInt(getComputedStyle(owner).zIndex, 10) || 0) + 1);
  }
  state.pop.style.zIndex = String(layer);
  state.pop.hidden = false;
  state.wrap.classList.add("open");
  state.portalOpen = true;
  App.syncCustomSelectControl(state.select);
  App.positionCustomSelectPop(state);
  try {
    state.pop.querySelector(".font-dd-opt.is-selected")?.scrollIntoView({
      block: "nearest"
    });
  } catch {}
  const onPointer = ev => {
    const t = ev.target;
    if (!(t instanceof Node)) return;
    if (state.wrap.contains(t) || state.pop.contains(t)) return;
    ev.preventDefault();
    ev.stopPropagation();
    try {
      ev.stopImmediatePropagation();
    } catch {}
    App.closeCustomSelect(state);
  };
  const onScroll = () => {
    if (state.portalOpen) App.positionCustomSelectPop(state);
  };
  const onResize = () => {
    if (state.portalOpen) App.positionCustomSelectPop(state);
  };
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("scroll", onScroll, {
    passive: true,
    capture: true
  });
  window.addEventListener("resize", onResize, {
    passive: true
  });
  state.cleanupPointer = () => document.removeEventListener("pointerdown", onPointer, true);
  state.cleanupScroll = () => window.removeEventListener("scroll", onScroll, {
    capture: true
  });
  state.cleanupResize = () => window.removeEventListener("resize", onResize);
};
App.enhanceNativeSelect = function (select) {
  if (!App.isEnhanceableNativeSelect(select) || App.customSelectState.has(select)) return;
  const wrap = document.createElement("span");
  wrap.className = "font-dd custom-select-dd";
  const btn = document.createElement("button");
  btn.className = "input font-dd-btn custom-select-btn";
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div");
  pop.className = "font-dd-pop custom-select-pop";
  pop.hidden = true;
  select.classList.add("custom-select-native");
  select.dataset.customSelectEnhanced = "1";
  select.setAttribute("tabindex", "-1");
  select.setAttribute("aria-hidden", "true");
  select.insertAdjacentElement("afterend", wrap);
  wrap.appendChild(btn);
  wrap.appendChild(pop);
  const state = {
    select,
    wrap,
    btn,
    pop,
    portalOpen: false,
    popHomeParent: null,
    popHomeNext: null,
    cleanupPointer: null,
    cleanupScroll: null,
    cleanupResize: null
  };
  App.customSelectState.set(select, state);
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (desc?.get && desc?.set && !select.__customSelectValuePatched) {
      Object.defineProperty(select, "value", {
        configurable: true,
        get() {
          return desc.get.call(this);
        },
        set(v) {
          desc.set.call(this, v);
          requestAnimationFrame(() => App.syncCustomSelectControl(this));
        }
      });
      select.__customSelectValuePatched = true;
    }
  } catch {}
  wrap.addEventListener("pointerdown", e => {
    e.stopPropagation();
  });
  wrap.addEventListener("click", e => {
    e.stopPropagation();
  });
  btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    if (pop.hidden) App.openCustomSelect(state);else App.closeCustomSelect(state);
  });
  pop.addEventListener("click", e => {
    const optBtn = e.target instanceof HTMLElement ? e.target.closest(".font-dd-opt") : null;
    if (!(optBtn instanceof HTMLButtonElement) || optBtn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = Number(optBtn.dataset.customSelectIndex);
    const opt = Number.isInteger(idx) ? select.options[idx] : null;
    if (!opt || opt.disabled) return;
    select.value = opt.value;
    select.dispatchEvent(new Event("input", {
      bubbles: true
    }));
    select.dispatchEvent(new Event("change", {
      bubbles: true
    }));
    App.syncCustomSelectControl(select);
    App.closeCustomSelect(state);
  });
  select.addEventListener("input", () => App.syncCustomSelectControl(select));
  select.addEventListener("change", () => App.syncCustomSelectControl(select));
  App.rebuildCustomSelectOptions(state);
};
App.enhanceNativeSelects = function (root = document) {
  if (root instanceof HTMLSelectElement) {
    App.enhanceNativeSelect(root);
    return;
  }
  root?.querySelectorAll?.("select").forEach(select => App.enhanceNativeSelect(select));
};
App.suppressNativeKeyboardChromeControls = function (e) {
  if (App.isPingAutocompleteTab(e)) return;
  App.handleMediaViewerVideoSpace(e);
};

App.register("ui/modals", function initializeFeature() {
App.modalEl = App.$("modal");
App.modalCard = document.querySelector(".modal-card");
App.modalBeforeClose = null;
App.modalClosing = false;
App.modalMotionId = 0;
App.modalCloseTimer = 0;
App.modalLastFocus = null;
App.customSelectState = new WeakMap();
App.enhanceNativeSelects(document);
new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return;
      App.enhanceNativeSelects(node);
    });
  });
}).observe(document.documentElement, {
  childList: true,
  subtree: true
});
App.$("btn-modal-close").addEventListener("click", App.closeModal);
App.$("modal-backdrop").addEventListener("click", App.closeModal);
document.addEventListener("keydown", App.suppressNativeKeyboardChromeControls, true);
document.addEventListener("keydown", App.handleModalKeydown, true);
});
})(globalThis.ChatApp);
