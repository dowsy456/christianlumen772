/* tools/camera: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.openCameraModal = async function () {
  App.stopCameraModalStream();
  App.openModal({
    title: "Camera",
    size: "camera",
    bodyHTML: `
      <div class="camera-app">
        <button class="btn primary camera-toggle" id="btn-camera-toggle" type="button" aria-pressed="false">Turn camera on</button>
        <div class="muted small camera-status" id="camera-permission-status" aria-live="polite">Camera is off.</div>
        <div class="camera-preview-shell">
          <video id="camera-preview" autoplay playsinline muted hidden></video>
          <div class="camera-off-state" id="camera-off-state" aria-hidden="true">Camera off</div>
        </div>
      </div>
    `,
    onBeforeClose: App.stopCameraModalStream
  });
  const button = App.$("btn-camera-toggle");
  const statusEl = App.$("camera-permission-status");
  const videoEl = App.$("camera-preview");
  const offStateEl = App.$("camera-off-state");
  const syncOff = (message = "Camera is off.") => {
    App.stopCameraModalStream();
    if (videoEl) {
      try {
        videoEl.pause();
      } catch {}
      videoEl.srcObject = null;
      videoEl.hidden = true;
    }
    if (offStateEl) offStateEl.hidden = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Turn camera on";
      button.setAttribute("aria-pressed", "false");
    }
    if (statusEl) statusEl.textContent = message;
  };
  button?.addEventListener("click", async () => {
    if (window.__cameraModalStream) {
      syncOff();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      syncOff("Camera access is not supported in this browser.");
      return;
    }
    button.disabled = true;
    button.textContent = "Starting camera…";
    if (statusEl) statusEl.textContent = "Waiting for camera permission…";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user"
        },
        audio: false
      });
      if (App.modalEl.hidden || App.modalClosing || !App.modalEl.classList.contains("is-open") || App.$("btn-camera-toggle") !== button) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      window.__cameraModalStream = stream;
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.hidden = false;
        try {
          await videoEl.play();
        } catch {}
      }
      if (offStateEl) offStateEl.hidden = true;
      button.disabled = false;
      button.textContent = "Turn camera off";
      button.setAttribute("aria-pressed", "true");
      if (statusEl) statusEl.textContent = "Camera is on.";
      stream.getVideoTracks().forEach(track => {
        track.addEventListener("ended", () => {
          if (window.__cameraModalStream === stream) syncOff("Camera stopped.");
        }, {
          once: true
        });
      });
    } catch (error) {
      const denied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
      syncOff(denied ? "Camera permission was denied." : "Camera could not be started.");
    }
  });
};

App.register("tools/camera", function initializeFeature() {

});
})(globalThis.ChatApp);
