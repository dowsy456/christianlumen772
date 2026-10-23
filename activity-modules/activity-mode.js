/* Room activities reuse the mounted room; no room subscription or chat DOM is replaced. */
(function (App) {
  "use strict";
  App.isRoomActivityMode = () => !!(App.gamesStageOpen && App.selectedGame?.roomActivityId);
  App.getCompanionChatMode = () => App.isTimeDisplayExpanded?.() ? "time" : App.isRoomActivityMode() ? "activity" : App.callMenuOpen && App.callMenuExpanded ? "call" : "none";
  App.syncCompanionMembersButton = function () {
    const back = App.$("activity-chat-members-back");
    if (back) back.remove();
  };
  App.syncCompanionToolbarControls = function () {
    const bar = App.$("room-toolbar"), controls = App.companionToolbarControls;
    if (!bar || !controls) return;
    if (controls.parentElement !== bar) bar.appendChild(controls);
    controls.hidden = App.getCompanionChatMode() === "none";
    if (!bar.dataset.companionBound) {
      bar.dataset.companionBound = "1";
      bar.addEventListener("selectstart", event => { if (!event.target.closest?.("input") && !event.target.parentElement?.closest("input")) event.preventDefault(); });
      if (typeof ResizeObserver === "function") new ResizeObserver(() => {
        const value = `${Math.max(46, Math.ceil(bar.getBoundingClientRect().height))}px`;
        if (document.body.style.getPropertyValue("--companion-head-height") !== value) document.body.style.setProperty("--companion-head-height", value);
      }).observe(bar);
    }
    App.syncCompanionMembersButton();
  };

  App.syncActivityChatLayout = function () {
    const mode = App.getCompanionChatMode();
    const active = mode === "activity";
    const call = mode === "call";
    const time = mode === "time";
    const open = active ? !!App.activityChatOpen : time ? !!App.timeChatOpen && App.canOpenTimeDisplayChat?.() : call && !!App.callChatOpen;
    if (App.companionChatMode !== mode) {
      if (mode !== "none") {
        if (App.companionChatMode === "none" || !App.companionChatMode) App.companionMembersBefore = App.membersListVisible;
        App.membersListVisible = false;
      } else if (App.companionMembersBefore !== undefined) {
        App.membersListVisible = App.companionMembersBefore;
        delete App.companionMembersBefore;
      }
      App.companionChatMode = mode;
      App.syncEmojiButtonVisibility?.();
    }
    document.body.dataset.activityMode = active ? "1" : "0";
    document.body.dataset.activityChat = active && open ? "1" : "0";
    document.body.dataset.callChatMode = call ? "1" : "0";
    document.body.dataset.callChat = call && open ? "1" : "0";
    document.body.dataset.timeChatMode = time ? "1" : "0";
    document.body.dataset.timeChat = time && open ? "1" : "0";
    document.body.dataset.companionMode = mode;
    document.body.dataset.companionChat = open ? "1" : "0";
    const width = Math.min(30, Math.max(15, Number(App.activityChatWidth) || 30));
    document.body.style.setProperty("--activity-chat-width", `${width}vw`);
    App.$("activity-chat-resize")?.setAttribute("aria-valuenow", String(width));
    App.$("games-stage-overlay")?.classList.toggle("room-activity-mode", active);
    App.$("btn-call-menu-chat")?.setAttribute("aria-pressed", call && open ? "true" : "false");
    App.$("btn-call-menu-chat")?.setAttribute("aria-expanded", call && open ? "true" : "false");
    const callChatButton = App.$("btn-call-menu-chat");
    if (callChatButton) {
      const label = call && open ? "Hide Chat" : "Show Chat";
      callChatButton.setAttribute("aria-label", label);
      callChatButton.dataset.tooltip = label;
    }
    const frame = App.$("games-frame");
    try { frame?.contentWindow?.postMessage({ type: "htmlhub:activity-chat-state", open }, "*"); } catch {}
    App.syncComposerToolLayout?.();
    App.syncChatOverlayMetrics?.();
    App.syncCompanionMembersButton();
    App.syncRoomToolbar?.();
    App.syncCompanionToolbarControls();
    App.scheduleChatPopoverLayout?.();
    App.syncChatScrollAfterLayout?.({ reason: "companion-mode" });
  };

  App.syncExpandedCallChat = function () {
    if (!App.callMenuOpen || !App.callMenuExpanded) App.callChatOpen = false;
    App.syncActivityChatLayout();
  };
  App.toggleExpandedCallChat = async function () {
    if (!App.callMenuOpen) return;
    const open = !(App.callMenuExpanded && App.callChatOpen);
    const roomId = App.currentCallRoomId;
    if (open && roomId && App.currentRoomId !== roomId) await App.openRoom(roomId, { quiet: true });
    if (!App.callMenuOpen) return;
    App.callChatOpen = open;
    if (open && !App.callMenuExpanded) App.setCallMenuExpanded(true);
    if (!open) App.membersListVisible = false;
    App.syncEmojiButtonVisibility?.();
    App.syncActivityChatLayout();
  };

  App.setActivityChatOpen = function (open) {
    if (!App.isRoomActivityMode()) return;
    App.activityChatOpen = !!open;
    if (!open) App.membersListVisible = false;
    App.syncEmojiButtonVisibility?.();
    App.syncActivityChatLayout();
  };

  App.enterRoomActivityMode = function () {
    if (App.timeDisplayStage) App.collapseTimeDisplay?.({ silent:true });
    App.closeRoomActivitiesMenu?.();
    App.activityChatOpen = false;
    App.closeMobileDrawers?.();
    App.syncActivityChatLayout();
  };

  App.leaveRoomActivityMode = function () {
    App.activityChatOpen = false;
    App.syncActivityChatLayout();
  };

  App.hasPausedMergeParty = function (game) {
    return !!(App.pausedMergeParty && App.pausedMergeParty.userCode === App.currentUser?.code &&
      App.pausedMergeParty.key === App.getHtmlHubResumeKey(game) && App.$("merge-party-paused-frame"));
  };
  App.discardPausedMergeParty = function () {
    const frame = App.$("merge-party-paused-frame");
    if (frame) { App.revokeGamesFrameBlobURL(frame); frame.remove(); }
    App.pausedMergeParty = null;
  };
  App.parkMergePartyFrame = function (game) {
    const frame = App.$("games-frame");
    if (!frame || game?.roomActivityId !== App.ROOM_ACTIVITY_MERGE_PARTY) return false;
    try { if (!frame.contentWindow?.__mergeParty?.pauseActivity?.()) return false; } catch { return false; }
    App.discardPausedMergeParty();
    // Do not move an iframe between parents: that reloads its browsing context.
    frame.id = "merge-party-paused-frame";
    frame.hidden = true;
    App.pauseGamesFrameMedia(frame);
    App.pausedMergeParty = { key: App.getHtmlHubResumeKey(game), userCode: App.currentUser?.code };
    return true;
  };
  App.restoreMergePartyFrame = function (game) {
    if (!App.hasPausedMergeParty(game)) return null;
    const frame = App.$("merge-party-paused-frame");
    frame.id = "games-frame";
    frame.hidden = false;
    App.pausedMergeParty = null;
    App.resumeGamesFrameMedia(frame);
    try { frame.contentWindow?.__mergeParty?.resumeView?.(); } catch {}
    return frame;
  };

  App.register("activities/activity-mode", function () {
    App.activityChatWidth = 30;
    const chat = document.querySelector(".chat-main");
    if (!chat) return;
    const controls = document.createElement("div");
    controls.className = "companion-toolbar-actions";
    controls.hidden = true;
    controls.innerHTML = '<button type="button" class="icon-btn room-toolbar-action" id="activity-chat-close" aria-label="Close Chat" data-tooltip="Close Chat"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
    App.companionToolbarControls = controls;
    chat.prepend(controls);
    App.syncCompanionToolbarControls();
    const handle = document.createElement("div");
    handle.id = "activity-chat-resize";
    handle.className = "activity-chat-resize";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Chat width");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-valuemin", "15");
    handle.setAttribute("aria-valuemax", "30");
    handle.setAttribute("aria-valuenow", "30");
    chat.appendChild(handle);
    App.$("activity-chat-close").onclick = () => {
      if (App.getCompanionChatMode() === "activity") App.setActivityChatOpen(false);
      else if (App.getCompanionChatMode() === "time") App.toggleTimeDisplayChat?.();
      else if (App.callChatOpen) void App.toggleExpandedCallChat();
    };
    let pointerId = null;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);
      document.body.classList.add("activity-chat-resizing");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", event => {
      if (pointerId !== event.pointerId) return;
      const fraction = document.body.dataset.sidebarPosition === "left" ? event.clientX / innerWidth : (innerWidth - event.clientX) / innerWidth;
      App.activityChatWidth = Math.min(30, Math.max(15, fraction * 100));
      App.syncActivityChatLayout();
    });
    const stop = () => { pointerId = null; document.body.classList.remove("activity-chat-resizing"); };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
    handle.addEventListener("keydown", event => {
      const direction = document.body.dataset.sidebarPosition === "left" ? 1 : -1;
      if (event.key === "Home") App.activityChatWidth = 15;
      else if (event.key === "End") App.activityChatWidth = 30;
      else if (event.key === "ArrowLeft") App.activityChatWidth = Math.max(15, App.activityChatWidth - direction);
      else if (event.key === "ArrowRight") App.activityChatWidth = Math.min(30, App.activityChatWidth + direction);
      else return;
      App.activityChatWidth = Math.min(30, Math.max(15, App.activityChatWidth));
      App.syncActivityChatLayout();
      event.preventDefault();
    });
    window.addEventListener("message", event => {
      const frame = App.$("games-frame");
      if (!App.isRoomActivityMode() || !frame || event.source !== frame.contentWindow) return;
      if (event.data?.type === "htmlhub:activity-chat-toggle") App.setActivityChatOpen(!App.activityChatOpen);
      if (event.data?.type === "htmlhub:activity-close") void App.closeGamesStage({ preserve: App.selectedGame.roomActivityId === App.ROOM_ACTIVITY_MERGE_PARTY });
    });
    // Opening the iframe can leave focus in the host document. Forward game
    // shortcuts there, while chat fields, dialogs and menus retain their input.
    window.addEventListener("keydown", event => {
      if (!App.isRoomActivityMode() || App.selectedGame.roomActivityId !== App.ROOM_ACTIVITY_MERGE_PARTY || App.getCompanionChatMode() !== "activity") return;
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (App.modalEl && !App.modalEl.hidden) return;
      if (event.target.closest?.("input,textarea,select,[contenteditable=true],.chat-main,#members-sidebar,.chat-popup,[role=dialog],[role=menu]")) return;
      const key = /^(Digit|Numpad)[1-4]$/.test(event.code || "") ? event.code.slice(-1) : event.key;
      if (!["1", "2", "3", "4"].includes(key)) return;
      const frame = App.$("games-frame");
      if (!frame?.contentWindow) return;
      event.preventDefault();
      frame.contentWindow.postMessage({ type:"htmlhub:merge-ability", key }, "*");
    });
  });
})(globalThis.ChatApp);
