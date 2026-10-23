/* activities/library-storage: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.removePendingHtmlHubDestination = async function (id, migrationToken) {
  const key = String(id || "");
  const token = String(migrationToken || "");
  if (!key || !token) return false;
  try {
    const result = await App.db.ref(`${App.htmlHubPath()}/${key}`).transaction(current => {
      if (!current || current.migrationPending !== 1 || String(current.migrationToken || "") !== token) return;
      return null;
    }, undefined, false);
    return !!result.committed;
  } catch {
    return false;
  }
};
App.finalizeHtmlHubMigrationPublication = async function ({
  destinationId,
  migrationToken,
  expectedChunks,
  fallbackRaw,
  publishedMeta,
  ownerCode,
  sourceId
}) {
  const id = String(destinationId || "");
  const token = String(migrationToken || "");
  const code = String(ownerCode || "");
  const legacyId = String(sourceId || "");
  if (!id || !token || !code || !legacyId || !publishedMeta) return false;
  const destinationRef = App.db.ref(`${App.htmlHubPath()}/${id}`);
  const indexRef = App.db.ref(`${App.htmlHubMetaPath()}/${id}`);
  const expectedChunkFingerprint = JSON.stringify(Array.isArray(expectedChunks) ? expectedChunks : []);
  if (expectedChunkFingerprint === "[]") return false;

  // A deleted marker is intentionally retained in the lightweight index. It
  // prevents a delayed migration worker from resurrecting a Hub item after the
  // uploader (or Vinny) deleted it.
  const beforeIndex = await indexRef.once("value");
  if (beforeIndex.val()?.deleted) return false;
  const fallback = fallbackRaw && typeof fallbackRaw === "object" ? {
    ...fallbackRaw,
    migrationPending: null,
    migrationReady: 1,
    migrationToken: token
  } : null;

  // Move the file itself into an exclusive ready-to-publish state first. Once
  // this transaction commits, another migration worker cannot claim or publish
  // the same destination with a stale token.
  const ready = await destinationRef.transaction(current => {
    if (current == null) {
      if (!fallback || JSON.stringify(App.normalizedHtmlChunks(fallback)) !== expectedChunkFingerprint) return;
      return fallback;
    }
    if (current.uploadPending) return;
    if (String(current.migrationToken || "") !== token) return;
    if (current.migrationPending !== 1 && current.migrationReady !== 1) return;
    if (JSON.stringify(App.normalizedHtmlChunks(current)) !== expectedChunkFingerprint) return;
    return {
      ...current,
      migrationPending: null,
      migrationReady: 1
    };
  }, undefined, false);
  if (!ready.committed) return false;

  // Publish the lightweight index with a transaction so a concurrent deletion
  // tombstone wins. Existing matching metadata is kept byte-for-byte.
  const indexed = await indexRef.transaction(current => {
    if (current?.deleted) return;
    if (current != null) {
      const normalized = App.normalizeHtmlHubMeta(id, current);
      const sameRecord = normalized.ownerCode === code && String(normalized.legacySource?.ownerCode || "") === code && String(normalized.legacySource?.itemId || "") === legacyId;
      if (!sameRecord) return;
      return current;
    }
    return publishedMeta;
  }, undefined, false);
  if (!indexed.committed) {
    // If deletion won after the file transaction, remove only the exact ready
    // copy owned by this worker. Never touch a successor's destination.
    if (indexed.snapshot.val()?.deleted) {
      try {
        await destinationRef.transaction(current => {
          if (!current || current.migrationReady !== 1) return;
          if (String(current.migrationToken || "") !== token) return;
          if (JSON.stringify(App.normalizedHtmlChunks(current)) !== expectedChunkFingerprint) return;
          return null;
        }, undefined, false);
      } catch {}
    }
    return false;
  }
  await App.db.ref().update({
    [`${App.htmlHubPath()}/${id}/migrationReady`]: null,
    [`${App.htmlHubPath()}/${id}/migrationToken`]: null,
    [`${App.htmlHubPath()}/${id}/migrationSourceSignature`]: null,
    [`${App.HTML_HUB_BY_OWNER_NODE}/${code}/${id}`]: true,
    [`${App.HTML_HUB_MIGRATIONS_NODE}/legacyAccountLibrariesV1/${code}/${legacyId}`]: App.firebase.database.ServerValue.TIMESTAMP
  });
  return true;
};
App.migrateLegacyHtmlHubItem = async function (ownerCode, legacyId, ownerUsername, ensureLease = null) {
  const code = String(ownerCode || "");
  const sourceId = String(legacyId || "");
  if (!code || !sourceId) return false;
  const destinationId = App.makeLegacyHtmlHubId(code, sourceId);
  const legacyFilePath = `users/${code}/${App.LEGACY_HTML_LIBRARY_NODE}/${sourceId}`;
  const legacyMetaPath = `users/${code}/${App.LEGACY_HTML_LIBRARY_META_NODE}/${sourceId}`;
  const destinationPath = `${App.htmlHubPath()}/${destinationId}`;
  const destinationRef = App.db.ref(destinationPath);
  const indexRef = App.db.ref(`${App.htmlHubMetaPath()}/${destinationId}`);
  const [legacySnap, legacyMetaSnap, existingDestinationSnap, existingIndexSnap] = await Promise.all([App.db.ref(legacyFilePath).once("value"), App.db.ref(legacyMetaPath).once("value"), destinationRef.once("value"), indexRef.once("value")]);
  if (!legacySnap.exists()) return false;
  if (existingIndexSnap.val()?.deleted) return false;
  const legacyRaw = legacySnap.val();
  const legacyMeta = legacyMetaSnap.val() && typeof legacyMetaSnap.val() === "object" ? legacyMetaSnap.val() : {};
  if (legacyRaw?.uploadPending || legacyMeta?.uploadPending) return false;
  const legacyChunks = App.normalizedHtmlChunks(legacyRaw);
  // A missing first chunk or a hole in a declared chunk sequence may be an
  // older client that is still uploading. Never delete or publish that source.
  if (!legacyChunks.length) return false;
  const title = String(legacyMeta.title || legacyRaw?.title || "Untitled HTML").trim() || "Untitled HTML";
  const titleLower = String(legacyMeta.titleLower || legacyRaw?.titleLower || title).toLowerCase();
  const createdAt = Math.max(0, Number(legacyMeta.createdAt || legacyRaw?.createdAt || legacyRaw?.updatedAt || 0));
  const updatedAt = Math.max(0, Number(legacyMeta.updatedAt || legacyRaw?.updatedAt || createdAt));
  const fileName = String(legacyMeta.fileName || legacyRaw?.fileName || "");
  const byteSize = Math.max(0, Number(legacyMeta.byteSize || legacyRaw?.byteSize || new Blob(legacyChunks).size));
  const ownerName = String(ownerUsername || "Unknown user");
  const sourceSignature = await App.htmlHubChunkSignature(legacyRaw);
  const newMigrationToken = `legacy_${App.CLIENT_INSTANCE_ID}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let destinationRaw = existingDestinationSnap.exists() ? existingDestinationSnap.val() : null;
  let createdDestination = false;
  if (destinationRaw) {
    const existingDestinationSignature = await App.htmlHubChunkSignature(destinationRaw);
    if (existingDestinationSignature !== sourceSignature) {
      // Never overwrite a published global record. An unindexed deterministic
      // destination is only an interrupted migration and is safe to retry.
      if (existingIndexSnap.exists()) return false;
      const staleFingerprint = App.legacyMigrationFingerprint(destinationRaw);
      if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
      const claimedSource = await App.claimLegacyHtmlSource(code, sourceId, legacyRaw, legacyMetaSnap.exists() ? legacyMetaSnap.val() : null, newMigrationToken);
      if (!claimedSource) return false;
      try {
        const fenced = await destinationRef.transaction(current => {
          if (current?.migrationPending !== 1) return;
          if (App.legacyMigrationFingerprint(current) !== staleFingerprint) return;
          return {
            ...current,
            migrationToken: newMigrationToken
          };
        }, undefined, false);
        if (!fenced.committed) return false;
        if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
        if (!(await App.removePendingHtmlHubDestination(destinationId, newMigrationToken))) return false;
      } catch {
        return false;
      }
      destinationRaw = null;
    }
  }
  if (!destinationRaw) {
    destinationRaw = {
      ...App.legacyHtmlFileWithoutMigrationClaim(legacyRaw),
      ownerCode: code,
      ownerUsername: ownerName,
      ownerUsernameLower: ownerName.toLowerCase(),
      schemaVersion: 2,
      uploadPending: null,
      uploadProgress: 100,
      legacySource: {
        ownerCode: code,
        itemId: sourceId
      },
      migrationPending: 1,
      migrationToken: newMigrationToken,
      migrationSourceSignature: sourceSignature
    };
    const candidate = destinationRaw;
    const created = await destinationRef.transaction(current => current == null ? candidate : current, undefined, false);
    destinationRaw = created.snapshot.val();
    createdDestination = String(destinationRaw?.migrationToken || "") === newMigrationToken;
  }
  const verifiedSnap = await destinationRef.once("value");
  const verifiedRaw = verifiedSnap.val();
  const destinationSignature = await App.htmlHubChunkSignature(verifiedRaw);
  if (!verifiedSnap.exists() || sourceSignature !== destinationSignature) {
    if (createdDestination) {
      await App.removePendingHtmlHubDestination(destinationId, newMigrationToken);
    }
    throw new Error(`HTML Hub migration verification failed for ${code}/${sourceId}`);
  }

  // Verify the legacy source again after the copy. This protects an upload or
  // edit that began after the first snapshot from being truncated and removed.
  const [latestLegacySnap, latestLegacyMetaSnap] = await Promise.all([App.db.ref(legacyFilePath).once("value"), App.db.ref(legacyMetaPath).once("value")]);
  const latestLegacyRaw = latestLegacySnap.val();
  const latestLegacyMetaRaw = latestLegacyMetaSnap.exists() ? latestLegacyMetaSnap.val() : null;
  const latestLegacyMeta = latestLegacyMetaRaw && typeof latestLegacyMetaRaw === "object" ? latestLegacyMetaRaw : {};
  const latestChunks = App.normalizedHtmlChunks(latestLegacyRaw);
  const latestSignature = latestChunks.length ? await App.htmlHubChunkSignature(latestLegacyRaw) : "";
  if (!latestLegacySnap.exists() || latestLegacyRaw?.uploadPending || latestLegacyMeta?.uploadPending || !latestChunks.length || latestSignature !== sourceSignature) {
    if (createdDestination && !existingIndexSnap.exists()) await App.removePendingHtmlHubDestination(destinationId, newMigrationToken);
    return false;
  }
  if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
  const claimed = await App.claimLegacyHtmlSource(code, sourceId, latestLegacyRaw, latestLegacyMetaRaw, newMigrationToken);
  if (!claimed) {
    if (createdDestination && !existingIndexSnap.exists()) await App.removePendingHtmlHubDestination(destinationId, newMigrationToken);
    return false;
  }
  const latestTitle = String(latestLegacyMeta.title || latestLegacyRaw?.title || title).trim() || title;
  const latestTitleLower = String(latestLegacyMeta.titleLower || latestLegacyRaw?.titleLower || latestTitle).toLowerCase();
  const latestCreatedAt = Math.max(0, Number(latestLegacyMeta.createdAt || latestLegacyRaw?.createdAt || createdAt));
  const latestUpdatedAt = Math.max(0, Number(latestLegacyMeta.updatedAt || latestLegacyRaw?.updatedAt || updatedAt));
  const latestFileName = String(latestLegacyMeta.fileName || latestLegacyRaw?.fileName || fileName);
  const latestByteSize = Math.max(0, Number(latestLegacyMeta.byteSize || latestLegacyRaw?.byteSize || byteSize));
  const existingIndex = existingIndexSnap.exists() ? App.normalizeHtmlHubMeta(destinationId, existingIndexSnap.val()) : null;
  const publishedMeta = {
    title: existingIndex?.title || latestTitle,
    titleLower: existingIndex?.titleLower || latestTitleLower,
    ownerCode: code,
    ownerUsername: existingIndex?.ownerUsername || ownerName,
    ownerUsernameLower: String(existingIndex?.ownerUsernameLower || ownerName).toLowerCase(),
    createdAt: existingIndex?.createdAt || latestCreatedAt,
    updatedAt: existingIndex?.updatedAt || latestUpdatedAt,
    fileName: existingIndex?.fileName || latestFileName,
    byteSize: existingIndex?.byteSize || latestByteSize,
    schemaVersion: 2,
    legacySource: {
      ownerCode: code,
      itemId: sourceId
    }
  };
  if (existingIndex) {
    const samePublishedRecord = existingIndex.ownerCode === code && existingIndex.title === latestTitle && String(existingIndex.fileName || "") === latestFileName && Number(existingIndex.byteSize || 0) === latestByteSize;
    if (!samePublishedRecord) return false;
    let existingDestinationForFinalize = verifiedRaw;
    const needsDestinationFinalize = verifiedRaw?.migrationPending === 1 || verifiedRaw?.migrationReady === 1;
    if (needsDestinationFinalize) {
      const claimedDestination = await destinationRef.transaction(current => {
        if (!current || current.migrationPending !== 1 && current.migrationReady !== 1) return;
        if (JSON.stringify(App.normalizedHtmlChunks(current)) !== JSON.stringify(latestChunks)) return;
        return {
          ...current,
          migrationToken: newMigrationToken,
          migrationSourceSignature: sourceSignature
        };
      }, undefined, false);
      if (!claimedDestination.committed) return false;
      existingDestinationForFinalize = claimedDestination.snapshot.val();
    }
    if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
    const cleaned = await App.conditionallyDeleteLegacyHtmlSource(code, sourceId, latestLegacyRaw, latestLegacyMetaRaw, newMigrationToken);
    if (!cleaned) return false;
    if (needsDestinationFinalize) {
      return await App.finalizeHtmlHubMigrationPublication({
        destinationId,
        migrationToken: newMigrationToken,
        expectedChunks: latestChunks,
        fallbackRaw: existingDestinationForFinalize,
        publishedMeta,
        ownerCode: code,
        sourceId
      });
    }
    await App.db.ref().update({
      [`${App.HTML_HUB_BY_OWNER_NODE}/${code}/${destinationId}`]: true,
      [`${App.HTML_HUB_MIGRATIONS_NODE}/legacyAccountLibrariesV1/${code}/${sourceId}`]: App.firebase.database.ServerValue.TIMESTAMP
    });
    return true;
  }
  const migrationToken = newMigrationToken;
  const expectedDestinationChunks = JSON.stringify(latestChunks);
  if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
  const prepared = await destinationRef.transaction(current => {
    if (!current || current.uploadPending || current.migrationPending !== 1) return;
    if (JSON.stringify(App.normalizedHtmlChunks(current)) !== expectedDestinationChunks) return;
    return {
      ...current,
      title: latestTitle,
      titleLower: latestTitleLower,
      ownerCode: code,
      ownerUsername: ownerName,
      ownerUsernameLower: ownerName.toLowerCase(),
      createdAt: latestCreatedAt,
      updatedAt: latestUpdatedAt,
      fileName: latestFileName,
      byteSize: latestByteSize,
      schemaVersion: 2,
      uploadPending: null,
      uploadProgress: 100,
      legacySource: {
        ownerCode: code,
        itemId: sourceId
      },
      migrationPending: 1,
      migrationToken,
      migrationSourceSignature: sourceSignature
    };
  }, undefined, false);
  if (!prepared.committed) return false;
  if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
  const cleaned = await App.conditionallyDeleteLegacyHtmlSource(code, sourceId, latestLegacyRaw, latestLegacyMetaRaw, migrationToken);
  if (!cleaned) {
    const [remainingFile, remainingMeta] = await Promise.all([App.db.ref(legacyFilePath).once("value"), App.db.ref(legacyMetaPath).once("value")]);
    if (remainingFile.exists() || remainingMeta.exists()) {
      if (String(remainingFile.val()?.hubMigrationClaim || "") === migrationToken) {
        await App.removePendingHtmlHubDestination(destinationId, migrationToken);
      }
      return false;
    }
  }
  if (typeof ensureLease === "function" && !(await ensureLease(true))) return false;
  return await App.finalizeHtmlHubMigrationPublication({
    destinationId,
    migrationToken,
    expectedChunks: latestChunks,
    fallbackRaw: prepared.snapshot.val(),
    publishedMeta,
    ownerCode: code,
    sourceId
  });
};
App.acquireHtmlHubMigrationLease = async function () {
  const leaseRef = App.db.ref(`${App.HTML_HUB_MIGRATIONS_NODE}/legacySweepLease`);
  const now = App.accurateNowMs();
  try {
    const result = await leaseRef.transaction(current => {
      const expiresAt = Number(current?.expiresAt || 0);
      if (current?.clientId && current.clientId !== App.CLIENT_INSTANCE_ID && expiresAt > now) return;
      return {
        clientId: App.CLIENT_INSTANCE_ID,
        expiresAt: now + 300000,
        startedAt: App.firebase.database.ServerValue.TIMESTAMP
      };
    }, undefined, false);
    return result.committed ? leaseRef : null;
  } catch {
    return null;
  }
};
App.renewHtmlHubMigrationLease = async function (leaseRef) {
  if (!leaseRef) return false;
  const now = App.accurateNowMs();
  try {
    const result = await leaseRef.transaction(current => {
      if (current?.clientId !== App.CLIENT_INSTANCE_ID) return;
      return {
        ...current,
        expiresAt: now + 300000,
        renewedAt: App.firebase.database.ServerValue.TIMESTAMP
      };
    }, undefined, false);
    return !!(result.committed && result.snapshot.val()?.clientId === App.CLIENT_INSTANCE_ID);
  } catch {
    return false;
  }
};
App.recoverInterruptedHtmlHubMigrations = async function (ensureLease) {
  const ids = await App.fetchHtmlHubChildKeys();
  for (let offset = 0; offset < ids.length; offset += 12) {
    if (typeof ensureLease === "function" && !(await ensureLease())) return;
    const batch = ids.slice(offset, offset + 12);
    const stateSnaps = await Promise.all(batch.map(id => Promise.all([App.db.ref(`${App.htmlHubPath()}/${id}/migrationPending`).once("value"), App.db.ref(`${App.htmlHubPath()}/${id}/migrationReady`).once("value")])));
    for (let index = 0; index < batch.length; index += 1) {
      const wasPending = Number(stateSnaps[index][0].val() || 0) === 1;
      const wasReady = Number(stateSnaps[index][1].val() || 0) === 1;
      if (!wasPending && !wasReady) continue;
      const id = batch[index];
      const item = await App.readHtmlHubFileMeta(id, {
        includeMigrationPending: true
      });
      const ownerCode = String(item?.ownerCode || "");
      const sourceId = String(item?.legacySource?.itemId || "");
      const previousToken = String(item?.migrationToken || "");
      if (!item || !ownerCode || !sourceId || !previousToken) continue;
      const [legacyFileSnap, legacyMetaSnap] = await Promise.all([App.db.ref(`users/${ownerCode}/${App.LEGACY_HTML_LIBRARY_NODE}/${sourceId}`).once("value"), App.db.ref(`users/${ownerCode}/${App.LEGACY_HTML_LIBRARY_META_NODE}/${sourceId}`).once("value")]);
      if (legacyFileSnap.exists() || legacyMetaSnap.exists()) continue;

      // Revalidate the lease for every item, then claim the exact pending/ready
      // destination state. A stale batch snapshot can never publish a record
      // that another worker already replaced, completed, or deleted.
      if (typeof ensureLease === "function" && !(await ensureLease(true))) return;
      const recoveryToken = `recover_${App.CLIENT_INSTANCE_ID}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const destinationRef = App.db.ref(`${App.htmlHubPath()}/${id}`);
      const claimed = await destinationRef.transaction(current => {
        if (!current || current.uploadPending) return;
        if (current.migrationPending !== 1 && current.migrationReady !== 1) return;
        if (String(current.migrationToken || "") !== previousToken) return;
        if (String(current.migrationSourceSignature || "") !== String(item.migrationSourceSignature || "")) return;
        if (String(current.legacySource?.ownerCode || "") !== ownerCode) return;
        if (String(current.legacySource?.itemId || "") !== sourceId) return;
        if (!App.normalizedHtmlChunks(current).length) return;
        return {
          ...current,
          migrationToken: recoveryToken
        };
      }, undefined, false);
      if (!claimed.committed) continue;
      const claimedRaw = claimed.snapshot.val();
      const claimedChunks = App.normalizedHtmlChunks(claimedRaw);
      if (!claimedChunks.length) continue;
      const publishedMeta = {
        title: item.title,
        titleLower: item.titleLower,
        ownerCode,
        ownerUsername: item.ownerUsername,
        ownerUsernameLower: item.ownerUsernameLower,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        fileName: item.fileName,
        byteSize: item.byteSize,
        schemaVersion: 2,
        legacySource: item.legacySource
      };
      await App.finalizeHtmlHubMigrationPublication({
        destinationId: id,
        migrationToken: recoveryToken,
        expectedChunks: claimedChunks,
        fallbackRaw: claimedRaw,
        publishedMeta,
        ownerCode,
        sourceId
      });
    }
  }
};
App.migrateLegacyHtmlLibrariesToHub = async function ({
  force = false
} = {}) {
  if (!force && !App.HTML_HUB_ENABLE_LEGACY_MIGRATION) return;
  if (!App.currentUser?.code) return;
  if (App.htmlHubLegacyMigrationPromise) return App.htmlHubLegacyMigrationPromise;
  if (!force && Date.now() - App.htmlHubLegacyMigrationLastScan < 30000) return;
  App.htmlHubLegacyMigrationLastScan = Date.now();
  App.htmlHubLegacyMigrationPromise = (async () => {
    const leaseRef = await App.acquireHtmlHubMigrationLease();
    if (!leaseRef) return;
    let leaseLost = false;
    let leaseCheckedAt = App.accurateNowMs();
    let leaseRenewPromise = null;
    const ensureLease = async (force = false) => {
      if (leaseLost) return false;
      const now = App.accurateNowMs();
      if (!force && !leaseRenewPromise && now - leaseCheckedAt < 30000) return true;
      if (!leaseRenewPromise) {
        leaseRenewPromise = App.renewHtmlHubMigrationLease(leaseRef).finally(() => {
          leaseRenewPromise = null;
        });
      }
      const ok = await leaseRenewPromise;
      if (!ok) leaseLost = true;else leaseCheckedAt = App.accurateNowMs();
      return ok;
    };
    const renewLease = setInterval(() => {
      void ensureLease(true);
    }, 60000);
    try {
      await App.recoverInterruptedHtmlHubMigrations(ensureLease);
      if (leaseLost) return;
      const userCodes = await App.fetchFirebaseChildKeys("users");
      for (let offset = 0; offset < userCodes.length; offset += 3) {
        if (!(await ensureLease(true))) break;
        const batch = userCodes.slice(offset, offset + 3);
        await Promise.all(batch.map(async ownerCode => {
          const [fileIds, metaIds, ownerUsername] = await Promise.all([App.fetchFirebaseChildKeys(`users/${ownerCode}/${App.LEGACY_HTML_LIBRARY_NODE}`), App.fetchFirebaseChildKeys(`users/${ownerCode}/${App.LEGACY_HTML_LIBRARY_META_NODE}`), App.getLegacyHtmlOwnerUsername(ownerCode)]);
          const sourceIds = Array.from(new Set([...fileIds, ...metaIds]));
          for (const sourceId of sourceIds) {
            if (!(await ensureLease())) return;
            try {
              await App.migrateLegacyHtmlHubItem(ownerCode, sourceId, ownerUsername, ensureLease);
            } catch (e) {
              console.warn("HTML Hub legacy item migration deferred:", e);
            }
            await App.sleep();
          }
        }));
        await App.sleep();
      }
    } finally {
      clearInterval(renewLease);
      try {
        await leaseRef.transaction(current => current?.clientId === App.CLIENT_INSTANCE_ID ? null : undefined, undefined, false);
      } catch {}
    }
  })();
  try {
    await App.htmlHubLegacyMigrationPromise;
  } finally {
    App.htmlHubLegacyMigrationPromise = null;
  }
};
App.readHtmlHubItem = async function (id) {
  if (!App.currentUser?.code || !id) return null;
  const key = String(id);
  const baseRef = App.db.ref(`${App.htmlHubPath()}/${key}`);
  const metaRef = App.db.ref(`${App.htmlHubMetaPath()}/${key}`);
  try {
    const metaSnap = await metaRef.once("value");
    if (!metaSnap.exists() || metaSnap.val()?.deleted || metaSnap.val()?.uploadPending) return null;
    const meta = App.normalizeHtmlHubMeta(key, metaSnap.val());
    if (meta.schemaVersion >= 4) {
      const descriptor = (await baseRef.once("value")).val();
      if (!App.isExternalBlobDescriptor(descriptor)) return null;
      const response = await fetch(App.getExternalBlobURL(descriptor));
      if (!response.ok) throw new Error("The HTML file could not be downloaded.");
      const blob = await response.blob();
      if (blob.size !== descriptor.size) throw new Error("The HTML file is incomplete.");
      return { ...meta, html: await blob.text() };
    }
    const chunkCountSnap = await baseRef.child("htmlChunkCount").once("value");
    const parts = [];
    const declaredCount = Math.max(0, Number(chunkCountSnap.val() || 0));
    if (!Number.isSafeInteger(declaredCount) || declaredCount > 10000) return null;
    const firstSnap = await baseRef.child("html").once("value");
    let firstVal = firstSnap.val();
    if (firstVal == null) {
      const legacyFirst = await baseRef.child("html1").once("value");
      firstVal = legacyFirst.val();
    }
    if (firstVal == null) return null;
    parts.push(String(firstVal || ""));
    if (declaredCount) {
      // Overlap a few small reads; never subscribe to the entire HTML payload.
      await App.runTaskPool(Array.from({ length: declaredCount - 1 }, (_, offset) => async () => {
        const index = offset + 2;
        const value = (await baseRef.child(`html${index}`).once("value")).val();
        if (typeof value !== "string") throw new Error("Incomplete HTML upload.");
        parts[index - 1] = value;
      }), 3);
    } else {
      for (let index = 2; index <= 10000; index += 1) {
        const value = (await baseRef.child(`html${index}`).once("value")).val();
        if (value == null) break;
        parts.push(String(value));
      }
    }
    return {
      ...meta,
      html: parts.join("")
    };
  } catch {
    return null;
  }
};
App.ensureHtmlHubGameLoaded = async function (game = App.selectedGame) {
  if (!game) return null;
  if (game.html != null) return game;
  if (!game.hubId) return game;
  if (game.__htmlLoadPromise) return game.__htmlLoadPromise;
  game.__htmlLoadPromise = (async () => {
    const item = await App.readHtmlHubItem(game.hubId);
    if (!item) return null;
    game.label = item.title;
    game.html = item.html;
    return game;
  })();
  try {
    return await game.__htmlLoadPromise;
  } finally {
    delete game.__htmlLoadPromise;
  }
};
App.createHtmlHubItem = async function ({
  title,
  html = "",
  file = null,
  signal = null,
  onProgress = null
} = {}) {
  if (!App.currentUser?.code) return null;
  App.assertExternalStorageConfigured();
  const blob = file instanceof Blob ? file : new Blob([String(html || "")], { type: "text/html;charset=utf-8" });
  if (blob.size > App.CHAT_FILE_MAX_BYTES) throw new Error(`HTML files must be ${App.CHAT_FILE_MAX_LABEL} or smaller.`);
  const id = App.makeHtmlHubId();
  const ownerCode = String(App.currentUser.code);
  const ownerUsername = String(App.currentUser.username || "Unknown user");
  const fileMeta = {
    title,
    titleLower: String(title).toLowerCase(),
    ownerCode,
    ownerUsername,
    ownerUsernameLower: ownerUsername.toLowerCase(),
    schemaVersion: 4,
    createdAt: App.firebase.database.ServerValue.TIMESTAMP,
    updatedAt: App.firebase.database.ServerValue.TIMESTAMP,
    fileName: file instanceof File ? String(file.name || "") : "",
    byteSize: blob.size
  };
  const itemRef = App.db.ref(`${App.htmlHubPath()}/${id}`);
  const metaRef = App.db.ref(`${App.htmlHubMetaPath()}/${id}`);
  const ownerRef = App.db.ref(`${App.HTML_HUB_BY_OWNER_NODE}/${ownerCode}/${id}`);
  const scope = App.createFirebaseUploadScope({
    type: "html-hub",
    place: App.getStoredPlace() || "home",
    disconnectRefs: [metaRef, ownerRef, itemRef],
    cleanup: async () => {
      try { await App.deleteExternalBlobPrefix(`html/${id}/`); } catch {}
      try {
        await itemRef.remove();
      } catch {}
      try {
        await metaRef.remove();
      } catch {}
      try {
        await ownerRef.remove();
      } catch {}
    }
  });
  const abortExternal = () => scope.abort(signal?.reason || "upload aborted");
  signal?.addEventListener("abort", abortExternal, { once: true });
  if (signal?.aborted) abortExternal();
  const uploadSignal = scope.signal;
  try {
    await App.armFirebaseUploadDisconnect(scope);
    App.throwIfUploadAborted(uploadSignal);
    const report = pct => {
      const n = Math.max(0, Math.min(100, Number(pct) || 0));
      if (typeof onProgress === "function") onProgress(n);
    };
    const stored = await App.uploadExternalBlob(blob, {
      path: `html/${id}/file`, signal: uploadSignal, onProgress: ratio => report(ratio * 100)
    });
    const publishedMeta = {
      title,
      titleLower: String(title).toLowerCase(),
      ownerCode,
      ownerUsername,
      ownerUsernameLower: ownerUsername.toLowerCase(),
      createdAt: App.firebase.database.ServerValue.TIMESTAMP,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP,
      fileName: fileMeta.fileName,
      byteSize: fileMeta.byteSize,
      schemaVersion: 4
    };
    App.throwIfUploadAborted(uploadSignal);
    await App.db.ref().update({
      [`${App.htmlHubPath()}/${id}`]: stored,
      [`${App.htmlHubMetaPath()}/${id}`]: publishedMeta,
      [`${App.HTML_HUB_BY_OWNER_NODE}/${ownerCode}/${id}`]: true
    });
    await App.finishFirebaseUploadScope(scope);
    return id;
  } catch (e) {
    await App.cleanupFirebaseUploadScope(scope, e?.message || "html upload failed");
    throw e;
  } finally {
    signal?.removeEventListener("abort", abortExternal);
  }
};
App.updateHtmlHubTitle = async function (id, title) {
  const item = await App.readHtmlHubMetaById(id);
  if (!App.canManageHtmlHubItem(item)) return false;
  const titleLower = String(title).toLowerCase();
  const updatedAt = App.firebase.database.ServerValue.TIMESTAMP;
  await App.db.ref().update({
    [`${App.htmlHubMetaPath()}/${id}/title`]: title,
    [`${App.htmlHubMetaPath()}/${id}/titleLower`]: titleLower,
    [`${App.htmlHubMetaPath()}/${id}/updatedAt`]: updatedAt,
    ...(item.schemaVersion < 3 ? {
      [`${App.htmlHubPath()}/${id}/title`]: title,
      [`${App.htmlHubPath()}/${id}/titleLower`]: titleLower,
      [`${App.htmlHubPath()}/${id}/updatedAt`]: updatedAt
    } : {})
  });
  return true;
};
App.deleteHtmlHubItem = async function (id) {
  if (!App.currentUser?.code || !id) return;
  const item = await App.readHtmlHubMetaById(id);
  if (!App.canManageHtmlHubItem(item)) return false;
  if (item.schemaVersion >= 4) {
    // Finish external deletion before dropping its database reference, so a
    // failed storage request leaves a record the user can retry deleting.
    await App.deleteExternalBlobPrefix(`html/${id}/`);
  }
  await App.db.ref().update({
    [`${App.htmlHubPath()}/${id}`]: null,
    [`${App.htmlHubMetaPath()}/${id}`]: item.schemaVersion >= 3 ? null : {
      deleted: true,
      deletedAt: App.firebase.database.ServerValue.TIMESTAMP,
      ownerCode: item.ownerCode,
      schemaVersion: 2
    },
    [`${App.HTML_HUB_BY_OWNER_NODE}/${item.ownerCode}/${id}`]: null
  });
  const isDeletedSelectedGame = App.selectedGame?.hubId === id;
  App.forgetParkedGamesFrame(`hub:${id}`);
  if (isDeletedSelectedGame) {
    App.selectedGame = null;
    await App.closeGamesStage({
      preserve: false
    });
  }
  return true;
};

App.register("activities/library-storage", function initializeFeature() {

});
})(globalThis.ChatApp);
