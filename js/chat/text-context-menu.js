/* chat/text-context-menu: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.selectionIsInsideBubbleText = function (sel, bubbleText) {
  if (!sel || sel.isCollapsed || !bubbleText || !sel.rangeCount) return false;
  return bubbleText.contains(sel.anchorNode) && bubbleText.contains(sel.focusNode);
};
App.pointIsInsideSelection = function (sel, x, y) {
  if (!sel || !sel.rangeCount) return false;
  try {
    const rects = Array.from(sel.getRangeAt(0).getClientRects());
    return rects.some(r => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
  } catch {
    return false;
  }
};
App.getMessageTextContextSelection = function (bubbleText, e) {
  const sel = window.getSelection?.();
  if (!App.selectionIsInsideBubbleText(sel, bubbleText)) return "";
  if (!App.pointIsInsideSelection(sel, e.clientX, e.clientY)) return "";
  const selected = String(sel.toString() || "");
  return selected.trim() ? selected : "";
};
App.getMessageDefinitionLookupWord = function (text) {
  let word = String(text || "").trim();
  if (!word || /\s/.test(word) || word.length > 80) return "";
  try {
    word = word.replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}'’-]+$/u, "");
    if (!/^\p{L}[\p{L}'’-]*$/u.test(word)) return "";
  } catch {
    word = word.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z'’-]+$/, "");
    if (!/^[A-Za-z][A-Za-z'’-]*$/.test(word)) return "";
  }
  return word.toLowerCase();
};
App.fetchMessageDefinitions = async function (word, signal = null) {
  const key = String(word || "").toLowerCase();
  if (!key) return [];
  if (App.msgTextDefinitionCache.has(key)) return App.msgTextDefinitionCache.get(key);
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    cache: "force-cache",
    signal
  });
  if (!res.ok) {
    App.msgTextDefinitionCache.set(key, []);
    return [];
  }
  const data = await res.json();
  const definitions = [];
  (Array.isArray(data) ? data : []).forEach(entry => {
    (Array.isArray(entry?.meanings) ? entry.meanings : []).forEach(meaning => {
      const partOfSpeech = String(meaning?.partOfSpeech || "").trim();
      (Array.isArray(meaning?.definitions) ? meaning.definitions : []).forEach(item => {
        const definition = String(item?.definition || "").trim();
        if (!definition) return;
        definitions.push({
          partOfSpeech,
          definition,
          example: String(item?.example || "").trim()
        });
      });
    });
  });
  App.msgTextDefinitionCache.set(key, definitions);
  return definitions;
};
App.renderMsgTextDefinition = function (word, definitions) {
  const box = App.msgTextMenuEl?.querySelector?.(".msg-text-menu-definition");
  if (!box) return;
  const items = (Array.isArray(definitions) ? definitions : []).map((item, index) => {
    const part = item.partOfSpeech ? `<span class="msg-text-menu-part">${App.escapeHtml(item.partOfSpeech)}</span>` : "";
    const example = item.example ? `<div class="msg-text-menu-example">Example: ${App.escapeHtml(item.example)}</div>` : "";
    return `
        <div class="msg-text-menu-definition-row">
          <span class="msg-text-menu-definition-num">${index + 1}.</span>
          <div class="msg-text-menu-definition-copy">
            ${part}
            <div>${App.escapeHtml(item.definition)}</div>
            ${example}
          </div>
        </div>
      `;
  }).join("");
  box.innerHTML = `
    <div class="msg-text-menu-definition-title">Define: ${App.escapeHtml(word)}</div>
    ${items}
  `;
  box.hidden = !items;
  requestAnimationFrame(() => {
    if (!App.msgTextMenuEl || App.msgTextMenuEl.hidden || !App.msgTextMenuCtx) return;
    App.positionMsgTextMenu(App.msgTextMenuCtx.pointerX, App.msgTextMenuCtx.pointerY);
  });
};
App.ensureMsgTextMenu = function () {
  if (App.msgTextMenuEl) return App.msgTextMenuEl;
  App.msgTextMenuEl = document.createElement("div");
  App.msgTextMenuEl.id = "msg-text-menu";
  App.msgTextMenuEl.className = "msg-menu msg-text-menu";
  App.msgTextMenuEl.hidden = true;
  App.msgTextMenuEl.innerHTML = `
    <div class="msg-menu-user" data-msg-text-user></div>
    <button class="msg-menu-btn" type="button" data-msg-text-act="copy">
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M8 8h10v12H8V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </span>
      <span class="msg-menu-label">Copy Text</span>
    </button>
    <button class="msg-menu-btn" type="button" data-msg-text-act="search">
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="m16.2 16.2 3.8 3.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </span>
      <span class="msg-menu-label">Search Google</span>
    </button>
    <button class="msg-menu-btn" type="button" data-msg-text-act="define" hidden>
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 4h11a2 2 0 0 1 2 2v14H8a2 2 0 0 0-2 2V4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6 4H5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 8h6M9 12h5M9 16h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </span>
      <span class="msg-menu-label">Define</span>
    </button>
    <div class="msg-text-menu-definition" hidden></div>
  `;
  document.body.appendChild(App.msgTextMenuEl);
  App.msgTextMenuEl.addEventListener("click", async e => {
    const btn = e.target?.closest?.("[data-msg-text-act]");
    if (!btn || !App.msgTextMenuEl.contains(btn) || !App.msgTextMenuCtx) return;
    const act = btn.getAttribute("data-msg-text-act");
    const selectedText = String(App.msgTextMenuCtx.text || "");
    if (act === "copy") {
      try {
        await App.copyTextToClipboard(selectedText);
        App.showToast({
          title: "Copied",
          body: "Selected text copied.",
          duration: 1400
        });
      } catch {
        App.showToast({
          title: "Copy failed",
          body: "Could not copy selected text.",
          duration: 2000
        });
      }
      App.closeMsgTextMenu();
      return;
    }
    if (act === "search") {
      const q = selectedText.trim();
      if (q) window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, "_blank", "noopener,noreferrer");
      App.closeMsgTextMenu();
      return;
    }
    if (act === "define") {
      if (App.msgTextMenuCtx.word && Array.isArray(App.msgTextMenuCtx.definitions) && App.msgTextMenuCtx.definitions.length) {
        App.renderMsgTextDefinition(App.msgTextMenuCtx.word, App.msgTextMenuCtx.definitions);
      }
    }
  });
  document.addEventListener("pointerdown", e => {
    if (!App.msgTextMenuEl || App.msgTextMenuEl.hidden) return;
    if (App.msgTextMenuEl.contains(e.target)) return;
    App.closeMsgTextMenu();
  }, true);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") App.closeMsgTextMenu(true);
  }, true);
  window.addEventListener("resize", () => App.closeMsgTextMenu(true));
  window.addEventListener("blur", () => App.closeMsgTextMenu(true));
  return App.msgTextMenuEl;
};
App.positionMsgTextMenu = function (x, y) {
  if (!App.msgTextMenuEl || App.msgTextMenuEl.hidden) return;
  App.positionContextMenu(App.msgTextMenuEl, App.msgTextMenuCtx?.placement || { x, y });
};
App.closeMsgTextMenu = function (immediate = false) {
  if (!App.msgTextMenuEl || App.msgTextMenuEl.hidden) return;
  App.msgTextMenuCloseSeq += 1;
  const seq = App.msgTextMenuCloseSeq;
  if (App.msgTextDefinitionAbort) {
    try {
      App.msgTextDefinitionAbort.abort();
    } catch {}
    App.msgTextDefinitionAbort = null;
  }
  if (App.msgTextMenuCloseOnEnd) {
    App.msgTextMenuEl.removeEventListener("animationend", App.msgTextMenuCloseOnEnd);
    App.msgTextMenuCloseOnEnd = null;
  }
  const clearCtx = () => {
    App.msgTextMenuCtx = null;
    const box = App.msgTextMenuEl?.querySelector?.(".msg-text-menu-definition");
    if (box) {
      box.hidden = true;
      box.innerHTML = "";
    }
  };
  if (immediate) {
    App.msgTextMenuEl.hidden = true;
    App.msgTextMenuEl.classList.remove("open", "closing");
    clearCtx();
    return;
  }
  App.msgTextMenuEl.classList.remove("open");
  App.msgTextMenuEl.classList.add("closing");
  App.msgTextMenuCloseOnEnd = () => {
    if (seq !== App.msgTextMenuCloseSeq) return;
    App.msgTextMenuCloseOnEnd = null;
    if (App.msgTextMenuEl) {
      App.msgTextMenuEl.hidden = true;
      App.msgTextMenuEl.classList.remove("closing");
    }
    clearCtx();
  };
  App.msgTextMenuEl.addEventListener("animationend", App.msgTextMenuCloseOnEnd, {
    once: true
  });
};
App.openMsgTextMenu = function ({
  x,
  y,
  text,
  word,
  username,
  displayName
}) {
  const selectedText = String(text || "");
  if (!selectedText.trim()) return;
  App.ensureMsgTextMenu();
  App.closeCallScreenContextMenu?.(true);
  const userEl = App.msgTextMenuEl?.querySelector?.(".msg-menu-user");
  if (userEl) userEl.textContent = String(username || displayName || "User");
  App.closeMsgMenu(true);
  App.msgTextMenuCloseSeq += 1;
  if (App.msgTextMenuCloseOnEnd) {
    App.msgTextMenuEl.removeEventListener("animationend", App.msgTextMenuCloseOnEnd);
    App.msgTextMenuCloseOnEnd = null;
  }
  if (App.msgTextDefinitionAbort) {
    try {
      App.msgTextDefinitionAbort.abort();
    } catch {}
    App.msgTextDefinitionAbort = null;
  }
  const defineBtn = App.msgTextMenuEl.querySelector('[data-msg-text-act="define"]');
  const definitionBox = App.msgTextMenuEl.querySelector(".msg-text-menu-definition");
  if (defineBtn) defineBtn.hidden = true;
  if (definitionBox) {
    definitionBox.hidden = true;
    definitionBox.innerHTML = "";
  }
  const token = Symbol("definition-request");
  App.msgTextMenuCtx = {
    text: selectedText,
    word: word || "",
    definitions: [],
    pointerX: x,
    pointerY: y,
    placement: { x, y },
    token
  };
  App.msgTextMenuEl.hidden = false;
  App.msgTextMenuEl.classList.remove("closing");
  App.msgTextMenuEl.classList.add("open");
  App.positionMsgTextMenu(x, y);
  if (!word) return;
  App.msgTextDefinitionAbort = new AbortController();
  App.fetchMessageDefinitions(word, App.msgTextDefinitionAbort.signal).then(definitions => {
    if (!App.msgTextMenuCtx || App.msgTextMenuCtx.token !== token) return;
    App.msgTextMenuCtx.definitions = definitions;
    const btn = App.msgTextMenuEl?.querySelector?.('[data-msg-text-act="define"]');
    if (btn) btn.hidden = !(Array.isArray(definitions) && definitions.length);
    requestAnimationFrame(() => App.positionMsgTextMenu(x, y));
  }).catch(() => {});
};
App.ensureMsgContextMenuDelegation = function () {
  if (App.msgContextMenuBound || !App.messagesListEl) return;
  App.msgContextMenuBound = true;
  document.addEventListener("contextmenu", e => {
    const ava = e.target?.closest?.(".msg-avatar");
    const bubbleText = ava ? null : e.target?.closest?.(".bubble-text");
    const row = e.target?.closest?.(".msg-row");
    if (!row) return;
    const search = !!row.closest("#room-search-results");
    if (!search && !App.messagesListEl?.contains(row)) return;
    const msgKey = row?.dataset?.msgkey || "";
    const msg = msgKey ? (search ? App.roomSearchState?.messages : App.msgDataByKey)?.get(msgKey) || null : null;
    if (msg?.t === "system") return;
    if (!msg && !ava) return;
    if (bubbleText) {
      const selectedText = App.getMessageTextContextSelection(bubbleText, e);
      if (String(selectedText || "").trim()) {
        e.preventDefault();
        e.stopPropagation();
        const code = row?.dataset?.usercode || msg?.userCode || "";
        const live = code ? App.liveUserCache.get(code) : null;
        App.openMsgTextMenu({
          x: e.clientX,
          y: e.clientY,
          text: selectedText,
          word: App.getMessageDefinitionLookupWord(selectedText),
          username: live?.username || msg?.username || "User",
          displayName: live?.displayName || msg?.displayName || live?.username || msg?.username || "User"
        });
        return;
      }
    }
    App.closeMsgTextMenu(true);
    e.preventDefault();
    e.stopPropagation();
    if (ava) {
      const code = row?.dataset?.usercode || msg?.userCode || "";
      const latest = code ? App.liveUserCache.get(code) : null;
      const uname = String(latest?.username || msg?.username || "User");
      const dname = String(latest?.displayName || msg?.displayName || uname);
      const photoDataURL = String(latest?.photoDataURL || msg?.photoDataURL || App.defaultStickmanDataURL());
      const bannerDataURL = String(latest?.bannerDataURL || msg?.bannerDataURL || "");
      const ext = App.inferImageExt(photoDataURL);
      const fn = `${App.safeFileBaseName(uname)}.${ext}`;
      const bannerFn = `${App.safeFileBaseName(uname)}-banner.${bannerDataURL ? App.inferImageExt(bannerDataURL) : "png"}`;
      App.openMsgMenuFor(ava, {
        menu: "avatar",
        userCode: code,
        username: uname,
        displayName: dname,
        imageDataURL: photoDataURL,
        imageFileName: fn,
        bannerDataURL,
        bannerFileName: bannerFn,
        pointerX: e.clientX,
        pointerY: e.clientY
      });
      return;
    }
    const code = row?.dataset?.usercode || msg?.userCode || "";
    const live = code ? App.liveUserCache.get(code) : null;
    App.openMsgMenuFor(row, {
      key: msgKey,
      roomId: search ? App.roomSearchState?.room : App.currentRoomId,
      message: msg,
      userCode: code,
      username: live?.username || msg?.username || "User",
      displayName: live?.displayName || msg?.displayName || live?.username || msg?.username || "User",
      text: msg?.text || "",
      canEdit: !!(App.currentUser && String(msg?.userCode || "") === String(App.currentUser.code || "") && !msg?.__stub && msg?.t !== "sticker" && !msg?.sticker?.id && !msg?.stickerId),
      canReply: true,
      pointerX: e.clientX,
      pointerY: e.clientY
    });
  }, {
    passive: false
  });
};

App.register("chat/text-context-menu", function initializeFeature() {
App.msgContextMenuBound = false;
App.msgTextMenuEl = null;
App.msgTextMenuCtx = null;
App.msgTextDefinitionCache = new Map();
App.msgTextDefinitionAbort = null;
App.msgTextMenuCloseOnEnd = null;
App.msgTextMenuCloseSeq = 0;
App.ensureMsgContextMenuDelegation();
});
})(globalThis.ChatApp);
