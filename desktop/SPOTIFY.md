# Spotify connection

The supplied public Spotify Client ID is configured in `spotify-config.json` and included in the desktop build. No client secret is used or needed.

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), the app owner must register this exact redirect URI for that Client ID:

```
http://127.0.0.1:43821/spotify/callback
```

Spotify accepts HTTP for explicit loopback IP addresses. The app uses [authorization code with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), a cryptographic state value, and a short-lived listener bound only to `127.0.0.1`. Authorization requests `user-read-currently-playing`, `user-read-playback-state` and `user-modify-playback-state`. Native tokens stay in the native process and are encrypted using Electron `safeStorage` (Windows user-protected storage), separately for each Chat App account. The version 2 Spotify bridge exposes only sanitized playback metadata and an allowlisted set of controls. It does not change the launcher or web update system.

Users connect, reconnect and disconnect in **Settings → Account → Spotify** on the web, mobile and EXE. Existing native connections must reconnect once to grant playback permissions. Disconnect clears the song, stops polling, and deletes that local authorization. Logout stops publishing. The native encrypted connection is available when that account logs back in.

Web/mobile use the same public Client ID and a same-origin PKCE redirect back to the hosted app directory, including its trailing slash. That exact HTTPS URI must be registered in the existing Spotify app. `window.CHAT_SPOTIFY_CONFIG` can specify a same-origin `redirectUri` and public `clientId` before modules initialize if an existing deployment uses a different registered path. There is no client secret. Browser tokens and the one-use authorization verifier stay in `sessionStorage` for the current tab and account, never Firebase, URLs, or presence records. Closing the tab clears this browser connection. OAuth uses a full-page redirect so mobile browsers do not need popups. Local file previews cannot authorize Spotify.

The compact player appears below call controls in the fixed sidebar dock. It includes album/title/artist, seek and elapsed/duration, shuffle, previous, pause, next, and all/one/off repeat. Commands update the local controls immediately, execute in order, reconcile with the server, and roll back failed changes. Playing state is checked every 1.5 seconds; progress interpolates locally every 250 ms. Spotify's retry delays take precedence. Remote playback changes still depend on Spotify API and network latency; zero external delay cannot be guaranteed. Paused playback, local files, ads, and unavailable playback clear the indicator. Only song metadata is written to a session-owned Firebase presence record; server-side disconnect cleanup and a 90-second lease remove stale activity after network loss or crashes. Artist/title/artwork are shown on profiles, and the play action opens the Spotify desktop protocol with an HTTPS fallback. Remote controls require Spotify Premium and an active controllable device; unsupported devices and denied access produce explicit feedback.

As of September 2026, Spotify's [development-mode documentation](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) requires a Premium app owner and allows up to five allowlisted authenticated users. Each intended Spotify account needs to be allowed by the app owner unless Spotify has granted extended quota access. A successful browser sign-in by itself does not prove API access; Spotify can return 403 for a user who is not allowed. This is controlled by Spotify, outside Chat App's source code.

The implementation is covered by native PKCE, token isolation, late-response, rate-limit, public-presence and browser UI tests. Actual Spotify sign-in and redirect registration require the app owner's Spotify configuration and an authorized account; they were not asserted by the automated tests. No tests write to live Firebase.

Native sign-in now survives a trusted Chat App refresh or shared web update. Reopening an earlier Spotify browser tab restarts the active authorization flow; its stale code is never exchanged with the current verifier. Cancel and the three-minute deadline also release the loopback listener if Windows has not finished opening the browser. Browser Connect clicks are serialized before generating PKCE, interrupted redirects expire, and request deadlines cover response bodies. Tokens and verifiers retain the same private storage boundaries described above.

Run:

```
node --test desktop/tests/spotify.test.cjs tests/spotify-presence.test.cjs
node tests/spotify.browser.cjs
```
