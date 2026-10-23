/* media/uploads: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.clampNum = function (n, min, max, fallback = min) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
};
App.isUploadAbortError = function (err) {
  return !!(err?.name === "AbortError" || err?.code === "UPLOAD_ABORTED" || /upload aborted|aborted/i.test(String(err?.message || "")));
};
App.createUploadAbortError = function (reason = "upload aborted") {
  const err = new Error(reason);
  err.name = "AbortError";
  err.code = "UPLOAD_ABORTED";
  return err;
};
App.throwIfUploadAborted = function (signal) {
  if (signal?.aborted) throw App.createUploadAbortError(signal.reason || "upload aborted");
};
App.formatUploadPercentText = function (value) {
  const n = Number(value);
  const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  return `${pct.toFixed(2).padStart(5, "0")}%`;
};
App.calcUploadPercent = function (done, total) {
  const d = Math.max(0, Number(done) || 0);
  const t = Math.max(0, Number(total) || 0);
  if (!t) return 100;
  return Math.max(0, Math.min(100, d / t * 100));
};
App.dataURLPrefixForBlob = function (blob) {
  return `data:${String(blob?.type || "application/octet-stream")};base64,`;
};
App.dataURLCharLengthForBlob = function (blob) {
  const size = Math.max(0, Number(blob?.size || 0));
  return App.dataURLPrefixForBlob(blob).length + Math.ceil(size / 3) * 4;
};
App.countDataURLChunksForBlob = function (blob) {
  return Math.max(1, Math.ceil(App.dataURLCharLengthForBlob(blob) / App.RTDB_DATA_CHUNK_SIZE));
};
App.arrayBufferToBase64 = function (buffer) {
  const bytes = new Uint8Array(buffer || 0);
  let binary = "";
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    const chunk = bytes.subarray(i, i + stride);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
};
App.readBlobSliceAsBase64 = async function (blob, start, end, signal) {
  App.throwIfUploadAborted(signal);
  // FileReader's native encoder avoids building a large JS binary string on
  // the UI thread. Only this bounded slice, never the whole file, is encoded.
  if (typeof FileReader !== "undefined") {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      const clean = () => signal?.removeEventListener("abort", abort);
      const abort = () => { reader.abort(); clean(); reject(App.createUploadAbortError()); };
      reader.onload = () => { clean(); resolve(String(reader.result || "").split(",", 2)[1] || ""); };
      reader.onerror = () => { clean(); reject(reader.error || new Error("Could not read the attachment.")); };
      reader.onabort = () => { clean(); reject(App.createUploadAbortError()); };
      signal?.addEventListener("abort", abort, { once: true });
      reader.readAsDataURL(blob.slice(start, end));
    });
  }
  const buffer = await blob.slice(start, end).arrayBuffer();
  App.throwIfUploadAborted(signal);
  return App.arrayBufferToBase64(buffer);
};
App.stripChunkedField = function (record, fieldName) {
  const out = {
    ...(record || {})
  };
  delete out[fieldName];
  for (let i = 2;; i++) {
    const key = `${fieldName}${i}`;
    if (!(key in out)) break;
    delete out[key];
  }
  return out;
};
App.readChunkedField = function (record, fieldName) {
  if (!record || typeof record !== "object") return "";
  const first = record[fieldName];
  if (typeof first !== "string") return "";
  let out = first;
  for (let i = 2;; i++) {
    const part = record[`${fieldName}${i}`];
    if (typeof part !== "string") break;
    out += part;
  }
  return out;
};
App.writeChunkedField = function (record, fieldName, value) {
  const out = App.stripChunkedField(record, fieldName);
  const s = String(value || "");
  if (!s) {
    out[fieldName] = "";
    return out;
  }
  let idx = 0;
  for (let i = 0; i < s.length; i += App.RTDB_DATA_CHUNK_SIZE) {
    const part = s.slice(i, i + App.RTDB_DATA_CHUNK_SIZE);
    out[idx === 0 ? fieldName : `${fieldName}${idx + 1}`] = part;
    idx += 1;
  }
  return out;
};
App.countChunkedPartsForValue = function (value) {
  const s = String(value || "");
  return Math.max(1, Math.ceil(s.length / App.RTDB_DATA_CHUNK_SIZE));
};
App.hasAllChunkedFieldParts = function (record, fieldName, expectedCount) {
  const total = Math.max(1, Number(expectedCount || 0));
  for (let i = 1; i <= total; i++) {
    const key = i === 1 ? fieldName : `${fieldName}${i}`;
    if (typeof record?.[key] !== "string") return false;
  }
  return true;
};
App.attachmentHasPendingChunkedData = function (file) {
  if (!file || typeof file !== "object") return false;
  if (Number(file.uploadPending || 0) > 0) return true;
  if (App.isStoredAttachment(file)) return false;
  const expectedCount = Math.max(1, Number(file.dataChunkCount || 0));
  const hasAllParts = App.hasAllChunkedFieldParts(file, "dataURL", expectedCount);
  const existingDataURL = hasAllParts ? App.readChunkedField(file, "dataURL") || String(file.dataURL || "") : String(file.dataURL || "");
  if (hasAllParts && existingDataURL) return false;
  if (Number(file.uploadPending || 0) > 0) return true;
  return !hasAllParts || !existingDataURL;
};
App.messageHasPendingChunkedMedia = function (msg) {
  if (!msg || typeof msg !== "object") return false;
  const groups = [];
  if (Array.isArray(msg.files)) groups.push(msg.files);
  for (const list of groups) {
    for (const file of list) {
      if (App.attachmentHasPendingChunkedData(file)) return true;
    }
  }
  return false;
};
App.normalizeChunkedAttachment = function (file) {
  if (!file || typeof file !== "object") return file;
  const out = App.stripChunkedField(file, "dataURL");
  if (App.isStoredAttachment(file)) {
    delete out.previewURL;
    delete out.__loading;
    delete out.uploadPending;
    delete out.uploadProgress;
    delete out.dataChunkCount;
    return out;
  }
  const expectedCount = Math.max(1, Number(file.dataChunkCount || 0));
  const hasAllParts = App.hasAllChunkedFieldParts(file, "dataURL", expectedCount);
  const assembledDataURL = hasAllParts ? App.readChunkedField(file, "dataURL") : "";

  // The initial message record contains dataURL:"" as a one-part placeholder.
  // It is not committed media until at least one non-empty data URL part exists.
  if (!Number(file.uploadPending || 0) && hasAllParts && assembledDataURL) {
    out.dataURL = assembledDataURL;
    delete out.previewURL;
    delete out.__loading;
    delete out.uploadPending;
    delete out.uploadProgress;
    delete out.dataChunkCount;
  }
  return out;
};
App.splitChunkedFieldEntries = function (fieldName, value) {
  const s = String(value || "");
  if (!s) return [[fieldName, ""]];
  const entries = [];
  let idx = 0;
  for (let i = 0; i < s.length; i += App.RTDB_DATA_CHUNK_SIZE) {
    const key = idx === 0 ? fieldName : `${fieldName}${idx + 1}`;
    entries.push([key, s.slice(i, i + App.RTDB_DATA_CHUNK_SIZE)]);
    idx += 1;
  }
  return entries;
};
App.runTaskPool = async function (taskFns, limit = 1) {
  const total = Array.isArray(taskFns) ? taskFns.length : 0;
  if (!total) return;
  const max = Math.max(1, Number(limit) || 1);
  let cursor = 0;
  let failure = null;
  const worker = async () => {
    while (cursor < total && !failure) {
      const idx = cursor++;
      try { await taskFns[idx](); } catch (error) { failure ||= error; }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(max, total); i++) workers.push(worker());
  await Promise.all(workers);
  if (failure) throw failure;
};

// All bulk writers in this tab share one paced queue. RTDB's write-throughput
// limit is shared by the entire database; leave room for chat and other clients.
App.waitForBulkUploadBudget = async function (payload, signal) {
  App.throwIfUploadAborted(signal);
  if (App.bulkUploadConnected === false) throw App.createUploadAbortError("The database disconnected. Please retry the upload when you are online.");
  const rate = Number(App.BULK_UPLOAD_BYTES_PER_MINUTE) || 0;
  if (rate <= 0) return;
  const bytes = new Blob([JSON.stringify(payload)]).size;
  const now = Date.now();
  const startsAt = Math.max(now, Number(App.bulkUploadNextWriteAt) || 0);
  App.bulkUploadNextWriteAt = startsAt + bytes * 60000 / rate;
  const wait = Math.max(0, startsAt - now);
  if (wait > 0) await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(App.createUploadAbortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, wait);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  App.throwIfUploadAborted(signal);
  if (App.bulkUploadConnected === false) throw App.createUploadAbortError("The database disconnected. Please retry the upload when you are online.");
};
App.watchBulkUploadConnection = function () {
  if (App.bulkUploadConnectionRef || !App.db) return;
  const ref = App.db.ref(".info/connected");
  if (typeof ref.on !== "function") return;
  App.bulkUploadConnectionRef = ref;
  ref.on("value", snapshot => {
    const connected = snapshot.val() === true;
    // The initial false precedes the first connection on a fresh page.
    if (!connected && App.bulkUploadConnected == null) return;
    App.bulkUploadConnected = connected;
    if (!connected) App.abortAllFirebaseUploads("database disconnected");
  });
};

// Keep encoding and the network busy together, while bounding memory on phones.
// Wait for every submitted write before surfacing failure so cleanup cannot race
// a still-running batch and leave an incomplete attachment behind.
App.createChunkWritePipeline = function (ref, options = {}) {
  const active = new Set();
  const limit = Math.max(1, Math.min(4, Number(options.concurrency) || App.RTDB_BATCH_UPLOAD_CONCURRENCY || 3));
  let failure = null, completed = 0;
  const total = Math.max(1, Number(options.total) || 1);
  const write = async (payload, weight) => {
    App.throwIfUploadAborted(options.signal);
    if (failure) throw failure;
    await App.waitForBulkUploadBudget(payload, options.signal);
    const task = App.updateRefWithRetry(ref, payload, App.RTDB_CHUNK_UPLOAD_RETRIES, options.signal).then(() => {
      completed += weight;
      if (options.onProgress) options.onProgress(App.calcUploadPercent(completed, total));
    }).catch(error => { failure ||= error; });
    active.add(task);
    task.finally(() => active.delete(task));
    if (active.size >= limit) await Promise.race(active);
    if (failure) throw failure;
  };
  const finish = async () => {
    await Promise.all(active);
    if (failure) throw failure;
    App.throwIfUploadAborted(options.signal);
  };
  return { write, finish };
};
App.isRtdbPayloadTooLargeError = function (err) {
  const msg = String(err?.message || err || "");
  return /payload is too large|request a location with less data|less data/i.test(msg);
};
App.updateRefPayloadChildrenWithRetry = async function (ref, payload, attempts = App.RTDB_CHUNK_UPLOAD_RETRIES, signal = null) {
  const entries = Object.entries(payload || {});
  for (const [key, value] of entries) {
    App.throwIfUploadAborted(signal);
    await App.setRefWithRetry(ref.child(key), value, attempts, signal);
  }
};
App.updateRefWithRetry = async function (ref, payload, attempts = App.RTDB_CHUNK_UPLOAD_RETRIES, signal = null) {
  let lastErr = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  const canSplitPayload = payload && typeof payload === "object" && !Array.isArray(payload);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    App.throwIfUploadAborted(signal);
    try {
      await ref.update(payload);
      App.throwIfUploadAborted(signal);
      return;
    } catch (e) {
      if (App.isUploadAbortError(e)) throw e;
      if (canSplitPayload && App.isRtdbPayloadTooLargeError(e)) {
        await App.updateRefPayloadChildrenWithRetry(ref, payload, maxAttempts, signal);
        return;
      }
      lastErr = e;
      if (attempt >= maxAttempts) break;
      await App.sleep(attempt * 250);
    }
  }
  throw lastErr || new Error("chunk upload failed");
};
App.setRefWithRetry = async function (ref, payload, attempts = App.RTDB_CHUNK_UPLOAD_RETRIES, signal = null) {
  let lastErr = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    App.throwIfUploadAborted(signal);
    try {
      await ref.set(payload);
      App.throwIfUploadAborted(signal);
      return;
    } catch (e) {
      if (App.isUploadAbortError(e)) throw e;
      lastErr = e;
      if (attempt >= maxAttempts) break;
      await App.sleep(attempt * 250);
    }
  }
  throw lastErr || new Error("set failed");
};
App.writeChunkedFieldToRef = async function (ref, fieldName, value, options = {}) {
  const entries = App.splitChunkedFieldEntries(fieldName, value);
  const signal = options.signal || null;
  const progressField = options.progressField || "";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const batchSize = Math.max(1, Number(options.batchSize || App.RTDB_STRING_UPLOAD_BATCH_SIZE) || App.RTDB_STRING_UPLOAD_BATCH_SIZE);
  const total = Math.max(1, entries.length);
  const pipeline = App.createChunkWritePipeline(ref, { ...options, total, onProgress });
  try {
    for (let i = 0; i < entries.length; i += batchSize) {
      const batchEntries = entries.slice(i, i + batchSize);
      await pipeline.write(Object.fromEntries(batchEntries), batchEntries.length);
    }
  } finally { await pipeline.finish(); }
  if (progressField) await App.updateRefWithRetry(ref, { [progressField]: 100 }, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
  return entries.length;
};
App.writeBlobDataURLToRef = async function (ref, fieldName, blob, options = {}) {
  if (!(blob instanceof Blob)) return await App.writeChunkedFieldToRef(ref, fieldName, "", options);
  const signal = options.signal || null;
  const progressField = options.progressField || "";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const batchSize = Math.max(1, Number(options.batchSize || App.RTDB_STRING_UPLOAD_BATCH_SIZE) || App.RTDB_STRING_UPLOAD_BATCH_SIZE);
  const totalChars = Math.max(1, App.dataURLCharLengthForBlob(blob));
  const totalBytes = Math.max(0, Number(blob.size || 0));
  let committedChars = 0;
  let pending = App.dataURLPrefixForBlob(blob);
  let chunkIndex = 1;
  let payload = {};
  let payloadCount = 0;
  let lastProgress = 0;
  let payloadChars = 0;
  const pipeline = App.createChunkWritePipeline(ref, { ...options, total: totalChars, onProgress: pct => {
    lastProgress = pct;
    if (onProgress) onProgress(pct);
  } });
  const flushPayload = async pct => {
    if (!payloadCount) return;
    const batch = payload, chars = payloadChars;
    payload = {};
    payloadCount = 0;
    payloadChars = 0;
    await pipeline.write(batch, chars);
  };
  const queuePart = async part => {
    const key = chunkIndex === 1 ? fieldName : `${fieldName}${chunkIndex}`;
    chunkIndex += 1;
    committedChars += part.length;
    payload[key] = part;
    payloadCount += 1;
    payloadChars += part.length;
    const pct = App.calcUploadPercent(committedChars, totalChars);
    if (payloadCount >= batchSize) await flushPayload(pct);
  };
  const flushAvailable = async (force = false) => {
    while (pending.length >= App.RTDB_DATA_CHUNK_SIZE || force && pending.length) {
      App.throwIfUploadAborted(signal);
      const part = force && pending.length <= App.RTDB_DATA_CHUNK_SIZE ? pending : pending.slice(0, App.RTDB_DATA_CHUNK_SIZE);
      pending = pending.slice(part.length);
      await queuePart(part);
    }
  };
  try {
  await flushAvailable(false);
  if (!totalBytes) {
    await flushAvailable(true);
    if (payloadCount) await flushPayload(100);
    await pipeline.finish();
    if (progressField) await App.updateRefWithRetry(ref, { [progressField]: 100 }, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
    if (onProgress && lastProgress < 100) onProgress(100);
    return chunkIndex - 1;
  }
  for (let start = 0; start < totalBytes; start += App.RTDB_BLOB_READ_BYTES) {
    const end = Math.min(totalBytes, start + App.RTDB_BLOB_READ_BYTES);
    pending += await App.readBlobSliceAsBase64(blob, start, end, signal);
    await flushAvailable(false);
  }
  await flushAvailable(true);
  if (payloadCount) await flushPayload(100);
  await pipeline.finish();
  if (progressField) await App.updateRefWithRetry(ref, { [progressField]: 100 }, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
  if (onProgress && lastProgress < 100) onProgress(100);
  return chunkIndex - 1;
  } finally { await pipeline.finish(); }
};
App.writeTextFileChunksToRef = async function (ref, fieldName, file, options = {}) {
  if (!(file instanceof Blob)) return await App.writeHtmlStringChunksToRef(ref, fieldName, "", options);
  const signal = options.signal || null;
  const progressField = options.progressField || "";
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const batchSize = Math.max(1, Number(options.batchSize || App.RTDB_STRING_UPLOAD_BATCH_SIZE) || App.RTDB_STRING_UPLOAD_BATCH_SIZE);
  const totalBytes = Math.max(0, Number(file.size || 0));
  const decoder = new TextDecoder("utf-8", {
    fatal: false
  });
  const chunkLimit = Math.max(50000, Number(options.chunkSize || App.HTML_HUB_CHUNK_SIZE) || App.HTML_HUB_CHUNK_SIZE);
  let pending = "";
  let part = 1;
  let loadedBytes = 0;
  let payload = {};
  let payloadCount = 0;
  const flushPayload = async pct => {
    if (!payloadCount) return;
    if (progressField) payload[progressField] = pct;
    await App.waitForBulkUploadBudget(payload, signal);
    await App.updateRefWithRetry(ref, payload, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
    if (onProgress) onProgress(pct);
    payload = {};
    payloadCount = 0;
  };
  const queueTextPart = async text => {
    const key = part === 1 ? fieldName : `${fieldName}${part}`;
    part += 1;
    const pct = totalBytes ? App.calcUploadPercent(loadedBytes, totalBytes) : 100;
    payload[key] = text;
    payloadCount += 1;
    if (payloadCount >= batchSize) await flushPayload(pct);
  };
  const flushText = async (force = false) => {
    while (pending.length >= chunkLimit || force && pending.length) {
      App.throwIfUploadAborted(signal);
      const text = force && pending.length <= chunkLimit ? pending : pending.slice(0, chunkLimit);
      pending = pending.slice(text.length);
      await queueTextPart(text);
    }
  };
  if (!totalBytes) {
    await App.updateRefWithRetry(ref, {
      [fieldName]: "",
      [`${fieldName}ChunkCount`]: 1,
      ...(progressField ? {
        [progressField]: 100
      } : {})
    }, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
    if (onProgress) onProgress(100);
    return 1;
  }
  for (let start = 0; start < totalBytes; start += App.RTDB_BLOB_READ_BYTES) {
    const end = Math.min(totalBytes, start + App.RTDB_BLOB_READ_BYTES);
    App.throwIfUploadAborted(signal);
    const buffer = await file.slice(start, end).arrayBuffer();
    App.throwIfUploadAborted(signal);
    loadedBytes = end;
    pending += decoder.decode(buffer, {
      stream: end < totalBytes
    });
    await flushText(false);
  }
  pending += decoder.decode();
  loadedBytes = totalBytes;
  await flushText(true);
  const count = Math.max(1, part - 1);
  payload[`${fieldName}ChunkCount`] = count;
  payloadCount += 1;
  if (progressField) payload[progressField] = 100;
  await App.waitForBulkUploadBudget(payload, signal);
  await App.updateRefWithRetry(ref, payload, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
  if (onProgress) onProgress(100);
  return count;
};
App.writeHtmlStringChunksToRef = async function (ref, fieldName, html, options = {}) {
  const signal = options.signal || null;
  const s = String(html || "");
  const batchSize = Math.max(1, Number(options.batchSize || App.RTDB_STRING_UPLOAD_BATCH_SIZE) || App.RTDB_STRING_UPLOAD_BATCH_SIZE);
  const total = Math.max(1, Math.ceil(s.length / App.HTML_HUB_CHUNK_SIZE));
  let part = 1;
  let payload = {};
  let payloadCount = 0;
  const flushPayload = async pct => {
    if (!payloadCount) return;
    if (options.progressField) payload[options.progressField] = pct;
    await App.waitForBulkUploadBudget(payload, signal);
    await App.updateRefWithRetry(ref, payload, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
    if (typeof options.onProgress === "function") options.onProgress(pct);
    payload = {};
    payloadCount = 0;
  };
  for (let i = 0; i < s.length || i === 0 && !s; i += App.HTML_HUB_CHUNK_SIZE) {
    App.throwIfUploadAborted(signal);
    const key = part === 1 ? fieldName : `${fieldName}${part}`;
    const pct = App.calcUploadPercent(part, total);
    payload[key] = s.slice(i, i + App.HTML_HUB_CHUNK_SIZE);
    payloadCount += 1;
    if (payloadCount >= batchSize) await flushPayload(pct);
    part += 1;
  }
  const count = Math.max(1, part - 1);
  payload[`${fieldName}ChunkCount`] = count;
  payloadCount += 1;
  if (options.progressField) payload[options.progressField] = 100;
  await App.waitForBulkUploadBudget(payload, signal);
  await App.updateRefWithRetry(ref, payload, App.RTDB_CHUNK_UPLOAD_RETRIES, signal);
  if (typeof options.onProgress === "function") options.onProgress(100);
  return count;
};
App.createFirebaseUploadScope = function ({
  type,
  place,
  cleanup,
  disconnectRefs = []
} = {}) {
  const controller = new AbortController();
  const id = `upload_${Date.now().toString(36)}_${(++App.activeFirebaseUploadSeq).toString(36)}`;
  const scope = {
    id,
    type: String(type || "upload"),
    place: String(place || ""),
    controller,
    signal: controller.signal,
    cleanup: typeof cleanup === "function" ? cleanup : async () => {},
    disconnectRefs: Array.isArray(disconnectRefs) ? disconnectRefs.filter(Boolean) : [],
    done: false,
    cleaning: false
  };
  scope.abort = (reason = "upload aborted") => {
    if (!scope.signal.aborted) {
      try {
        scope.controller.abort(reason);
      } catch {}
    }
    // The owner catches this abort after its writes settle, then cleans up.
    // Removing now lets an already-dispatched SDK write recreate orphan data.
  };
  App.activeFirebaseUploads.set(scope.id, scope);
  App.watchBulkUploadConnection();
  return scope;
};
App.armFirebaseUploadDisconnect = async function (scope) {
  if (!scope || !Array.isArray(scope.disconnectRefs)) return;
  for (const ref of scope.disconnectRefs) {
    App.throwIfUploadAborted(scope.signal);
    await ref.onDisconnect().remove();
  }
};
App.finishFirebaseUploadScope = async function (scope) {
  if (!scope) return;
  App.throwIfUploadAborted(scope.signal);
  if (Array.isArray(scope.disconnectRefs)) {
    // Bytes are listed after their message. Preserve them before cancelling
    // message cleanup so a disconnect between acks cannot leave a broken card.
    for (const ref of [...scope.disconnectRefs].reverse()) {
      await ref.onDisconnect().cancel();
    }
  }
  App.throwIfUploadAborted(scope.signal);
  scope.done = true;
  App.activeFirebaseUploads.delete(scope.id);
};
App.cleanupFirebaseUploadScope = async function (scope, reason = "upload aborted") {
  if (!scope || scope.cleaning || scope.done) return;
  scope.cleaning = true;
  App.activeFirebaseUploads.delete(scope.id);
  try {
    if (!scope.signal.aborted) {
      try {
        scope.controller.abort(reason);
      } catch {}
    }
  } catch {}
  try {
    await scope.cleanup(reason);
  } catch {}
};
App.abortFirebaseUploadsForPlaceChange = function (nextPlace) {
  const next = String(nextPlace || "");
  for (const scope of Array.from(App.activeFirebaseUploads.values())) {
    if (!scope.place || scope.place === next) continue;
    scope.abort("page changed");
  }
};
App.abortAllFirebaseUploads = function (reason = "page unload") {
  for (const scope of Array.from(App.activeFirebaseUploads.values())) {
    try {
      if (!scope.signal.aborted) scope.controller.abort(reason);
    } catch {}
  }
};
App.externalAttachmentPrefix = function (roomId, messageKey = "") {
  const segment = value => btoa(String.fromCharCode(...new TextEncoder().encode(String(value)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `attachments/${segment(roomId)}/${messageKey ? `${segment(messageKey)}/` : ""}`;
};
App.writeMessageAttachmentsToRef = async function (messageRef, files = [], options = {}) {
  if (files.length > App.CHAT_FILE_MAX_COUNT) throw new Error(`Maximum ${App.CHAT_FILE_MAX_COUNT} attachments per message`);
  App.assertExternalStorageConfigured();
  await App.ensureFileUploadLimitLoaded();
  const signal = options.signal || null;
  const roomId = String(options.roomId || messageRef.parent?.key || "");
  const msgKey = String(options.msgKey || messageRef.key || "");
  if (!/^[^.#$\[\]/]+$/.test(roomId) || !/^[^.#$\[\]/]+$/.test(msgKey)) throw new Error("Invalid attachment destination.");
  const blobParent = App.db.ref(`attachmentBlobs/${roomId}/${msgKey}`);
  const descriptors = new Array(files.length);
  const originalBlobs = new Array(files.length);
  const writeAttachment = async (item, index) => {
    App.throwIfUploadAborted(signal);
    let blob = item?.fileObject instanceof Blob ? item.fileObject : null;
    if (!blob) {
      const existing = App.readChunkedField(item, "dataURL") || String(item?.dataURL || "");
      if (!existing) throw new Error("The attachment no longer has readable file data.");
      blob = await (await fetch(existing, { signal })).blob();
    }
    if (blob.size > App.CHAT_FILE_MAX_BYTES) throw new Error(`Attachments must be ${App.CHAT_FILE_MAX_LABEL} or smaller.`);
    originalBlobs[index] = blob;
    const progress = pct => options.onProgress?.({ group: "files", index, progress: pct });
    // Binary bytes go directly to the configured object store, never RTDB.
    const stored = await App.uploadExternalBlob(blob, {
      path: `${App.externalAttachmentPrefix(roomId, msgKey)}${index}`, signal, onProgress: ratio => progress(ratio * 100)
    });
    descriptors[index] = {
      ...stored,
      kind: String(item.kind || "file"), fileName: item.fileName || item.name || "file",
      name: item.name || item.fileName || "file", displayName: item.displayName || "",
      isVoiceMessage: !!item.isVoiceMessage,
      voiceTrimStartSec: Math.max(0, Number(item.voiceTrimStartSec) || 0),
      mimeType: item.mimeType || item.type || blob.type || "application/octet-stream",
      size: blob.size
    };
  };
  try {
    await App.runTaskPool(files.map((item, index) => () => writeAttachment(item, index)), Math.min(2, App.RTDB_CHUNK_UPLOAD_CONCURRENCY));
    App.throwIfUploadAborted(signal);
    // Keep a small cleanup index, so Clear can snapshot message keys without
    // fetching file bodies or accidentally deleting later messages' uploads.
    await blobParent.set({ files: descriptors });
    App.throwIfUploadAborted(signal);
    const manifest = { files: descriptors, attachmentsSyncedAt: App.firebase.database.ServerValue.TIMESTAMP };
    // A deleted message stays deleted. Publishing only this compact descriptor
    // avoids replaying megabytes through every room listener for every chunk.
    const result = await messageRef.transaction(current => {
      if (signal?.aborted) return;
      if (!current) return null;
      const valid = App.isValidChatMessageRecord ? App.isValidChatMessageRecord(current) : !!current.userCode;
      if (!valid) return;
      return { ...current, ...manifest };
    }, undefined, false);
    if (!result.committed || !result.snapshot.val()?.files) throw App.createUploadAbortError("The message was removed while its files were uploading.");
    App.throwIfUploadAborted(signal);
    // The sender already has the original file. Reuse its native Blob backing
    // instead of downloading its own just-acknowledged bytes from the database.
    if (App.attachmentURLCache && typeof URL !== "undefined" && URL.createObjectURL) {
      descriptors.forEach((descriptor, index) => {
        try {
          const url = URL.createObjectURL(originalBlobs[index]);
          const cacheKey = App.attachmentCacheKey(descriptor);
          const previous = App.attachmentURLCache.get(cacheKey);
          if (previous?.url?.startsWith("blob:")) URL.revokeObjectURL(previous.url);
          App.attachmentURLCache.set(cacheKey, { url, size: descriptor.size, usedAt: Date.now() });
          App.pruneAttachmentURLCache(false, cacheKey);
        } catch {
          // A local preview/cache failure must never erase an acknowledged file.
        }
      });
    }
    return manifest;
  } catch (error) {
    // Workers settle before cleanup; a late upload cannot recreate removed data.
    await App.runTaskPool(descriptors.filter(Boolean).map(file => () => App.deleteExternalBlob(file)), 2).catch(() => {});
    try { await App.deleteExternalBlobPrefix(App.externalAttachmentPrefix(roomId, msgKey)); } catch {}
    try { await blobParent.remove(); } catch {}
    throw error;
  }
};
App.isStoredAttachment = function (file) {
  if (App.isExternalBlobDescriptor?.(file)) return true;
  if (!file || file.encoding !== "base64-parts-v1") return false;
  if (!/^attachmentBlobs\/[^.#$\[\]/]+\/[^.#$\[\]/]+\/files\/\d+$/.test(String(file.storagePath || ""))) return false;
  const size = Number(file.size), bytes = Number(file.chunkBytes), count = Number(file.chunkCount);
  // Lowering the limit for new uploads must not break existing larger files.
  return Number.isSafeInteger(size) && size >= 0 && size <= (App.LEGACY_ATTACHMENT_MAX_BYTES || 200 * 1024 * 1024) &&
    bytes === App.ATTACHMENT_CHUNK_BYTES && count === Math.max(1, Math.ceil(size / bytes));
};
App.attachmentCacheKey = function (file) {
  return App.isExternalBlobDescriptor?.(file) ? `external:${file.objectKey}` : String(file?.storagePath || "");
};
App.getCachedAttachmentURL = function (file) {
  const entry = App.attachmentURLCache?.get(App.attachmentCacheKey(file));
  if (!entry) return "";
  entry.usedAt = Date.now();
  return entry.url;
};
App.pruneAttachmentURLCache = function (clear = false, keepPath = "") {
  const entries = Array.from(App.attachmentURLCache?.entries() || []).sort((a, b) => a[1].usedAt - b[1].usedAt);
  let total = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
  const sources = clear ? new Set() : new Set(Array.from(document.querySelectorAll("[src],[href]")).map(el => el.getAttribute("src") || el.getAttribute("href")));
  for (const [path, entry] of entries) {
    if (!clear && ((total <= 192 * 1024 * 1024 && App.attachmentURLCache.size <= 512) || path === keepPath || sources.has(entry.url))) continue;
    if (entry.url.startsWith("blob:")) URL.revokeObjectURL(entry.url);
    App.attachmentURLCache.delete(path);
    total -= entry.size;
  }
};
App.runAttachmentLoad = async function (load) {
  if (App.attachmentLoadCount >= 2) await new Promise(resolve => App.attachmentLoadQueue.push(resolve));
  else App.attachmentLoadCount++;
  try { return await load(); }
  finally {
    const next = App.attachmentLoadQueue.shift();
    if (next) next(); else App.attachmentLoadCount--;
  }
};
App.resolveAttachmentURL = async function (file, options = {}) {
  if (!App.isStoredAttachment(file)) {
    const inline = App.readChunkedField(file, "dataURL") || String(file?.dataURL || "");
    if (!inline) throw new Error("This attachment is not available yet.");
    return inline;
  }
  App.throwIfUploadAborted(options.signal);
  const cached = App.getCachedAttachmentURL(file);
  if (cached) return cached;
  if (App.isExternalBlobDescriptor?.(file)) {
    // Native media can stream binary bytes and byte ranges directly. Do not
    // download a large video into JS before allowing playback to start.
    const url = App.getExternalBlobURL(file);
    const cacheKey = App.attachmentCacheKey(file);
    App.attachmentURLCache.set(cacheKey, { url, size: 0, usedAt: Date.now() });
    App.pruneAttachmentURLCache(false, cacheKey);
    options.onProgress?.(100);
    return url;
  }
  const existing = App.attachmentLoads.get(file.storagePath);
  if (existing) return existing;
  const work = App.runAttachmentLoad(async () => {
    App.throwIfUploadAborted(options.signal);
    const blobs = new Array(file.chunkCount);
    let completed = 0;
    const tasks = Array.from({ length: file.chunkCount }, (_, part) => async () => {
      App.throwIfUploadAborted(options.signal);
      const partRef = App.db.ref(`${file.storagePath}/parts/${String(part).padStart(6, "0")}`);
      const snap = typeof partRef.get === "function" ? await partRef.get() : await partRef.once("value");
      App.throwIfUploadAborted(options.signal);
      const encoded = snap.val();
      const expectedSize = Math.min(file.chunkBytes, Math.max(0, file.size - part * file.chunkBytes));
      if (typeof encoded !== "string" || encoded.length !== Math.ceil(expectedSize / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new Error("The attachment is incomplete. Please try downloading it again.");
      }
      // The browser decodes each bounded part natively. No 100MB base64 string
      // or repeated concatenation is ever created in JavaScript.
      const response = await fetch(`data:application/octet-stream;base64,${encoded}`, { signal: options.signal });
      const decoded = await response.blob();
      if (decoded.size !== expectedSize) throw new Error("The attachment contains an invalid file chunk.");
      blobs[part] = decoded;
      completed += expectedSize;
      options.onProgress?.(App.calcUploadPercent(completed, file.size));
    });
    await App.runTaskPool(tasks, 3);
    App.throwIfUploadAborted(options.signal);
    const blob = new Blob(blobs, { type: file.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    App.attachmentURLCache.set(file.storagePath, { url, size: blob.size, usedAt: Date.now() });
    App.pruneAttachmentURLCache(false, file.storagePath);
    return url;
  });
  App.attachmentLoads.set(file.storagePath, work);
  try { return await work; } finally { App.attachmentLoads.delete(file.storagePath); }
};
App.normalizeMessageMedia = function (msg) {
  if (!msg || typeof msg !== "object") return msg;
  const out = App.stripChunkedField(msg, "dataURL");
  const rootDataURL = App.readChunkedField(msg, "dataURL");
  if (rootDataURL) out.dataURL = rootDataURL;
  if (Array.isArray(out.files)) out.files = out.files.map(App.normalizeChunkedAttachment);
  return out;
};
App.mergeChunkedAttachmentForDisplay = function (nextFile, prevFile) {
  const next = App.normalizeChunkedAttachment(nextFile);
  const prev = App.normalizeChunkedAttachment(prevFile);
  if (!next || typeof next !== "object") return next;
  if (App.isStoredAttachment(next)) return next;
  const mergedDataURL = String(next.dataURL || prev?.dataURL || "");
  const mergedPreviewURL = String(next.previewURL || prev?.previewURL || "");
  const mergedProgress = Math.max(Number(next.uploadProgress || 0), Number(prev?.uploadProgress || 0));
  if (!mergedDataURL) {
    const pending = mergedPreviewURL ? {
      ...next,
      previewURL: mergedPreviewURL
    } : {
      ...next
    };
    if (mergedProgress > 0) pending.uploadProgress = mergedProgress;
    return pending;
  }
  const merged = {
    ...next,
    dataURL: mergedDataURL
  };
  delete merged.previewURL;
  delete merged.__loading;
  delete merged.uploadPending;
  delete merged.dataChunkCount;
  return merged;
};
App.mergeMessageMediaForDisplay = function (nextMsg, prevMsg) {
  const next = App.normalizeMessageMedia(nextMsg);
  if (!next || typeof next !== "object") return next;
  const prev = App.normalizeMessageMedia(prevMsg);
  if (prev && typeof prev === "object") {
    if (!Number.isFinite(Number(next.createdAt)) && Number.isFinite(Number(prev.createdAt))) {
      next.createdAt = Number(prev.createdAt);
    }
    const nextSyncedAt = Number(next.attachmentsSyncedAt || 0);
    const prevSyncedAt = Number(prev.attachmentsSyncedAt || 0);
    if (prevSyncedAt > nextSyncedAt) next.attachmentsSyncedAt = prevSyncedAt;
    if (!next.dataURL && prev.dataURL) next.dataURL = prev.dataURL;
    if (Array.isArray(next.files) && Array.isArray(prev.files)) {
      next.files = next.files.map((file, i) => App.mergeChunkedAttachmentForDisplay(file, prev.files[i]));
    }
  }
  delete next.__stub;
  return next;
};
App.cancelMessageMediaRefresh = function (roomId, msgKey) {
  const rid = String(roomId || "");
  const key = String(msgKey || "");
  if (!rid || !key) return;
  const timerKey = `${rid}:${key}`;
  const rec = App.pendingMessageMediaRefreshTimers.get(timerKey);
  if (rec) {
    try {
      clearTimeout(rec.timer || rec);
    } catch {}
  }
  App.pendingMessageMediaRefreshTimers.delete(timerKey);
};
App.cancelMessageMediaRefreshesForRoom = function (roomId = null) {
  const rid = roomId == null ? "" : String(roomId || "");
  for (const [timerKey, rec] of Array.from(App.pendingMessageMediaRefreshTimers.entries())) {
    if (rid && String(rec?.roomId || "") !== rid) continue;
    try {
      clearTimeout(rec?.timer || rec);
    } catch {}
    App.pendingMessageMediaRefreshTimers.delete(timerKey);
  }
};
App.scheduleMessageMediaRefresh = function (roomId, msgKey, delay = 120) {
  // The fresh database publishes one compact manifest through child_changed.
  // Polling during a large upload only rereads the same placeholder for minutes.
  if (App.ATTACHMENT_REALTIME_ONLY) return;
  const rid = String(roomId || "");
  const key = String(msgKey || "");
  if (!rid || !key) return;
  const isCurrentRoom = () => String(App.currentRoomId || "") === rid && String(App.msgHistoryRoomId || "") === rid;
  if (!isCurrentRoom()) return;
  const timerKey = `${rid}:${key}`;
  const prevRec = App.pendingMessageMediaRefreshTimers.get(timerKey);
  if (prevRec) {
    try {
      clearTimeout(prevRec.timer || prevRec);
    } catch {}
  }
  const waitMs = Math.max(0, Number(delay) || 0);
  const nextWaitMs = Math.min(1500, Math.max(180, Math.round(waitMs * 1.8) || 180));
  const timer = setTimeout(() => {
    const activeRec = App.pendingMessageMediaRefreshTimers.get(timerKey);
    if (activeRec?.timer === timer) App.pendingMessageMediaRefreshTimers.delete(timerKey);
    if (!isCurrentRoom() || !App.renderedMsgKeys.has(key)) return;
    App.db.ref(`messages/${rid}/${key}`).once("value").then(freshSnap => {
      if (!isCurrentRoom() || !App.renderedMsgKeys.has(key)) return;
      const freshRaw = freshSnap.val();
      if (!freshRaw) return;
      const prev = App.msgDataByKey.get(key) || null;
      const freshMsg = App.mergeMessageMediaForDisplay(App.normalizeMessageMedia({
        ...freshRaw,
        _key: key
      }), prev);
      App.replaceMessageRowByKey(freshMsg);
      App.refreshReplyPreviewDependents(key);
      if (App.messageHasPendingChunkedMedia(freshMsg)) {
        App.scheduleMessageMediaRefresh(rid, key, nextWaitMs);
      }
    }).catch(() => {
      if (!isCurrentRoom() || !App.renderedMsgKeys.has(key)) return;
      const current = App.msgDataByKey.get(key);
      if (App.messageHasPendingChunkedMedia(current)) App.scheduleMessageMediaRefresh(rid, key, nextWaitMs);
    });
  }, waitMs);
  App.pendingMessageMediaRefreshTimers.set(timerKey, {
    timer,
    roomId: rid,
    msgKey: key
  });
};
App.getChatAttachmentByteSize = function (fileOrAttachment) {
  const sourceSize = Number(fileOrAttachment?.fileObject?.size);
  if (Number.isFinite(sourceSize) && sourceSize >= 0) return sourceSize;
  const directSize = Number(fileOrAttachment?.size);
  return Number.isFinite(directSize) && directSize >= 0 ? directSize : 0;
};
App.isChatAttachmentOverSizeLimit = function (fileOrAttachment) {
  return App.getChatAttachmentByteSize(fileOrAttachment) > App.CHAT_FILE_MAX_BYTES;
};
App.showChatFileTooLargeToast = function (fileOrAttachment) {
  const name = String(fileOrAttachment?.fileName || fileOrAttachment?.name || "That file");
  App.showToast({
    title: "File too large",
    body: `${name} is over the ${App.CHAT_FILE_MAX_LABEL} limit for chat rooms.`,
    duration: 3600
  });
};
App.addPendingFile = async function (file, options = {}) {
  if (!file) return false;
  const roomId = App.currentRoomId, userCode = App.currentUser?.code;
  try { await App.ensureFileUploadLimitLoaded(); }
  catch (error) {
    App.showToast({ title: "File upload unavailable", body: error.message, duration: 3600 });
    return false;
  }
  if (roomId !== App.currentRoomId || userCode !== App.currentUser?.code) return false;
  if (App.pendingFiles.length >= App.CHAT_FILE_MAX_COUNT) {
    App.showChatFileLimitToast();
    return false;
  }
  if (App.isChatAttachmentOverSizeLimit(file)) {
    App.showChatFileTooLargeToast(file);
    return false;
  }
  const kind = App.chatFileKind(file);
  let previewURL = "";
  try {
    previewURL = URL.createObjectURL(file);
  } catch {
    previewURL = "";
  }
  const isVoiceMessage = !!options.isVoiceMessage;
  App.pendingFiles.push({
    id: Math.random().toString(36).slice(2),
    kind,
    name: file.name || "file",
    fileName: file.name || "file",
    displayName: isVoiceMessage ? String(options.displayName || "Voice Message") : "",
    isVoiceMessage,
    voiceTrimStartSec: Math.max(0, Number(options.voiceTrimStartSec) || 0),
    type: file.type || "",
    mimeType: file.type || App.getMediaMimeType(file) || "",
    size: Number(file.size || 0),
    previewURL,
    fileObject: file
  });
  App.renderFilesBar();
  App.syncChatOverlayMetrics();
  return true;
};
App.showChatFileLimitToast = function () {
  App.showToast({ title: "Max files", body: `You can attach up to ${App.CHAT_FILE_MAX_COUNT} files per message.`, duration: 2600 });
};
App.canAcceptChatFiles = function () {
  const input = App.$("msg-input");
  const modalBlocksChat = App.$("modal")?.hidden === false && !(App.isTimeDisplayExpanded?.() && App.timeChatOpen);
  return !!(App.currentUser && App.currentRoomId && App.getStoredPlace() === `room:${App.currentRoomId}` &&
    App.views.chat?.dataset.active === "true" && input && !input.disabled && !App.editState && !modalBlocksChat);
};
App.addChatFiles = async function (files) {
  if (!App.canAcceptChatFiles()) return 0;
  App.initOverlaysUI();
  const room = App.currentRoomId, code = App.currentUser.code;
  let added = 0;
  for (const file of Array.from(files || [])) {
    if (App.currentRoomId !== room || App.currentUser?.code !== code) break;
    if (App.pendingFiles.length >= App.CHAT_FILE_MAX_COUNT) { App.showChatFileLimitToast(); break; }
    if (await App.addPendingFile(file)) added++;
  }
  return added;
};
App.filesFromTransfer = function (transfer) {
  if (transfer?.files?.length) return Array.from(transfer.files);
  return Array.from(transfer?.items || []).filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
};
App.bindChatFileTransfers = function () {
  const chat = App.$("view-chat");
  if (!chat) return;
  let depth = 0;
  const hasFiles = transfer => Array.from(transfer?.types || []).includes("Files") || Array.from(transfer?.items || []).some(item => item.kind === "file");
  const clear = () => { depth = 0; chat.classList.remove("chat-file-dragover"); };
  chat.addEventListener("dragenter", event => {
    if (!hasFiles(event.dataTransfer) || !App.canAcceptChatFiles()) return;
    event.preventDefault(); depth++; chat.classList.add("chat-file-dragover");
  });
  chat.addEventListener("dragover", event => {
    if (!hasFiles(event.dataTransfer) || !App.canAcceptChatFiles()) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "copy";
  });
  chat.addEventListener("dragleave", event => { if (--depth <= 0 || !chat.contains(event.relatedTarget)) clear(); });
  chat.addEventListener("drop", event => {
    clear();
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (App.canAcceptChatFiles()) void App.addChatFiles(App.filesFromTransfer(event.dataTransfer));
  });
  document.addEventListener("dragend", clear);
  window.addEventListener("blur", clear);
  document.addEventListener("paste", async event => {
    if (event.defaultPrevented || !App.canAcceptChatFiles()) return;
    const target = event.target;
    if (target?.closest?.("input,textarea,[contenteditable='true']") && target !== App.$("msg-input")) return;
    const files = App.filesFromTransfer(event.clipboardData);
    if (!files.length) {
      // Windows Explorer puts file paths on its native file-drop clipboard.
      // Read those only during this explicit paste, never in the background.
      if (event.clipboardData?.getData("text/plain") || !window.chatDesktopClipboard?.readFiles) return;
      const room = App.currentRoomId, code = App.currentUser.code;
      try {
        await App.ensureFileUploadLimitLoaded();
        if (!App.canAcceptChatFiles() || room !== App.currentRoomId || code !== App.currentUser?.code) return;
        const nativeFiles = await window.chatDesktopClipboard.readFiles(Math.max(0, App.CHAT_FILE_MAX_COUNT - App.pendingFiles.length), App.CHAT_FILE_MAX_BYTES);
        if (!App.canAcceptChatFiles() || room !== App.currentRoomId || code !== App.currentUser?.code) return;
        await App.addChatFiles(nativeFiles.map(item => new File([item.data], item.name, { type: item.type || "application/octet-stream" })));
      } catch (error) {
        const message = String(error?.message || "Could not read files from the clipboard.");
        const body = Number(window.chatDesktopClipboard?.version || 1) < 2 && /(?:100|125)\s*MB/i.test(message) ? `This desktop clipboard bridge has an older size limit. Use Upload or drag the file into chat to attach files up to ${App.CHAT_FILE_MAX_LABEL}.` : message;
        App.showToast({ title: "Paste failed", body, duration: 4200 });
      }
      return;
    }
    event.preventDefault();
    void App.addChatFiles(files);
  });
};

App.register("media/uploads", function initializeFeature() {
App.RTDB_DATA_CHUNK_SIZE = 300000;
App.RTDB_BLOB_READ_BYTES = 786432;
App.RTDB_STRING_UPLOAD_BATCH_SIZE = 3;
App.RTDB_CHUNK_UPLOAD_CONCURRENCY = typeof navigator !== "undefined" && (Number(navigator.deviceMemory) <= 4 || /Android|iPhone|iPad/i.test(navigator.userAgent || "")) ? 2 : 4;
App.RTDB_BATCH_UPLOAD_CONCURRENCY = App.RTDB_CHUNK_UPLOAD_CONCURRENCY === 2 ? 2 : 3;
App.RTDB_CHUNK_UPLOAD_RETRIES = 4;
App.activeFirebaseUploads = new Map();
App.activeFirebaseUploadSeq = 0;
window.addEventListener("pagehide", () => App.abortAllFirebaseUploads("page hidden"), {
  capture: true
});
window.addEventListener("beforeunload", () => App.abortAllFirebaseUploads("page unload"), {
  capture: true
});
App.pendingMessageMediaRefreshTimers = new Map();
App.LEGACY_ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;
App.BULK_UPLOAD_BYTES_PER_MINUTE = 32 * 1024 * 1024;
App.bulkUploadNextWriteAt = 0;
App.bulkUploadConnected = null;
App.ATTACHMENT_CHUNK_BYTES = 786432;
App.ATTACHMENT_REALTIME_ONLY = true;
App.attachmentURLCache = new Map();
App.attachmentLoads = new Map();
App.attachmentLoadCount = 0;
App.attachmentLoadQueue = [];
window.addEventListener("beforeunload", () => App.pruneAttachmentURLCache(true));
App.CHAT_FILE_MAX_COUNT = 12;
App.bindChatFileTransfers();
});
})(globalThis.ChatApp);
