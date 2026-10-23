/* profiles/avatar-defaults: methods register before ordered initialization. */
(function (App) {
  "use strict";
let defaultAvatar = "";
App.defaultStickmanDataURL = function () {
  if (defaultAvatar) return defaultAvatar;
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs>
      <radialGradient id="g" cx="35%" cy="30%" r="75%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity=".22"/>
        <stop offset="55%" stop-color="#6ea8ff" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="256" height="256" rx="128" fill="#0f1218"/>
    <circle cx="128" cy="128" r="120" fill="url(#g)"/>
    <circle cx="128" cy="88" r="28" fill="none" stroke="#e9eefc" stroke-opacity=".92" stroke-width="10"/>
    <path d="M128 118 L128 180" stroke="#e9eefc" stroke-opacity=".92" stroke-width="10" stroke-linecap="round"/>
    <path d="M88 142 L168 142" stroke="#e9eefc" stroke-opacity=".92" stroke-width="10" stroke-linecap="round"/>
    <path d="M104 210 L128 180 L152 210" fill="none" stroke="#e9eefc" stroke-opacity=".92" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  defaultAvatar = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.trim());
  return defaultAvatar;
};
App.scheduleNameAvatarDataURL = function (name) {
  const label = String(name || "Player").replace(/\s+/g, " ").trim().slice(0, 20) || "Player";
  if (App.scheduleNameAvatarCache.has(label)) return App.scheduleNameAvatarCache.get(label);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return App.defaultStickmanDataURL();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontFamily = getComputedStyle(document.body).fontFamily || "Inter, Arial, sans-serif";
  let fontSize = 216;
  while (fontSize > 54) {
    ctx.font = `900 ${fontSize}px ${fontFamily}`;
    if (ctx.measureText(label).width <= 424) break;
    fontSize -= 4;
  }
  ctx.font = `900 ${fontSize}px ${fontFamily}`;
  ctx.fillText(label, 256, 266, 424);
  const dataURL = canvas.toDataURL("image/png");
  App.scheduleNameAvatarCache.set(label, dataURL);
  return dataURL;
};

App.register("profiles/avatar-defaults", function initializeFeature() {
App.scheduleNameAvatarCache = new Map();
});
})(globalThis.ChatApp);
