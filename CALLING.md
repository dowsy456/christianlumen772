# Calling deployment and verification

The app keeps the existing Firebase signaling and WebRTC audio/screen-sharing behavior. `index.html` remains the entry page for local files and HTTPS hosting. Calling features live in `call-modules/` and `js/calling/`; `js/module-manifest.js` lists their order. No bundler or server is needed to open the app. Firebase, microphone permissions and network access are still needed for calls.

## What changed

- October 5: shared sidebar/panel connection presentation; worst-path bidirectional voice measurements; explicit missing/stale data states; serialized SDP answer publication/renegotiation; retryable ICE publication; bounded parallel playback recovery; mobile interrupted-context recovery; server-clock-safe presence checks.

- September 29: screen and camera captures retain 720p30 / 4 Mbit/s per subscribed path. Screen senders preserve resolution/detail during congestion and cameras balance motion and detail. Normal congestion control remains active; actual resolution/frame rate still depends on the source, device and network. Tuning follows capture-track replacements immediately. Opening another screen/camera preserves existing watched streams, and closing one only stops its own subscription.
- Connection measurements use the selected ICE candidate pair, avoiding stale nominated paths after recovery. Camera/screen byte counters and inbound packet counters are tracked per RTP stream, so starting/stopping one stream cannot corrupt another stream's bitrate/loss measurement. Independent peer stats requests run concurrently; diagnostics include per-stream encoded dimensions, FPS, bitrate and quality limitation. Poor/disconnected status text matches its indicator. The old direct-mode notice is replaced by one “Connected” toast lasting one second, after a remote media connection succeeds (or an acknowledged solo join).

- September 20 revision 8: a lifecycle-guarded transaction publishes the call generation and confirmed member together. Concurrent starters share one generation and send one room invitation. The joining client suspends its heartbeat/VAD/viewer publication until the commit is acknowledged; SDK transaction cancellations retry without continuing an ended lifecycle. Session-checked departure removes the final member and call metadata together, keeping the complete root cached until cleanup finishes. Tests use the actual bundled Firebase SDK to exercise simultaneous starts, simultaneous departures, timeouts, and delayed rejoin cleanup.
- Screen start/stop effects reach every current participant. Watch start/stop effects reach the sharer and other continuing watchers of that screen, with quiet initial/reconnect baselines and generation checks. They use the shared sound-effects mixer and saved preferences. Deafen gates both voice and screen playback paths, including new tracks and autoplay recovery. Muted input/screen sliders show 0% while retaining their chosen levels for unmute.

- Screen capture excludes this app's audio output while preserving normal local call playback. Primary capture and its compatibility retry retain the exclusion request. Returned system-audio mixes without confirmed exclusion are removed without stopping video or microphone audio. See [DESKTOP-OVERLAY.md](DESKTOP-OVERLAY.md).

