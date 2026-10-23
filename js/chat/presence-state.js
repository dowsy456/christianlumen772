/* chat/presence-state: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.stopAllChatAudio = function () {
  for (const audio of App.chatAudioPlayers) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {}
  }
};
App.fmtAudioTime = function (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

App.register("chat/presence-state", function initializeFeature() {
App.roomOnlineRef = null;
App.roomOnlineCb = null;
App.roomMembersRef = null;
App.roomMembersCb = null;
App.roomMembersCache = new Map();
App.roomCallMembersRef = null;
App.roomCallMembersCb = null;
App.roomCallMembersCache = new Map();
App.onlinePresenceCache = new Map();
App.onlineTiles = new Map();
App.memberClassmatesTooltipSeq = 0;
App.memberClassmatesFloating = null;
App.memberClassmatesFloatingAnchor = null;
App.memberClassmatesFloatingOwnerCode = "";
App.memberClassmatesFloatingHideTimer = null;
App.scheduleClassmatesTooltipSeq = 0;
App.scheduleClassmatesFloating = null;
App.scheduleClassmatesFloatingAnchor = null;
App.scheduleClassmatesFloatingHideTimer = null;
App.MEMBER_CLASSMATES_GROUP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.25" fill="currentColor"/><circle cx="5.5" cy="9" r="2.55" fill="currentColor"/><circle cx="18.5" cy="9" r="2.55" fill="currentColor"/><path d="M7.2 17.4v-2.1c0-2.8 2.1-5 4.8-5s4.8 2.2 4.8 5v2.1c0 .9-.7 1.6-1.6 1.6H8.8c-.9 0-1.6-.7-1.6-1.6Z" fill="currentColor"/><path d="M1.8 17v-1.7c0-2.3 1.7-4.1 3.9-4.1.8 0 1.5.2 2.1.6a6.3 6.3 0 0 0-1.7 4.4V18H2.8c-.6 0-1-.4-1-1Zm20.4 0v-1.7c0-2.3-1.7-4.1-3.9-4.1-.8 0-1.5.2-2.1.6a6.3 6.3 0 0 1 1.7 4.4V18h3.3c.6 0 1-.4 1-1Z" fill="currentColor"/></svg>';
App.chatAudioPlayers = new Set();
App.myPresenceRef = null;
App.presenceConnRef = null;
App.presenceConnCb = null;
App.myTyping = false;
App.typingIdleTimer = null;
App.ROOM_IDLE_MS = 5 * 60 * 1000;
App.roomIdleTimer = null;
App.roomIdleEventBound = false;
App.myRoomIdle = false;
App.lastRoomInputAtMs = 0;
});
})(globalThis.ChatApp);
