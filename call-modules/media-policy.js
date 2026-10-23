/* calling/media-policy: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callPeerWantsScreen = function (peerCode) {
  const runtime = App.callRuntimeConfig();
  // Optional legacy interoperability; default pauses streams without viewers.
  if (runtime.streamScreenToAll === true) return true;
  return globalThis.ChatCallPolicy.wantsScreen(App.callGetMemberByCode(peerCode), String(App.currentUser?.code || ''), App.callScreenShareId);
};
App.callPeerWantsCamera = function (peerCode) {
  if (!App.callCameraShareId) return false;
  return globalThis.ChatCallPolicy.wantsScreen(App.callGetMemberByCode(peerCode), App.callCameraKey(App.currentUser?.code), App.callCameraShareId);
};
App.callGetMediaBudget = function () {
  const subscribers = Array.from(App.callPeerMap.keys()).reduce((count, peer) => count + Number(App.callPeerWantsScreen(peer)) + Number(App.callPeerWantsCamera(peer)), 0);
  return globalThis.ChatCallPolicy.mediaBudget({ subscribers });
};
App.callVideoSendEncodings = function () {
  const budget = App.callGetMediaBudget();
  return [{ maxBitrate: budget.videoBitrate, maxFramerate: budget.maxFramerate, scaleResolutionDownBy: 1 }];
};
App.callPreferEfficientVideoCodecs = function (tx) {
  if (!tx?.setCodecPreferences || tx.__efficientCodecs) return;
  try {
    const codecs = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs;
    if (!codecs?.length) return;
    // H.264 commonly uses the platform encoder; retain every supported fallback
    // for browsers without it. Avoid selecting AV1/VP9 software encode first.
    const rank = codec => ({ 'video/h264': 0, 'video/vp8': 1, 'video/vp9': 2, 'video/av1': 3 })[String(codec.mimeType).toLowerCase()] ?? 4;
    tx.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
    tx.__efficientCodecs = true;
  } catch {}
};
App.callPrepareLocalDescription = function (description) {
  if (!description?.sdp || !['offer', 'answer'].includes(description.type)) return description;
  // libwebrtc otherwise starts video at a small audio-call estimate and ramps
  // up over several seconds. This startup hint still permits normal congestion
  // adaptation; no minimum bitrate is forced on a constrained connection.
  const startKbps = Math.round(Math.min(3000000, App.callGetMediaBudget().videoBitrate) / 1000);
  const sdp = description.sdp.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=video ')) return section;
    const payloads = Array.from(section.matchAll(/^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1|H265)\/90000\r?$/gmi), match => match[1]);
    for (const payload of payloads) {
      const fmtp = new RegExp(`^a=fmtp:${payload} ([^\\r\\n]*)`, 'm');
      if (fmtp.test(section)) {
        section = section.replace(fmtp, (_, value) => {
          const parameters = value.split(';').map(part => part.trim()).filter(part => part && !/^x-google-start-bitrate=/i.test(part));
          return `a=fmtp:${payload} ${[...parameters, `x-google-start-bitrate=${startKbps}`].join(';')}`;
        });
      } else {
        const rtpmap = new RegExp(`(^a=rtpmap:${payload} [^\\r\\n]*)(\\r?\\n|$)`, 'm');
        section = section.replace(rtpmap, (_, line, newline) => `${line}${newline || '\r\n'}a=fmtp:${payload} x-google-start-bitrate=${startKbps}${newline || '\r\n'}`);
      }
    }
    return section;
  }).join('');
  return { type: description.type, sdp };
};
App.callPrimePeerMedia = async function (pc) {
  if (!pc || pc.__closing) return;
  // Encodings may be unavailable before setLocalDescription. Retry as soon as
  // negotiation commits instead of waiting for the six-second health audit.
  await Promise.allSettled([
    App.callApplySenderBudget(pc.__audioTx?.sender, 'audio'),
    App.callApplySenderBudget(pc.__screenTx?.sender, 'video'),
    App.callApplySenderBudget(pc.__cameraTx?.sender, 'camera-video'),
    App.callApplySenderBudget(pc.__screenAudioTx?.sender, 'screen-audio')
  ]);
};
App.callApplySenderBudget = async function (sender, kind) {
  if (!sender?.getParameters || !sender?.setParameters || !sender.track) return;
  const budget = App.callGetMediaBudget();
  const video = kind === 'video' || kind === 'camera-video';
  const degradationPreference = kind === 'camera-video' ? 'balanced' : 'maintain-resolution';
  const settings = sender.track.getSettings?.() || {};
  const desired = kind === 'audio' ? {
    maxBitrate: budget.audioBitrate,
    priority: 'high',
    networkPriority: 'high'
  } : kind === 'screen-audio' ? {
    maxBitrate: budget.screenAudioBitrate,
    priority: 'low',
    networkPriority: 'low'
  } : {
    maxBitrate: budget.videoBitrate,
    maxFramerate: budget.maxFramerate,
    priority: 'low',
    networkPriority: 'low',
    scaleResolutionDownBy: Math.max(1, (Number(settings.width) || budget.width) / budget.width, (Number(settings.height) || budget.height) / budget.height)
  };
  const signature = JSON.stringify([desired, video ? degradationPreference : null, sender.track.id]);
  let state = App.callSenderTuning.get(sender);
  if (!state) {
    state = {
      signature: '',
      pending: null
    };
    App.callSenderTuning.set(sender, state);
  }
  if (state.pending) {
    await state.pending;
    return App.callApplySenderBudget(sender, kind);
  }
  if (state.signature === signature) return;
  const run = (async () => {
    try {
      const parameters = sender.getParameters();
      // Do not invent encodings: WebRTC disallows changing their count.
      if (!parameters.encodings?.length) return;
      Object.assign(parameters.encodings[0], desired);
      // Preserve screen text/detail when bandwidth dips instead of immediately
      // shrinking a 720p source into a blurry thumbnail. Cameras balance motion
      // and detail; both retain a 720p30 target and normal congestion control.
      if (video) parameters.degradationPreference = degradationPreference;
      await sender.setParameters(parameters);
      state.signature = signature;
    } catch (error) {
      // Unsupported optional priorities are retried using widely implemented fields.
      try {
        const basic = sender.getParameters();
        if (!basic.encodings?.length) return;
        basic.encodings[0].maxBitrate = desired.maxBitrate;
        if (video) {
          basic.encodings[0].maxFramerate = desired.maxFramerate;
          basic.encodings[0].scaleResolutionDownBy = desired.scaleResolutionDownBy;
        }
        await sender.setParameters(basic);
        state.signature = signature;
      } catch {}
    }
  })();
  state.pending = run;
  try {
    await run;
  } finally {
    state.pending = null;
  }
};
App.callScheduleMediaBudget = function () {
  if (App.callMediaBudgetTimer || !App.currentCallRoomId) return;
  App.callMediaBudgetTimer = setTimeout(() => {
    App.callMediaBudgetTimer = null;
    void App.callRebalanceMedia();
  }, 120);
};
App.callApplyScreenCaptureBudget = async function (track, budget = App.callGetMediaBudget()) {
  if (track?.readyState !== 'live' || typeof track.applyConstraints !== 'function') return false;
  try {
    await track.applyConstraints({
      width: { ideal: budget.width, max: budget.width },
      height: { ideal: budget.height, max: budget.height },
      frameRate: { ideal: budget.maxFramerate, max: budget.maxFramerate }
    });
    return true;
  } catch {
    // Sender resolution/framerate limits still apply on capture implementations
    // which cannot resize the source track itself.
    return false;
  }
};
App.callRebalanceMedia = async function () {
  if (!App.currentCallRoomId) return;
  if (App.callMediaBudgetPending) {
    App.callMediaBudgetQueued = true;
    return;
  }
  App.callMediaBudgetPending = true;
  try {
    const budget = App.callGetMediaBudget();
    const track = App.callScreenTrack;
    if (track?.readyState === 'live') {
      const signature = JSON.stringify([track.id, budget.width, budget.height, budget.maxFramerate]);
      if (signature !== App.callScreenCaptureBudgetSignature) {
        if (await App.callApplyScreenCaptureBudget(track, budget)) {
          App.callScreenCaptureBudgetSignature = signature;
        }
      }
    }
    await Promise.allSettled(Array.from(App.callPeerMap.values(), async pc => {
      if (!App.callPeerIsCurrent(pc, pc.__peerCode)) return;
      await App.callTuneAudioSender(pc.__audioTx?.sender);
      await App.callSetPeerScreenTrack(pc, App.callSharing ? App.callScreenTrack : null);
      await App.callSetPeerCameraTrack(pc, App.callCameraSharing ? App.callCameraTrack : null);
    }));
  } finally {
    App.callMediaBudgetPending = false;
    // A subscriber can join while capture constraints or another sender is
    // still updating. Replay now instead of waiting for the health heartbeat.
    if (App.callMediaBudgetQueued) {
      App.callMediaBudgetQueued = false;
      App.callScheduleMediaBudget();
    }
  }
};

App.register("calling/media-policy", function initializeFeature() {
App.callMediaBudgetTimer = null;
App.callMediaBudgetPending = false;
App.callMediaBudgetQueued = false;
App.callScreenCaptureBudgetSignature = '';
App.callMediaPressureUntil = 0;
App.callSenderTuning = new WeakMap();
});
})(globalThis.ChatApp);
