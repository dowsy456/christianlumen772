/* Public browser configuration. Never put a provider API key or TURN shared secret here.
 * See CALLING.md for the endpoint response and deployment checks.
 * Empty settings use direct connections with public STUN discovery.
 */
globalThis.CHAT_CALL_CONFIG = globalThis.CHAT_CALL_CONFIG || {
  // Recommended: your authenticated HTTPS service returns short-lived credentials.
  // Use an absolute HTTPS URL if people also open index.html through file://.
  // iceServersEndpoint: 'https://your-calling-service.example/ice',

  // Optional auth hook for that service (example requires Firebase Authentication):
  // getIceAuthorization: async () => 'Bearer ' + await firebase.auth().currentUser.getIdToken(),

  // Alternatively inject deployment-owned, valid RTCIceServer objects:
  // iceServers: [
  //   { urls: ['stun:your-turn.example:3478'] },
  //   { urls: ['turn:your-turn.example:3478?transport=udp',
  //            'turn:your-turn.example:3478?transport=tcp',
  //            'turns:your-turn.example:5349?transport=tcp'],
  //     username: 'short-lived-username', credential: 'short-lived-password' }
  // ],

  iceTransportPolicy: 'all',
  // Screens are sent only to people who explicitly open them. Set true only
  // for compatibility with old clients that do not publish viewer presence.
  streamScreenToAll: false
};

// Public URL only. Deploy the free B2/Cloudflare Worker in README.md, then paste
// its HTTPS address here. B2 application keys belong in Worker secrets, never
// in this public repository. Empty means new file uploads need setup.
globalThis.CHAT_FILE_CONFIG = globalThis.CHAT_FILE_CONFIG || {
  endpoint: 'https://chatapp-files.sackednightmares.workers.dev'
};
