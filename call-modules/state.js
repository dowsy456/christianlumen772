/* calling/state: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callMakeRtcConfig = // ICE server configuration is owned by connectivity.js.
function () {
  const runtime = App.callRuntimeConfig();
  const fresh = App.callIceCredentialCache?.expiresAt > Date.now() + 5000 ? App.callIceCredentialCache.iceServers : [];
  const configured = App.callValidateIceServers(runtime.iceServers);
  const servers = fresh.length ? fresh : configured.length ? configured : App.CALL_PUBLIC_STUN;
  const relay = servers.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^turns?:/i.test(u)));
  App.callConnectivityStatus.relayConfigured = relay;
  App.callConnectivityStatus.credentialSource = fresh.length ? 'endpoint' : configured.length ? 'configuration' : 'stun';
  return {
    iceServers: servers,
    iceTransportPolicy: runtime.iceTransportPolicy === 'relay' ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    // Reuse negotiated transceivers; avoid 5 extra idle TURN allocations per user.
    iceCandidatePoolSize: 0
  };
};

App.register("calling/state", function initializeFeature() {
App.currentCallRoomId = null;
App.observedCallRoomId = null;
App.callsRoomRef = null;
App.callsRoomCb = null;
App.callObservedMembersSnapshot = null;
App.callPresenceExpiryTimer = null;
App.callMembersReady = false;
App.callMenuOpen = false;
App.callMembersCache = [];
App.callActive = false;
App.myCallMemberRef = null;
App.callConnRef = null;
App.callConnCb = null;
App.callSignalingConnected = null;
App.callSessionId = null;
App.callJoiningMember = null;
App.callHeartbeatTimer = null;
App.CALL_HEARTBEAT_MS = 15000;
App.CALL_STALE_MEMBER_MS = 45000;
// Hidden web tabs may run timers only once a minute. Allow two such intervals.
App.CALL_HEARTBEAT_STALE_MS = 120000;
App.CALL_QUALITY_POLL_MS = 2000;
App.CALL_SCREEN_HEALTH_POLL_MS = 6000;
App.CALL_MIC_MUTE_RECOVERY_MS = 1600;
App.CALL_AUDIO_CONSTRAINTS = Object.freeze({
  audio: {
    echoCancellation: {
      ideal: true
    },
    noiseSuppression: {
      ideal: true
    },
    autoGainControl: {
      ideal: true
    },
    channelCount: {
      ideal: 1
    },
    sampleRate: {
      ideal: 48000
    },
    sampleSize: {
      ideal: 16
    }
  }
});
App.CALL_SCREEN_CONSTRAINTS = Object.freeze({
  video: {
    width: {
      ideal: 1280,
      max: 1280
    },
    height: {
      ideal: 720,
      max: 720
    },
    frameRate: {
      ideal: 30,
      max: 30
    },
    cursor: "always"
  },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false },
  systemAudio: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include"
});
App.callMuted = false;
App.callDeafened = false;
App.callSharing = false;
App.callCameraSharing = false;
App.callCameraStream = null;
App.callCameraTrack = null;
App.callCameraShareId = null;
App.callCameraPreviewDataURL = null;
App.callCameraCapturePending = false;
App.CALL_CAMERA_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.5 6.5 10 4h4l1.5 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" stroke="currentColor" stroke-width="2"/></svg>';
App.callScreenStream = null;
App.callScreenTrack = null;
App.callScreenAudioTrack = null;
App.callScreenShareId = null;
App.callScreenPaused = false;
App.callScreenPauseVersion = 0;
App.callScreenPauseFrame = null;
App.callScreenPauseTrack = null;
App.callScreenPauseSource = null;
App.callRemotePauseStates = new Map();
App.callLocalStream = null;
App.callPeerMap = new Map();
App.callRemoteAudioEls = new Map();
App.callRemoteVideoStreams = new Map();
App.callRemoteScreenAudioStreams = new Map();
App.callPeerSignalRefs = new Map();
App.callMemberSharingCache = new Map();
App.callPeerStatusCache = new Map();
App.callPeerTopologySignature = "";
App.callMemberUiSignature = "";
App.callShareSyncRequestAt = new Map();
App.callStaleCleanupPending = new Set();
App.callLocallyEndedSessions = new Set();
App.callPeerHardRestartPending = new Set();
App.callLifecycleToken = 0;
App.callJoinPending = false;
App.callLeavePending = false;
App.callMicRefreshPending = false;
App.callListenOnly = false;
App.callMicRecoveryTimer = null;
App.callLastLeave = {
  roomId: "",
  at: 0
};
App.callAudioHost = null;
App.callAudioUnlockRequired = false;
App.callAudioResumePromise = null;
App.callAudioResumeQueued = false;
App.callPreferredAudioOutputId = "";
App.callAudioPlaybackToken = 0;
App.callAudioResumeGeneration = 0;
App.callPlaybackCtx = null;
App.callPlaybackPrimerSource = null;
App.callPlaybackPrimerGain = null;
App.callRemoteWebAudioSources = new Map();
App.CALL_USER_VOLUME_STORAGE_KEY = "chatapp_call_user_volumes_v1";
App.callUserVolumes = new Map();
App.callUserMuted = new Set();
App.callScreenVolumes = new Map();
App.callScreenMuted = new Set();
App.callAudioPreferenceScope = null;
App.callAudioPreferencePending = null;
App.callAudioPreferenceTimer = null;
App.callAudioPreferenceWrites = Promise.resolve();
App.callAudioPreferenceCache = new Map();
App.callRemoteNativeVolumeFades = new Map();
App.callQualityTimer = null;
App.callQualityUpdatePending = false;
App.callQualityUpdateQueued = false;
App.callScreenHealthTimer = null;
App.callScreenHealthState = new Map();
App.callConnectionQuality = {
  level: "idle",
  label: "Idle",
  detail: "Join a call to measure connection quality.",
  rttMs: null,
  lossPct: null
};
App.shareViewOpen = false;
App.shareViewUserCode = null;
App.shareViewUsername = null;
App.callWatchedShareCodes = new Set();
App.callMultiViewEnabled = false;
App.callScreenZoom = 100;
App.callScreenZoomCode = "";
App.callFullscreenCode = "";
App.callFocusedShareCode = null;
App.callFocusedControlsCode = null;
App.callFocusedControlsVisible = false;
App.callMenuExpanded = false;
App.callShareViewersRef = null;
App.callShareViewersCb = null;
App.callShareViewersRoomId = null;
App.callShareViewersCache = new Map();
App.callViewerPresenceRefs = new Map();
// share owner -> { ref, roomId, sessionId, shareId }

try {
  // Retire the old persistent setting; volumes now belong to the live call.
  localStorage.removeItem(App.CALL_USER_VOLUME_STORAGE_KEY);
} catch {}

/* Chat calling: playback. Classic script; see CALLING.md. */
});
})(globalThis.ChatApp);