- Desktop version 1.1.0 adds the native call overlay and main call-panel toggle. Live roster, profile and voice-activity events publish through an isolated Electron bridge; ordinary browsers do not expose the control. See [DESKTOP-OVERLAY.md](DESKTOP-OVERLAY.md) for behavior, update compatibility, and rebuilding the EXE.
- Audio device lists use the existing enhanced select with a popup above the settings menu. The popup is part of the menu's focus and click handling, so its visible rows can be selected without dismissing the parent. Device labels, options and selections synchronize after discovery, capture, permission changes and device changes. Settings menus inherit the existing `msgMenuIn` / `msgMenuOut` animations, including animated dismissal and safe rapid reopening.
- Input discovery can recover permission-hidden lists through Show Devices, using a temporary, unpublished microphone stream that stops after enumeration, including failures. Output selection never requests microphone access: it lists available speakers, exposes the native Choose Output Device action when supported, and otherwise offers Refresh Devices if no list is exposed. A successful call microphone capture also refreshes enumeration without another permission request. The active raw microphone supplies its label if enumeration hides it. Menus refresh on focus and remain open during native device dialogs; stale enumeration and device-switch completions cannot overwrite newer results. Explicit System default microphone selection remains the system default during refresh. The web code is shared by local-file, hosted and Electron use; the host still controls media permissions.
- A six-person room gives each participant five peer connections. Independent participants initialize concurrently. Deterministic initial offers avoid simultaneous glare collisions; the existing session-scoped perfect-negotiation handling still resolves later simultaneous changes. Answerers wait for the offered media sections and attach their microphone before creating the answer. This fixes a verified one-way-audio bug where prematurely created answer-side transceivers were left unused while the answered audio section remained receive-only.
- Microphone audio uses mono speech processing with a 48 kbit/s sender cap. Screen capture targets 1280 × 720 at 30 fps, with a 4 Mbit/s cap for each subscribed viewer, independent of participant count. Encoder statistics and connection hints no longer globally lower capture FPS or divide the screen budget. WebRTC still adapts each path to real congestion. Mesh upload demand grows with the number of viewers, so hardware and available bandwidth determine the delivered result.
- Both the main controls and sidebar have microphone and deafen dropdown arrows. The input menu offers input devices, a 0–100% microphone volume slider, and Refresh Microphone with its original icon. Refresh reopens the selected input instead of asking the user to choose again. Input gain is applied to the outbound microphone track before WebRTC transmission. Mute/deafen and microphone health recovery continue to control the physical capture and processed track.
- The output menu offers available output devices and a 0–200% overall call volume slider. Output gain multiplies each user's or screen's independent volume. Gain changes are smoothed, and Web Audio playback is mixed through a shared compressor and bounded output stage to limit boosted peaks. Hardware loudness still depends on the device/system volume. Browsers without output routing support show the system-default route; device access remains subject to browser permissions.
- Screens use separate stable video and audio transceivers alongside the microphone. The browser capture picker offers audio for supported sources; the user must enable its Share audio option. Capture audio receives a separate 96–128 kbit/s budget and is never mixed into the microphone. Closing a screen or the call panel pauses its video and audio subscription while microphone audio continues. Retained receivers support immediate stop/restart without requiring another `ontrack` event.
- Right-click any watched screen, focused or unfocused, for its username, Mute, and independent 0–400% volume. Each screen defaults to 100% and unmuted. The shared playback engine supports autoplay recovery, deafen, native audio, and Web Audio gain above 100%; local screen previews stay silent.
- Input volume, output volume, user volumes, screen volumes and screen mute preferences are stored per listener under `calls/<room>/audioPreferences/<user>` for that call's `instanceId`. Input/output default to 100%. Leaving and rejoining a continuing call restores them. Removing the final participant deletes the call and its preferences. Generation-checked writes cannot recreate an ended call or affect its replacement. The old localStorage volume setting is removed. Device choices remain in memory for the current page session.
- Focused controls start visible. Clicking the actual video toggles the top bar, call controls, screen controls, viewers display, and bottom-right In Call roster together. The roster opens only while hovered and closes when the pointer leaves. The empty screen-header overlay passes clicks through to the video. Call-menu rendering coalesces nested updates, commits one stage, and deduplicates member identities.
- Speaking transitions patch avatar classes rather than replacing the call panel and reconnecting its video elements. Trailing speaking writes prevent a dropped `speaking:false` update from leaving a green ring stuck on. VAD work is reduced from 2048 samples every 60 ms to 512 samples every 100 ms.
- Stats are cached and coalesced per peer, normally every two seconds and every twelve seconds when hidden. Packet loss uses interval deltas instead of the entire call's lifetime. Sender tuning is serialized and skipped when the budget is unchanged.
- Missing, hidden, paused or static screen tiles no longer trigger destructive connection resets every twelve seconds. Media checks repair subscriptions and playback; actual transport failures use one coalesced recovery path with a disconnect grace period and backoff. Duplicate ICE/connection failure events no longer exhaust the retry budget twice. A stuck unanswered offer is rolled back before retry. ICE candidates retain their generation, are bounded in memory, and accept the same ICE generation across ordinary SDP changes.
- An initial Firebase connection event and healthy media during a signaling reconnect no longer force an ICE restart. Peer transports are preserved through brief signaling outages. Session changes and explicit leave still clean up their transports.
- The embedded third-party relay password has been removed. Deployments can supply fresh credentials and refresh them before expiry. Do not expect a password copied into a public app to provide an indefinitely available relay service.

## Configure a TURN relay

