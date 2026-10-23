# Third-party software and assets

The supplied application retains its existing Firebase project configuration and its original game code/artwork. Their inclusion does not change the ownership or licenses of those materials.

`activities/merge-party/assets/menu-reference.png` is the user-supplied `Activity start screen.png` from `Merge Party Physics and Design Visual Examples.zip`. The menu displays its machine illustration through a CSS crop; scores and the Play button are live interface controls. The supplied image is preserved unchanged.

`vendor/firebase-app-compat.js` and `vendor/firebase-database-compat.js` are the unchanged Firebase JavaScript SDK 10.12.5 files distributed by Google at:

- https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js
- https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js

Firebase JavaScript SDK: https://github.com/firebase/firebase-js-sdk (Apache License 2.0). License notices in the distributed scripts are preserved.

The existing app may load optional third-party resources for features such as emoji, time synchronization and uploaded HTML. Those features retain their existing service dependencies. This ZIP does not bundle an external TURN or SFU service.

Game recognition uses a sanitized public executable-signature snapshot retrieved on October 8, 2026 from Discord's public detectable-applications endpoint: https://discord.com/api/v9/applications/detectable . The snapshot in `desktop/games.cjs` contains 11,135 Windows executable signatures, independent of this computer's installed games. The desktop can refresh this catalog anonymously; no process list, local paths, or Chat App account data is sent to Discord. The endpoint is an external service and may change or become unavailable; the bundled snapshot and local Steam/Epic manifests remain available.

The Roblox logo, Minecraft grass-block icon, and Fortnite artwork are the corresponding game-identification images distributed through Discord's application-icon CDN. The 64-pixel PNGs are embedded in the existing native/web game-presence modules to avoid broken executable-icon substitutes and image-network failures. Original sources:

- Roblox: https://cdn.discordapp.com/app-icons/363445589247131668/f2b60e350a2097289b3b0b877495e55f.png?size=64
- Minecraft: https://cdn.discordapp.com/app-icons/1402418491272986635/166fbad351ecdd02d11a3b464748f66b.png?size=64
- Fortnite: https://cdn.discordapp.com/app-icons/1402418703554842694/c1864b38910c209afd5bf6423b672022.png?size=64

Game names, logos, and artwork remain the property of their respective owners; their inclusion identifies the running game and does not imply affiliation or transfer ownership. Other catalog icons are loaded from the same CDN. Roblox experience titles, creator names, and thumbnails are resolved through Roblox's public `apis.roblox.com`, `games.roblox.com`, and `thumbnails.roblox.com` endpoints, with completed thumbnails restricted to `rbxcdn.com`.

The desktop includes Electron 44.4.2 and its accompanying license files. The build uses electron-builder 26.15.3 and its 7-Zip toolset. The x64 portable bootstrap is transparent source in `desktop/scripts/benchmark-games.cjs`; it uses standard .NET ZIP/file/process APIs, not a shell or a downloaded runtime script. Shipping JavaScript stays inside the hardened Electron ASAR package, while the shared web bundle retains its existing GitHub update mechanism.

PDF/TXT media viewing: PDF.js (Mozilla, Apache License 2.0), pdfjs-dist 6.4.299, is loaded only when opening a PDF from https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/ . Its worker, CMaps, standard fonts, and WASM support use the same pinned distribution. Project and license: https://github.com/mozilla/pdf.js . No extra source files are added to this archive.

DOCX preview loads **docx-preview 0.4.1** on demand from [the pinned jsDelivr ES module](https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/+esm). Source: [VolodymyrBaydalka/docxjs](https://github.com/VolodymyrBaydalka/docxjs). License: [Apache License 2.0](https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/LICENSE). This ES module resolves its ZIP reader to **JSZip 3.10.2** at `https://cdn.jsdelivr.net/npm/jszip@3.10.2/+esm`.

PPTX preview loads **@aiden0z/pptx-renderer 1.3.0** on demand from [the pinned standalone browser module](https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/dist/aiden0z-pptx-renderer.browser.es.js). Source: [aiden0z/pptx-renderer](https://github.com/aiden0z/pptx-renderer). License: [Apache License 2.0](https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/LICENSE). The upstream bundle includes **JSZip 3.10.1**, Apache ECharts, and **mtx-decompressor 1.4.2**. Upstream license comments remain in the remote bundle. See its [third-party notices](https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/THIRD_PARTY_NOTICES.md), including the MPL-2.0 font decompressor and ECMA DrawingML geometry notices.

JSZip source: [Stuk/jszip](https://github.com/Stuk/jszip). JSZip is available under MIT or GPLv3; this application uses the **MIT option**. Versioned license copies: [3.10.1](https://cdn.jsdelivr.net/npm/jszip@3.10.1/LICENSE.markdown), [3.10.2](https://cdn.jsdelivr.net/npm/jszip@3.10.2/LICENSE.markdown). Its upstream bundle also retains the MIT notice for pako. Apache ECharts source and license: [apache/echarts](https://github.com/apache/echarts), [Apache License 2.0](https://github.com/apache/echarts/blob/master/LICENSE). The unmodified MPL-covered font decompressor's corresponding source is [mtx-decompressor v1.4.2](https://github.com/ChristopherVR/mtx-decompressor/tree/v1.4.2); its license copy is [MPL-2.0](https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/licenses/mtx-decompressor-MPL-2.0.txt).

These document libraries are fetched only when their preview is opened; this archive does not add copies of their library files. Document contents are parsed in the browser and are not uploaded to an Office or Google conversion service. Initial library loading requires internet access. Rendering depends on browser fonts and supported Office features; original downloads remain available.
