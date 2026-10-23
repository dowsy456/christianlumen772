/* ui/navigation: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.eyeSVG = function (hidden) {
  if (hidden) {
    return `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
        <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M4 20 20 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }
  return `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
      <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
    </svg>`;
};
App.syncEye = function () {
  App.$("eye-icon").innerHTML = App.eyeSVG(App.loginHidden);
  App.$("login-code").type = App.loginHidden ? "password" : "text";
};
App.bindCreateAccountButton = function () {
  const btn = App.$("btn-go-create");
  if (!btn) return;
  btn.onclick = App.accountCreationEnabled ? () => App.showView("create") : e => {
    e.preventDefault();
    e.stopPropagation();
    App.showToast({
      title: "Maintenance",
      body: "Account creation is under maintenance.",
      duration: 5000
    });
  };
};

App.register("ui/navigation", function initializeFeature() {
App.loginHidden = true;
App.$("btn-toggle-eye").addEventListener("click", () => {
  App.loginHidden = !App.loginHidden;
  App.syncEye();
});
App.accountCreationEnabled = true;
App.bindCreateAccountButton();
App.$("btn-go-login").addEventListener("click", () => App.showView("login"));
App.$("btn-back-from-create").addEventListener("click", () => App.showView("home"));
App.$("btn-back-from-login").addEventListener("click", () => App.showView("home"));
});
})(globalThis.ChatApp);