Direct/STUN connections cannot traverse every NAT, firewall, school network or corporate network. Configure a TURN server you control, or a provider you choose, in `call-config.js`. TURN can be self-hosted; a paid service is not required. The app does not create, charge for, or provision a service.

The recommended `iceServersEndpoint` is an authenticated HTTPS endpoint which returns:

```json
{
  "iceServers": [
    { "urls": ["stun:turn.example.com:3478"] },
    {
      "urls": [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turns:turn.example.com:5349?transport=tcp"
      ],
      "username": "temporary-user",
      "credential": "temporary-password"
    }
  ],
  "ttlSeconds": 600
}
```

It can return `expiresAt` as a Unix timestamp in milliseconds or seconds instead of `ttlSeconds`. Issue credentials with at least 60 seconds remaining. The browser rejects expired responses, refreshes about 60 seconds before expiry while in a call, deduplicates refresh requests, and updates existing peer configurations. When changed credentials arrive for an established relay path, one deterministic endpoint requests a new ICE generation while existing media continues; unchanged credentials and direct paths do not trigger that refresh restart. Requests time out after 4.5 seconds, including the optional authorization hook. Failed refreshes back off; valid cached credentials remain usable until expiry. With no usable relay, direct/STUN mode remains available; relay availability is reported by `getChatCallDiagnostics()` without an intrusive startup toast.

Keep provider API keys and coturn shared secrets on the server. The browser should receive only short-lived RTCIceServer credentials. If using `getIceAuthorization`, match its bearer token to authentication your endpoint actually verifies; the app's existing chat user object is not automatically a Firebase Authentication account. CORS must permit your Pages origin and the Authorization header. A `file://` browser sends a `null` origin; use an absolute HTTPS endpoint and deliberately configure authenticated access for that case if local calling needs TURN. Do not treat CORS as authentication or expose an unrestricted relay credential endpoint.

To test relay-only connectivity temporarily set `iceTransportPolicy: 'relay'` with valid TURN credentials. A relay-only configuration without a working relay correctly cannot connect. Restore `all` after testing to permit direct connections.

`getChatCallDiagnostics()` in the browser console returns transport states, current bitrate budget, recent audio loss/latency, whether selected candidate pairs use a relay, and credential status. It does not return relay passwords, SDP or candidate IP addresses. Connection-quality hover text remains available in the call panel.

## Six-participant expectations

These changes reduce the load of six-person audio calls and occasional screen sharing; they do not guarantee zero lag on unknown hardware and networks. In a mesh, six participants require 15 peer pairs/30 peer connections across all devices. A participant broadcasting to five viewers still sends five encoded streams, and TURN relays rather than combines them. Simultaneous screen shares, 4K displays, low upload bandwidth, thermal throttling and browser capture limitations can remain bottlenecks.

For dependable six-person use with simultaneous screens across varied devices, deploy an SFU media server (for example a self-hosted WebRTC forwarding service), authentication/token issuance and client integration. That is a separate server architecture; no such server or usable credentials were supplied with these three files. This package does not falsely claim that splitting JavaScript or configuring TURN creates an SFU.

Automated tests exercise policy, six isolated fake clients, sender budgets, subscription changes, interval stats, offer/ICE edge cases, recovery coalescing and long simulated calls. They cannot certify physical microphone quality, sustained browser encoder CPU use, NAT traversal, TURN uptime or real-world latency. Before production acceptance, run six real browsers/devices on at least two networks for 30 minutes, have each participant speak, switch one shared screen among all viewers, then try multiple simultaneous shares. Check selected relay candidates in a relay-only run; test network loss/recovery, microphone permission denial, muted/deafened users and leave/rejoin. Use the diagnostics to inspect actual transport recovery and packet loss. Screen capture requires a supported browser and user gesture; some mobile browsers support viewing only.

## References

- [W3C Screen Capture: audio source and user selection](https://www.w3.org/TR/screen-capture/)
- [W3C WebRTC: transceivers and sender encoding parameters](https://www.w3.org/TR/webrtc/)
- [W3C WebRTC statistics: selected candidate pairs and RTP stream counters](https://www.w3.org/TR/webrtc-stats/)
- [WebRTC perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [RTCRtpSender.setParameters and encoding limits](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [Changing ICE server configuration](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/setConfiguration)
- [ICE restart and negotiation](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce)
