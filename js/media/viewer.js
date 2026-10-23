/* media/viewer: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.getDocumentPreviewKind = function (name, mime = "") {
  const extension = String(name || "").toLowerCase().split(".").pop();
  const type = String(mime || "").toLowerCase().split(";")[0];
  if (extension === "pdf" || type === "application/pdf") return "pdf";
  if (["html", "htm"].includes(extension) || type === "text/html") return "html";
  if (extension === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (extension === "pptx" || type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (/^(txt|md|markdown|csv|tsv|json|xml|yaml|yml|log|ini|conf|css|js|jsx|ts|tsx|py|sh|sql|c|cpp|h|java|rs|toml)$/.test(extension) || type.startsWith("text/") || /^(application\/(json|xml|javascript))$/.test(type)) return "text";
  return "";
};
App.nextMediaZoomScale = function (scale, direction, max = 20) {
  const current = Math.max(1, Number(scale) || 1);
  if (direction > 0) return Math.min(max, current < 5 ? Math.min(5, current + 0.5) : current + 1);
  return Math.max(1, current > 5 ? Math.max(5, current - 1) : current - 0.5);
};
App.updateMediaZoomOverlap = function (controls, targets, clip = null) {
  if (!controls) return;
  const button = controls.getBoundingClientRect();
  const boundary = clip?.getBoundingClientRect();
  const overlaps = Array.from(targets).some(target => {
    const rect = target.getBoundingClientRect();
    let { left, top, width, height } = rect;
    // A video's element box can include black letterboxing; only its painted
    // image counts as overlap, including after a CSS zoom/pan transform.
    if (target.tagName === "VIDEO" && target.videoWidth && target.videoHeight) {
      const fit = Math.min(width / target.videoWidth, height / target.videoHeight);
      const w = target.videoWidth * fit, h = target.videoHeight * fit;
      left += (width - w) / 2; top += (height - h) / 2; width = w; height = h;
    }
    const right = Math.min(left + width, boundary?.right ?? Infinity);
    const bottom = Math.min(top + height, boundary?.bottom ?? Infinity);
    left = Math.max(left, boundary?.left ?? -Infinity); top = Math.max(top, boundary?.top ?? -Infinity);
    return right > left && bottom > top && button.left < right && button.right > left && button.top < bottom && button.bottom > top;
  });
  controls.classList.toggle("is-over-content", overlaps);
};
App.fitOfficeDocumentToWidth = function (scroll, content, naturalWidth) {
  // Documents retain their natural scrolling, selection, touch and keyboard
  // behavior. Only the viewport width determines the responsive page fit.
  content.style.width = `${naturalWidth}px`;
  const fit = () => {
    const style = getComputedStyle(scroll);
    const available = Math.max(1, scroll.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
    content.style.zoom = String(Math.min(1, available / naturalWidth));
  };
  const resize = new ResizeObserver(fit);
  resize.observe(scroll); fit();
  return () => resize.disconnect();
};
App.loadOfficeViewerLibrary = function (kind) {
  App.officeViewerLibraries ||= new Map();
  if (!App.officeViewerLibraries.has(kind)) {
    // Pinned, browser-only renderers: files are parsed locally, never submitted
    // to an Office/Google document conversion service.
    const url = kind === "docx" ? "https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/+esm" : "https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.3.0/dist/aiden0z-pptx-renderer.browser.es.js";
    const promise = import(url).catch(error => { App.officeViewerLibraries.delete(kind); throw error; });
    App.officeViewerLibraries.set(kind, promise);
  }
  return App.officeViewerLibraries.get(kind);
};
App.loadPdfViewerLibrary = function () {
  if (!App.pdfViewerLibraryPromise) {
    const base = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/";
    App.pdfViewerLibraryPromise = import(`${base}build/pdf.min.mjs`).then(library => {
      library.GlobalWorkerOptions.workerSrc = `${base}build/pdf.worker.min.mjs`;
      return { library, base };
    }).catch(error => { App.pdfViewerLibraryPromise = null; throw error; });
  }
  return App.pdfViewerLibraryPromise;
};
App.mountDocumentViewer = function (mount, kind, src, fileName) {
  let closed = false, pdfTask = null, observer = null, stopDocumentFit = null, officeViewer = null;
  const abort = new AbortController();
  const renderTasks = new Set();
  const destroyPdfTask = () => {
    const task = pdfTask; pdfTask = null;
    try { Promise.resolve(task?.destroy?.()).catch(() => {}); } catch {}
  };
  mount.innerHTML = '<section class="media-document"><p class="media-document-status" role="status">Loading Document…</p></section>';
  const shell = mount.firstElementChild;
  const alive = () => !closed && mount.isConnected;
  const nativePdf = message => {
    if (!alive()) return;
    stopDocumentFit?.(); stopDocumentFit = null;
    observer?.disconnect();
    for (const task of renderTasks) { try { task.cancel(); } catch {} }
    destroyPdfTask();
    shell.replaceChildren();
    const status = document.createElement("p"); status.className = "media-document-status"; status.textContent = message;
    const frame = document.createElement("iframe"); frame.className = "media-document-pdf"; frame.title = fileName || "PDF Document"; frame.src = `${src}#toolbar=1&navpanes=1&view=FitH`;
    const fallback = document.createElement("button"); fallback.type = "button"; fallback.className = "btn media-document-open"; fallback.textContent = "Download PDF";
    fallback.addEventListener("click", () => App.downloadFileViaObjectURL(src, fileName || "document.pdf"));
    shell.append(status, frame, fallback);
  };
  (async () => {
    try {
      if (kind === "text" || kind === "html") {
        const response = await fetch(src, { signal: abort.signal });
        if (!response.ok) throw new Error(`Document request failed (${response.status})`);
        const content = await response.text();
        if (!alive()) return;
        if (kind === "html") {
          const frame = document.createElement("iframe");
          frame.className = "media-document-html"; frame.title = fileName || "HTML Preview";
          // Scripts may run inside the document, but the opaque sandbox cannot
          // reach app storage, navigate the app, open windows, or submit forms.
          frame.setAttribute("sandbox", "allow-scripts"); frame.referrerPolicy = "no-referrer";
          frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1">${content}`;
          shell.replaceChildren(frame); return;
        }
        const text = document.createElement("pre"); text.className = "media-document-text"; text.tabIndex = 0; text.setAttribute("aria-label", fileName || "Text Document"); text.textContent = content;
        shell.replaceChildren(text);
        return;
      }
      if (kind === "docx" || kind === "pptx") {
        const [library, response] = await Promise.all([App.loadOfficeViewerLibrary(kind), fetch(src, { signal: abort.signal })]);
        if (!response.ok) throw new Error(`Document request failed (${response.status})`);
        const buffer = await response.arrayBuffer();
        if (!alive()) return;
        const scroll = document.createElement("div"); scroll.className = "media-office-pages"; scroll.tabIndex = 0; scroll.setAttribute("aria-label", fileName || "Document Pages");
        const content = document.createElement("div"); content.className = "media-office-content";
        // Keep document styles inside a shadow tree instead of exposing the
        // application's controls to styles from the file.
        const shadow = content.attachShadow({ mode: "open" });
        const styles = document.createElement("div"), body = document.createElement("div");
        shadow.append(styles, body); scroll.append(content); shell.replaceChildren(scroll);
        const blockLinks = event => { if (event.composedPath().some(node => node?.tagName === "A")) event.preventDefault(); };
        shadow.addEventListener("click", blockLinks);
        if (kind === "docx") {
          await library.renderAsync(buffer, body, styles, { className: "docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, renderAltChunks: false, useBase64URL: true });
        } else {
          officeViewer = await library.PptxViewer.open(buffer, body, { zipLimits: library.RECOMMENDED_ZIP_LIMITS, renderMode: "list", width: Math.max(280, scroll.clientWidth - 32), scrollContainer: scroll, pdfjs: false, signal: abort.signal });
        }
        if (!alive()) { officeViewer?.destroy(); officeViewer = null; return; }
        const fit = document.createElement("style");
        fit.textContent = ":host{display:block} .docx-wrapper{background:transparent!important;padding:12px!important} .docx-wrapper>section.docx{margin:0 auto 16px!important} a{pointer-events:none} img{max-width:100%}";
        shadow.append(fit);
        stopDocumentFit = App.fitOfficeDocumentToWidth(scroll, content, Math.max(scroll.clientWidth - 24, body.scrollWidth));
        return;
      }
      const { library, base } = await App.loadPdfViewerLibrary();
      if (!alive()) return;
      pdfTask = library.getDocument({ url: src, isEvalSupported: false, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/` });
      const pdf = await pdfTask.promise;
      if (!alive()) return;
      shell.innerHTML = '<div class="media-pdf-toolbar"><button class="btn" type="button" data-pdf="previous" aria-label="Previous Page">‹</button><label>Page <input data-pdf="page" type="number" min="1" value="1" aria-label="PDF Page" /></label><span data-pdf="total"></span><button class="btn" type="button" data-pdf="next" aria-label="Next Page">›</button></div><div class="media-pdf-pages" tabindex="0" aria-label="PDF Pages"></div>';
      const scroll = shell.querySelector(".media-pdf-pages"), input = shell.querySelector('[data-pdf="page"]');
      const previous = shell.querySelector('[data-pdf="previous"]'), next = shell.querySelector('[data-pdf="next"]');
      input.max = String(pdf.numPages); shell.querySelector('[data-pdf="total"]').textContent = `/ ${pdf.numPages}`;
      const pageStack = document.createElement("div"); pageStack.className = "media-pdf-stack"; scroll.append(pageStack);
      const pages = [], activePages = new Set(); let current = 1;
      const first = await pdf.getPage(1), firstViewport = first.getViewport({ scale: 1 });
      if (!alive()) return;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = document.createElement("section"); page.className = "media-pdf-page"; page.dataset.page = String(number); page.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`; page.setAttribute("aria-label", `Page ${number}`);
        pages.push(page); pageStack.append(page);
      }
      const render = async holder => {
        if (!alive() || holder.dataset.rendering || holder.querySelector("canvas")) return;
        holder.dataset.rendering = "1";
        let task = null;
        try {
          const page = await pdf.getPage(Number(holder.dataset.page));
          if (!alive() || !activePages.has(holder)) return;
          const natural = page.getViewport({ scale: 1 });
          holder.style.aspectRatio = `${natural.width} / ${natural.height}`;
          const scale = Math.min(2, window.devicePixelRatio || 1) * Math.min(1400, holder.clientWidth || 600) / natural.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); canvas.setAttribute("aria-label", `Page ${holder.dataset.page}`);
          holder.append(canvas);
          task = page.render({ canvasContext: canvas.getContext("2d"), viewport }); renderTasks.add(task);
          await task.promise;
          if (!activePages.has(holder)) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
        } catch (error) {
          if (alive() && error?.name !== "RenderingCancelledException") { holder.textContent = "Could Not Render This Page"; }
        } finally { if (task) renderTasks.delete(task); delete holder.dataset.rendering; }
      };
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) { activePages.add(entry.target); void render(entry.target); }
          else {
            activePages.delete(entry.target);
            if (!entry.target.dataset.rendering) for (const canvas of entry.target.querySelectorAll("canvas")) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
          }
        }
      }, { root: scroll, rootMargin: "400px 0px" });
      pages.forEach(page => observer.observe(page));
      const sync = () => {
        const top = scroll.getBoundingClientRect().top;
        const atBottom = scroll.scrollTop > 0 && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 2;
        current = atBottom ? pages.length : Math.max(1, pages.findIndex(page => page.getBoundingClientRect().bottom > top + 24) + 1);
        if (document.activeElement !== input) input.value = String(current);
        previous.disabled = current <= 1; next.disabled = current >= pages.length;
      };
      const go = number => {
        current = Math.max(1, Math.min(pages.length, Math.round(Number(number) || 1)));
        const target = pages[current - 1];
        scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10;
        input.value = String(current); sync();
      };
      previous.addEventListener("click", () => go(current - 1)); next.addEventListener("click", () => go(current + 1));
      input.addEventListener("change", () => go(input.value)); input.addEventListener("keydown", event => { if (event.key === "Enter") go(input.value); });
      scroll.addEventListener("scroll", sync, { passive: true }); sync();
    } catch (error) {
      if (!alive()) return;
      if (kind === "pdf") nativePdf("Using Your Browser’s PDF Viewer. If It Cannot Display This File, Download It Below.");
      else {
        stopDocumentFit?.(); stopDocumentFit = null;
        const status = document.createElement("p"); status.className = "media-document-status"; status.setAttribute("role", "status"); status.textContent = "Could Not Load This Preview. Download The File To Open It.";
        const download = document.createElement("button"); download.className = "btn media-document-open"; download.textContent = "Download Document"; download.type = "button";
        download.addEventListener("click", () => App.downloadFileViaObjectURL(src, fileName));
        shell.replaceChildren(status, download);
      }
    }
  })();
  return () => { closed = true; abort.abort(); stopDocumentFit?.(); officeViewer?.destroy(); officeViewer = null; observer?.disconnect(); for (const task of renderTasks) { try { task.cancel(); } catch {} } destroyPdfTask(); };
};
App.cleanupMediaModalSrcCache = function () {
  for (const entry of App.mediaModalSrcCache.values()) {
    try {
      if (entry?.url && String(entry.url).startsWith("blob:")) URL.revokeObjectURL(entry.url);
    } catch {}
  }
  App.mediaModalSrcCache.clear();
};
App.bindMediaModalSrcCacheCleanup = function () {
  if (App.mediaModalSrcCacheBound) return;
  App.mediaModalSrcCacheBound = true;
  window.addEventListener("pagehide", App.cleanupMediaModalSrcCache);
  window.addEventListener("beforeunload", App.cleanupMediaModalSrcCache);
};
App.getFastMediaModalSrc = async function (dataURL, mimeType = "") {
  const src = String(dataURL || "").trim();
  if (!src) return "";
  if (!/^data:/i.test(src)) return src;
  App.bindMediaModalSrcCacheCleanup();
  const hit = App.mediaModalSrcCache.get(src);
  if (hit?.url) return hit.url;
  if (hit?.promise) return hit.promise;
  const promise = (async () => {
    try {
      const res = await fetch(src);
      const rawBlob = await res.blob();
      const type = String(mimeType || rawBlob.type || "").trim();
      const blob = type && rawBlob.type !== type ? rawBlob.slice(0, rawBlob.size, type) : rawBlob;
      const url = URL.createObjectURL(blob);
      App.mediaModalSrcCache.set(src, {
        url,
        ts: Date.now()
      });
      return url;
    } catch {
      App.mediaModalSrcCache.delete(src);
      return src;
    }
  })();
  App.mediaModalSrcCache.set(src, {
    promise,
    ts: Date.now()
  });
  return promise;
};
App.openMediaModal = function (kind, dataURL, {
  fileName = null,
  mimeType = "",
  stickerRecord = null
} = {}) {
  const src = String(dataURL || "").trim();
  if (!src) return;
  const isStickerViewer = !!stickerRecord;
  const isStickerVideo = isStickerViewer && String(stickerRecord?.kind || kind) === "video";
  const modalTitle = fileName ? String(fileName) : isStickerViewer ? "Sticker" : "Media";
  const mountId = `media_mount_${Math.random().toString(36).slice(2, 9)}`;
  let mediaPlayerId = "";
  let mediaZoomTeardown = null;
  let mediaViewerClosed = false;
  function initMediaZoomViewer(root, cfg = {}) {
    if (!root) return () => {};
    const viewport = root.querySelector(".media-zoom-viewport");
    const target = root.querySelector(".media-zoom-target");
    const btnReset = root.querySelector('[data-media-zoom="reset"]');
    const readout = root.querySelector('[data-media-zoom="percent"]');
    const controls = root.querySelector(".media-zoom-controls");
    if (!viewport || !target) return () => {};
    const maxScale = App.clampNum(Math.max(Number(cfg.maxScale) || 0, 20), 1.25, 24, 20);
    const dblScale = App.clampNum(cfg.doubleTapScale, 1.25, maxScale, 2.5);
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragPanStartX = 0;
    let dragPanStartY = 0;
    let pinchDistance = 0;
    let pinchStartScale = 1;
    let pointerDownX = 0;
    let pointerDownY = 0;
    let clickCanceledByDrag = false;
    const clickDragThreshold = 6;
    const pointers = new Map();
    const off = [];
    function getLimits(nextScale = scale) {
      const rect = viewport.getBoundingClientRect();
      const baseW = target.clientWidth || rect.width || 0;
      const baseH = target.clientHeight || rect.height || 0;
      const extraX = Math.max(0, (baseW * nextScale - rect.width) / 2);
      const extraY = Math.max(0, (baseH * nextScale - rect.height) / 2);
      return {
        x: extraX,
        y: extraY
      };
    }
    function clampPan(nextX, nextY, nextScale = scale) {
      const lim = getLimits(nextScale);
      return {
        x: Math.min(lim.x, Math.max(-lim.x, nextX)),
        y: Math.min(lim.y, Math.max(-lim.y, nextY))
      };
    }
    function updateReadout() {
      if (readout) readout.textContent = `${Math.round(scale * 100)}%`;
      App.updateMediaZoomOverlap(controls, [target], viewport);
    }
    function apply() {
      const clamped = scale <= 1 ? {
        x: 0,
        y: 0
      } : clampPan(panX, panY, scale);
      panX = clamped.x;
      panY = clamped.y;
      target.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      viewport.classList.toggle("is-zoomed", scale > 1.001);
      viewport.classList.toggle("is-dragging", dragging && scale > 1.001);
      viewport.setAttribute("aria-label", scale > 1.001 ? "Zoomed media viewer. Drag to pan." : "Media viewer");
      updateReadout();
    }
    function setScale(nextScale, anchorClientX = null, anchorClientY = null) {
      const prevScale = scale;
      const clampedScale = Math.min(maxScale, Math.max(1, Number(nextScale) || 1));
      if (Math.abs(clampedScale - prevScale) < 0.0001) return;
      if (anchorClientX != null && anchorClientY != null) {
        const rect = viewport.getBoundingClientRect();
        const offsetX = anchorClientX - rect.left - rect.width / 2;
        const offsetY = anchorClientY - rect.top - rect.height / 2;
        const contentX = (offsetX - panX) / prevScale;
        const contentY = (offsetY - panY) / prevScale;
        scale = clampedScale;
        panX = offsetX - contentX * scale;
        panY = offsetY - contentY * scale;
      } else {
        scale = clampedScale;
      }
      if (scale <= 1) {
        panX = 0;
        panY = 0;
      }
      apply();
    }
    function resetZoom() {
      scale = 1;
      panX = 0;
      panY = 0;
      dragging = false;
      pinchDistance = 0;
      apply();
    }
    function beginDrag(clientX, clientY) {
      if (scale <= 1.001) return;
      dragging = true;
      dragStartX = clientX;
      dragStartY = clientY;
      dragPanStartX = panX;
      dragPanStartY = panY;
      apply();
    }
    function moveDrag(clientX, clientY) {
      if (!dragging || scale <= 1.001) return;
      panX = dragPanStartX + (clientX - dragStartX);
      panY = dragPanStartY + (clientY - dragStartY);
      apply();
    }
    function endDrag() {
      dragging = false;
      apply();
    }
    function getPointerCenter() {
      const pts = Array.from(pointers.values());
      if (pts.length < 2) return null;
      return {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2
      };
    }
    function getPointerDistance() {
      const pts = Array.from(pointers.values());
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    function onPointerDown(e) {
      if (e.button === 1) {
        e.preventDefault();
        return;
      }
      if (e.button != null && e.button !== 0 && e.pointerType !== "touch") return;
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY
      });
      if (target.tagName === "VIDEO" && !cfg.continuous) {
        try {
          viewport.focus({
            preventScroll: true
          });
        } catch {
          try {
            viewport.focus();
          } catch {}
        }
      }
      if (pointers.size === 2) {
        clickCanceledByDrag = true;
        pinchDistance = getPointerDistance();
        pinchStartScale = scale;
        dragging = false;
        apply();
      } else {
        pointerDownX = e.clientX;
        pointerDownY = e.clientY;
        clickCanceledByDrag = false;
        if (scale > 1.001) beginDrag(e.clientX, e.clientY);
      }
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY
      });
      if (pointers.size >= 2) {
        clickCanceledByDrag = true;
        root.dataset.mediaSuppressCloseUntil = String(Date.now() + 350);
        const dist = getPointerDistance();
        const center = getPointerCenter();
        if (pinchDistance > 0 && dist > 0 && center) {
          const ratio = dist / pinchDistance;
          setScale(pinchStartScale * ratio, center.x, center.y);
        }
        return;
      }
      if (!clickCanceledByDrag) {
        const moved = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
        if (moved > clickDragThreshold) {
          clickCanceledByDrag = true;
          root.dataset.mediaSuppressCloseUntil = String(Date.now() + 350);
        }
      }
      moveDrag(e.clientX, e.clientY);
    }
    function clearPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinchDistance = 0;
      }
      if (!pointers.size) endDrag();
    }
    function onWheel(e) {
      const rect = viewport.getBoundingClientRect();
      const ax = e.clientX || rect.left + rect.width / 2;
      const ay = e.clientY || rect.top + rect.height / 2;
      e.preventDefault();
      if (!e.deltaY) return;
      setScale(App.nextMediaZoomScale(scale, e.deltaY < 0 ? 1 : -1, maxScale), ax, ay);
    }
    function onAuxClick(e) {
      if (e.button !== 1) return;
      e.preventDefault();
      if (scale > 1.001) resetZoom();else setScale(dblScale, e.clientX, e.clientY);
    }
    function onDoubleClick(e) {
      if (e.target?.closest?.(".media-zoom-controls")) return;
      e.preventDefault();
      if (scale > 1.001) resetZoom();else setScale(dblScale, e.clientX, e.clientY);
    }
    function onKeyDown(e) {
      if ((e.key === " " || e.key === "Spacebar" || e.code === "Space") && target.tagName === "VIDEO" && !cfg.continuous) {
        e.preventDefault();
        const video = target;
        if (video.paused) video.play().catch(() => {});else video.pause();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setScale(App.nextMediaZoomScale(scale, 1, maxScale));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setScale(App.nextMediaZoomScale(scale, -1, maxScale));
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      } else if (scale > 1.001 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const delta = 40;
        if (e.key === "ArrowUp") panY += delta;
        if (e.key === "ArrowDown") panY -= delta;
        if (e.key === "ArrowLeft") panX += delta;
        if (e.key === "ArrowRight") panX -= delta;
        apply();
      }
    }
    function onClick(e) {
      if (target.tagName !== "VIDEO" || cfg.continuous) return;
      if (clickCanceledByDrag) {
        clickCanceledByDrag = false;
        return;
      }
      e.preventDefault();
      const video = target;
      if (video.paused) video.play().catch(() => {});else video.pause();
    }
    if (btnReset) btnReset.addEventListener("click", resetZoom);
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", clearPointer);
    viewport.addEventListener("pointercancel", clearPointer);
    viewport.addEventListener("click", onClick);
    viewport.addEventListener("wheel", onWheel, {
      passive: false
    });
    viewport.addEventListener("auxclick", onAuxClick);
    viewport.addEventListener("dblclick", onDoubleClick);
    viewport.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", apply);
    document.addEventListener("fullscreenchange", apply);
    const resize = new ResizeObserver(apply); resize.observe(viewport); resize.observe(target);
    off.push(() => viewport.removeEventListener("pointerdown", onPointerDown));
    off.push(() => viewport.removeEventListener("pointermove", onPointerMove));
    off.push(() => viewport.removeEventListener("pointerup", clearPointer));
    off.push(() => viewport.removeEventListener("pointercancel", clearPointer));
    off.push(() => viewport.removeEventListener("click", onClick));
    off.push(() => viewport.removeEventListener("wheel", onWheel));
    off.push(() => viewport.removeEventListener("auxclick", onAuxClick));
    off.push(() => viewport.removeEventListener("dblclick", onDoubleClick));
    off.push(() => viewport.removeEventListener("keydown", onKeyDown));
    if (btnReset) off.push(() => btnReset.removeEventListener("click", resetZoom));
    off.push(() => window.removeEventListener("resize", apply));
    off.push(() => document.removeEventListener("fullscreenchange", apply));
    off.push(() => resize.disconnect());
    if (target.tagName === "IMG") {
      target.addEventListener("load", apply, {
        once: true
      });
    } else if (target.tagName === "VIDEO") {
      target.addEventListener("loadedmetadata", apply, {
        once: true
      });
      target.addEventListener("loadeddata", apply, {
        once: true
      });
    }
    resetZoom();
    return () => {
      pointers.clear();
      endDrag();
      resetZoom();
      off.reverse().forEach(fn => {
        try {
          fn();
        } catch {}
      });
    };
  }
  App.openModal({
    title: modalTitle,
    size: "media",
    bodyHTML: `
      <div class="media-viewer${kind === "video" || isStickerVideo ? " media-viewer-video" : ""}${isStickerViewer ? " sticker-media-viewer" : ""}" id="${mountId}">
        <div class="media-modal-loading">Loading preview...</div>
      </div>
      ${isStickerViewer ? `
        <div class="sticker-viewer-meta" data-sticker-id="${App.escapeAttr(String(stickerRecord?.id || ""))}">
          <strong data-sticker-viewer-name>${App.escapeHtml(String(stickerRecord?.name || "Sticker"))}</strong>
          <span class="sticker-viewer-uploader" data-sticker-uploader-code="${App.escapeAttr(String(stickerRecord?.creatorCode || ""))}">
            <span class="sticker-viewer-uploader-avatar" data-avatar-usercode="${App.escapeAttr(String(stickerRecord?.creatorCode || ""))}" aria-hidden="true"></span>
            <span class="sticker-viewer-uploader-copy">Uploaded by <span data-username-usercode="${App.escapeAttr(String(stickerRecord?.creatorCode || ""))}">${App.escapeHtml(String(stickerRecord?.creatorUsername || "Unknown"))}</span></span>
          </span>
        </div>
      ` : ""}
    `,
    onBeforeClose: () => {
      mediaViewerClosed = true;
      try {
        if (typeof mediaZoomTeardown === "function") mediaZoomTeardown();
      } catch {}
      mediaZoomTeardown = null;
      if (!mediaPlayerId) return;
      try {
        const tdNow = App.videoPlayerTeardowns.get(mediaPlayerId);
        if (tdNow) {
          tdNow();
          App.videoPlayerTeardowns.delete(mediaPlayerId);
        }
      } catch {}
    }
  });
  if (isStickerViewer) {
    App.configureStickerViewerActions(stickerRecord);
    App.hydrateStickerViewerUploader(stickerRecord);
  } else if (kind === "image" || kind === "video") App.configureMediaStickerAction({
    kind,
    dataURL: src,
    fileName,
    mimeType
  });
  (async () => {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    const fastSrc = await App.getFastMediaModalSrc(src, mimeType);
    if (mediaViewerClosed || !mount.isConnected) return;
    if (["pdf", "text", "html", "docx", "pptx"].includes(kind)) {
      mediaZoomTeardown = App.mountDocumentViewer(mount, kind, fastSrc, fileName);
      return;
    }
    const cfg = await App.getVideoUiConfig();
    const zoomCfg = cfg.mediaZoom || {};
    if (isStickerVideo) {
      mount.innerHTML = `
        <div class="media-zoom-shell media-zoom-shell-video sticker-zoom-shell">
          <div class="media-zoom-controls media-zoom-controls-video" aria-label="Sticker zoom controls">
            <button class="media-zoom-btn" type="button" data-media-zoom="reset" aria-label="Reset zoom" title="Scroll to zoom · Click to reset"><span data-media-zoom="percent">100%</span></button>
          </div>
          <div class="media-zoom-viewport" tabindex="0" aria-label="Zoomable animated sticker viewer">
            <div class="media-zoom-surface">
              <video class="media-img media-zoom-target sticker-viewer-video" src="${App.escapeHtml(fastSrc)}" autoplay loop muted playsinline preload="auto" aria-label="${App.escapeHtml(String(stickerRecord?.name || "Animated sticker"))}"></video>
            </div>
          </div>
        </div>
      `;
      const stickerVideo = mount.querySelector("video");
      try {
        stickerVideo?.play?.().catch(() => {});
      } catch {}
      mediaZoomTeardown = initMediaZoomViewer(mount.querySelector(".media-zoom-shell"), {
        ...zoomCfg,
        continuous: true
      });
      return;
    }
    if (kind !== "video") {
      mount.innerHTML = `
        <div class="media-zoom-shell media-zoom-shell-image">
          <div class="media-zoom-controls" aria-label="Image zoom controls">
            <button class="media-zoom-btn" type="button" data-media-zoom="reset" aria-label="Reset zoom" title="Scroll to zoom · Click to reset"><span data-media-zoom="percent">100%</span></button>
          </div>
          <div class="media-zoom-viewport" tabindex="0" aria-label="Zoomable image viewer">
            <div class="media-zoom-surface">
              <img class="media-img media-zoom-target" src="${App.escapeHtml(fastSrc)}" alt="Media" draggable="false" />
            </div>
          </div>
        </div>
      `;
      const imageShell = mount.querySelector(".media-zoom-shell");
      imageShell?.addEventListener("click", e => {
        if (e.target.closest(".media-zoom-controls")) return;
        const target = imageShell.querySelector(".media-zoom-target");
        if (target) {
          const r = target.getBoundingClientRect();
          const clickedInsideTarget = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (clickedInsideTarget) return;
        }
        const suppressCloseUntil = Number(imageShell.dataset.mediaSuppressCloseUntil || 0);
        if (Date.now() < suppressCloseUntil) return;
        App.closeModal();
      });
      mediaZoomTeardown = initMediaZoomViewer(imageShell, zoomCfg);
      return;
    }
    const id = `vpu_${Math.random().toString(36).slice(2, 9)}`;
    mediaPlayerId = id;
    mount.innerHTML = `
      <div class="vpu" id="${id}" data-step-back="5" data-step-fwd="5" data-max-custom-speed="10" data-menu="0" data-loop="0">
        <div class="vpu-stage">
          <div class="media-zoom-shell media-zoom-shell-video">
            <div class="media-zoom-controls media-zoom-controls-video" aria-label="Video zoom controls">
              <button class="media-zoom-btn" type="button" data-media-zoom="reset" aria-label="Reset zoom" title="Scroll to zoom · Click to reset"><span data-media-zoom="percent">100%</span></button>
            </div>
            <div class="media-zoom-viewport" tabindex="0" aria-label="Zoomable video viewer">
              <div class="media-zoom-surface">
                <video class="vpu-video media-zoom-target" preload="auto" playsinline>${App.videoSourceMarkup(fastSrc, mimeType)}</video>
              </div>
            </div>
          </div>
        </div>

        <div class="vpu-controls">
          <div class="vpu-row vpu-row1">
            <div class="vpu-time">0:00 / 0:00</div>
            <input class="vpu-seek" type="range" min="0" max="0" value="0" step="0.01" />
          </div>

          <div class="vpu-row vpu-row2">
            <div class="vpu-left">
              <button class="vpu-btn vpu-play" type="button" aria-label="Play/Pause">${App.svgIcon("play")}</button>
              <button class="vpu-btn vpu-back" type="button" aria-label="Back 5 seconds">${App.svgIcon("back5")}</button>
              <button class="vpu-btn vpu-fwd" type="button" aria-label="Forward 5 seconds">${App.svgIcon("fwd5")}</button>
            </div>

            <div class="vpu-mid">
              <button class="vpu-btn vpu-volbtn" type="button" aria-label="Mute/Unmute">${App.svgIcon("vol")}</button>
              <input class="vpu-volrange" type="range" min="0" max="2" value="1" step="0.05" />
              <div class="vpu-volpct">100%</div>
            </div>

            <div class="vpu-right">
              <button class="vpu-btn vpu-loop" type="button" aria-label="Loop video" aria-pressed="false">${App.svgIcon("loop")}</button>
              <button class="vpu-btn vpu-menu" type="button" aria-label="More">${App.svgIcon("menu")}</button>
              <button class="vpu-btn vpu-full" type="button" aria-label="Fullscreen">${App.svgIcon("full")}</button>
            </div>
          </div>

          <div class="vpu-pop" hidden>
            <div class="vpu-pop-head">
              <div class="vpu-pop-title">Playback speed</div>
              <div class="vpu-pop-sub">Choose a preset, or set a custom speed.</div>
            </div>
            <div class="vpu-speedwrap"></div>
            <div class="vpu-custom">
              <label class="vpu-custom-label" for="${id}_custom">Custom (up to 10×)</label>
              <input id="${id}_custom" class="vpu-speedcustom" type="number" min="0.05" max="10" step="0.05" placeholder="e.g. 3" />
            </div>
          </div>
        </div>
      </div>
    `;
    const videoKey = await App.videoKeyFor(fileName || "video.mp4", src);
    const prefs = await App.getVideoPrefs(App.currentRoomId, videoKey);
    const host = document.getElementById(id);
    if (!host) return;
    host.dataset.stepBack = String(cfg.stepBackSec);
    host.dataset.stepFwd = String(cfg.stepFwdSec);
    host.dataset.maxCustomSpeed = String(cfg.maxCustomSpeed);
    const wrap = host.querySelector(".vpu-speedwrap");
    if (wrap) {
      wrap.innerHTML = cfg.speeds.map(r => {
        const label = Math.abs(r - 1) < 1e-9 ? "1 (Normal)" : String(r);
        return `<button type="button" class="vpu-rate" data-rate="${r}">${label}</button>`;
      }).join("");
    }
    const speedCustom = host.querySelector(".vpu-speedcustom");
    if (speedCustom) {
      speedCustom.max = String(cfg.maxCustomSpeed);
      const lbl = host.querySelector(".vpu-custom-label");
      if (lbl) lbl.textContent = `Custom (up to ${cfg.maxCustomSpeed}×)`;
    }
    if (typeof prefs.muted === "boolean") host.dataset.initialMuted = prefs.muted ? "1" : "0";
    const vol = App.clampNum(prefs.volume, 0, 2, null);
    if (vol != null) host.dataset.initialVolume = String(vol);
    const rate = App.clampNum(prefs.playbackRate, 0.05, cfg.maxCustomSpeed, null);
    if (rate != null) host.dataset.initialRate = String(rate);
    const cr = App.clampNum(prefs.customRate, 0.05, cfg.maxCustomSpeed, null);
    if (cr != null) host.dataset.initialCustomRate = String(cr);else delete host.dataset.initialCustomRate;
    const td = App.initVideoPlayer(host, {
      fileName,
      videoKey,
      roomId: App.currentRoomId
    });
    App.videoPlayerTeardowns.set(id, td);
    mediaZoomTeardown = initMediaZoomViewer(host.querySelector(".media-zoom-shell"), zoomCfg);
  })();
};
App.downloadHtmlViaObjectURL = async function (dataURL, fileName) {
  let fn = String(fileName || "experience.html").trim();
  if (!/\.html?$/i.test(fn)) fn += ".html";
  let url = "";
  try {
    const resp = await fetch(dataURL);
    if (!resp.ok) throw new Error(`Download failed (${resp.status}).`);
    const b = await resp.blob();
    const blob = b.type ? b : b.slice(0, b.size, "text/html");
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fn;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.error("download html failed:", e);
    App.showToast({
      title: "Download failed",
      body: "Could not download that HTML file.",
      duration: 2200
    });
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
App.downloadFileViaObjectURL = async function (dataURL, fileName) {
  let fn = String(fileName || "file").trim();
  if (!fn) fn = "file";
  let url = "";
  try {
    const resp = await fetch(dataURL);
    if (!resp.ok) throw new Error(`Download failed (${resp.status}).`);
    const b = await resp.blob();
    const blob = b.type ? b : b.slice(0, b.size, "application/octet-stream");
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fn;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.error("download file failed:", e);
    App.showToast({
      title: "Download failed",
      body: "Could not download that file.",
      duration: 2200
    });
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

App.register("media/viewer", function initializeFeature() {
App.mediaModalSrcCache = new Map();
App.mediaModalSrcCacheBound = false;
});
})(globalThis.ChatApp);
