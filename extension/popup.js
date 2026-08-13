const formEl = document.getElementById("form");
const extractingEl = document.getElementById("extracting");
const noPageEl = document.getElementById("noPage");
const statusMsg = document.getElementById("statusMsg");
const saveBtn = document.getElementById("saveBtn");
const refreshBtn = document.getElementById("refreshBtn");
const serverUrlInput = document.getElementById("serverUrl");
const accessTokenInput = document.getElementById("accessToken");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const connectionStatus = document.getElementById("connectionStatus");
const openTracker = document.getElementById("openTracker");

let currentConnection = null;
let pendingStoredCredential = null;
let currentConnectionRecord = null;
let connectionGeneration = 0;
let credentialMutationQueue = Promise.resolve();
let inMemoryConnectionTombstone = null;
let trustedStorageFailurePromise = null;
let trustedStoragePurgeSucceeded = false;

const CREDENTIAL_KEYS = [
  "connection",
  "serverUrl",
  "accessToken",
  "installationId",
  "installationToken",
];
const CONNECTION_TOMBSTONE_KEY = "connectionTombstone";

let trustedStoragePromise;
try {
  trustedStoragePromise = Promise.resolve(
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ).then(
    () => true,
    () => false
  );
} catch {
  trustedStoragePromise = Promise.resolve(false);
}

function normalizeServerOrigin(value) {
  const input = String(value).trim();
  if (!/^https?:\/\//i.test(input) || input.includes("\\")) {
    throw new Error("Enter a valid server URL.");
  }

  const authorityStart = input.indexOf("://") + 3;
  const suffixStart = input.slice(authorityStart).search(/[/?#]/);
  const suffix = suffixStart === -1
    ? ""
    : input.slice(authorityStart + suffixStart);
  const authority = suffixStart === -1
    ? input.slice(authorityStart)
    : input.slice(authorityStart, authorityStart + suffixStart);
  if (authority.includes("@")) {
    throw new Error("The server URL cannot include credentials.");
  }
  if (suffix !== "" && suffix !== "/") {
    throw new Error("Enter only the server origin, without a path or query.");
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Enter a valid server URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The server URL must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The server URL cannot include credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Enter only the server origin, without a path or query.");
  }

  const isLoopback = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && !isLoopback) {
    throw new Error("HTTPS is required outside localhost development.");
  }

  return parsed.origin;
}

function permissionPattern(origin) {
  const parsed = new URL(origin);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${parsed.hostname}:${port}/*`;
}

function setConnectionStatus(message, type = "info", loading = false) {
  connectionStatus.textContent = message;
  connectionStatus.className = `connection-status ${type}`;
  connectBtn.disabled = loading;
  connectBtn.textContent = loading ? "Connecting..." : "Connect";
  disconnectBtn.disabled = loading || !(currentConnection || pendingStoredCredential);
}

function clearApplicationTarget() {
  delete openTracker.dataset.appUrl;
  openTracker.textContent = "Open tracker";
}

function resetAnalysisUi() {
  const analyzeBtn = document.getElementById("analyzeBtn");
  analyzeBtn.style.display = "block";
  analyzeBtn.disabled = false;
  analyzeBtn.textContent = "Analyze Keywords";

  document.getElementById("analysisSection").style.display = "none";
  const prompt = document.getElementById("analysisPrompt");
  prompt.style.display = "none";
  prompt.innerHTML = "";
  document.getElementById("analysisBadge").textContent = "";
  document.getElementById("analysisSummary").textContent = "";
  document.getElementById("progressFill").style.width = "";

  for (const prefix of ["matched", "missing"]) {
    document.getElementById(`${prefix}Section`).style.display = "none";
    document.getElementById(`${prefix}Pills`).innerHTML = "";
  }
}

function replaceCurrentConnection(connection) {
  connectionGeneration += 1;
  currentConnection = connection
    ? { ...connection, generation: connectionGeneration }
    : null;
  resetAnalysisUi();
}

function isCurrentGeneration(generation) {
  return connectionGeneration === generation;
}

function mutateCredentials(operation) {
  const mutation = credentialMutationQueue.then(operation, operation);
  credentialMutationQueue = mutation.then(
    () => undefined,
    () => undefined
  );
  return mutation;
}

async function purgeKnownCredentials() {
  try {
    await chrome.storage.local.remove(CREDENTIAL_KEYS);
    return true;
  } catch {
    return false;
  }
}

async function handleTrustedStorageFailure() {
  if (!trustedStorageFailurePromise) {
    trustedStorageFailurePromise = (async () => {
      pendingStoredCredential = null;
      currentConnectionRecord = null;
      inMemoryConnectionTombstone = { invalidated: true };
      replaceCurrentConnection(null);
      clearApplicationTarget();
      trustedStoragePurgeSucceeded = await purgeKnownCredentials();
    })();
  }
  await trustedStorageFailurePromise;
  setConnectionStatus(
    trustedStoragePurgeSucceeded
      ? "Secure credential storage is unavailable. Stored credentials were purged. JobTracker requires Chrome 140 or newer."
      : "Secure credential storage is unavailable and stored credentials could not be purged. They will not be used. JobTracker requires Chrome 140 or newer.",
    "error"
  );
}

async function requireTrustedStorage() {
  if (await trustedStoragePromise) return;
  await handleTrustedStorageFailure();
  throw new Error("Secure extension storage is unavailable.");
}

function getStoredConnection(result) {
  const record = result?.connection && typeof result.connection === "object"
    ? result.connection
    : null;
  if (record) {
    const installationId = record.installationId ||
      installationSelector(record.installationToken);
    const legacy = typeof record.accessToken === "string" ||
      (!record.invalidated && !installationId);
    return {
      serverUrl: record.serverUrl,
      installationId,
      installationToken: record.invalidated || legacy
        ? undefined
        : record.installationToken,
      invalidated: record.invalidated === true || legacy,
      remoteRevocationUnconfirmed:
        record.remoteRevocationUnconfirmed === true,
      pendingCleanupOrigins: normalizePendingCleanupOrigins(
        record.pendingCleanupOrigins
      ),
      legacy,
    };
  }
  const installationId = result?.installationId ||
    installationSelector(result?.installationToken);
  const legacy = typeof result?.accessToken === "string";
  return {
    serverUrl: result?.serverUrl,
    installationId,
    installationToken: legacy
      ? undefined
      : result?.installationToken,
    invalidated: legacy || !installationId,
    remoteRevocationUnconfirmed: false,
    pendingCleanupOrigins: [],
    legacy,
    flatInstallation: Boolean(
      installationId && result?.installationToken && !result?.accessToken
    ),
  };
}

function installationSelector(token) {
  if (typeof token !== "string") return undefined;
  const match = token.match(
    /^jt_install_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/u
  );
  return match?.[1];
}

function normalizePendingCleanupOrigins(origins) {
  if (!Array.isArray(origins)) return [];
  const normalized = [];
  for (const value of origins) {
    try {
      const origin = normalizeServerOrigin(value);
      if (!normalized.includes(origin)) normalized.push(origin);
    } catch {
      // Invalid cleanup entries are never converted into host permissions.
    }
  }
  return normalized;
}

function connectionRecord(record) {
  const normalized = {
    serverUrl: record.serverUrl,
    ...(record.installationId ? { installationId: record.installationId } : {}),
    ...(record.invalidated ? {} : {
      installationToken: record.installationToken,
    }),
    invalidated: record.invalidated === true,
    ...(record.remoteRevocationUnconfirmed
      ? { remoteRevocationUnconfirmed: true }
      : {}),
  };
  const pendingCleanupOrigins = normalizePendingCleanupOrigins(
    record.pendingCleanupOrigins
  );
  if (pendingCleanupOrigins.length) {
    normalized.pendingCleanupOrigins = pendingCleanupOrigins;
  }
  return normalized;
}

async function storeConnectionRecord(record) {
  const normalized = connectionRecord(record);
  await chrome.storage.local.set({ connection: normalized });
  currentConnectionRecord = normalized;
  try {
    await chrome.storage.local.remove([
      "serverUrl",
      "accessToken",
      "installationId",
      "installationToken",
    ]);
    return true;
  } catch {
    return false;
  }
}

function restoreConnection(result) {
  replaceCurrentConnection(null);
  pendingStoredCredential = null;
  accessTokenInput.value = "";
  const stored = getStoredConnection(result);
  currentConnectionRecord = connectionRecord(stored);

  if (typeof stored.serverUrl === "string" && stored.serverUrl) {
    serverUrlInput.value = stored.serverUrl;
  }

  if (!stored.invalidated && typeof stored.installationId === "string" &&
      typeof stored.installationToken === "string" &&
      stored.installationToken && typeof stored.serverUrl === "string") {
    try {
      const origin = normalizeServerOrigin(stored.serverUrl);
      replaceCurrentConnection({
        serverUrl: origin,
        installationId: stored.installationId,
        installationToken: stored.installationToken,
      });
      currentConnectionRecord = connectionRecord({
        serverUrl: origin,
        installationId: stored.installationId,
        installationToken: stored.installationToken,
        invalidated: false,
        pendingCleanupOrigins: stored.pendingCleanupOrigins,
      });
      serverUrlInput.value = origin;
      setConnectionStatus(`Connected to ${origin}`, "success");
      return;
    } catch {
      // Preserve an invalid legacy URL as a draft, but never use its token.
    }
  }

  setConnectionStatus(
    stored.legacy
      ? "Legacy credentials were removed — create a pairing code in Settings to re-pair."
      : "Disconnected — enter a pairing code to connect.",
    "info"
  );
}

async function removePermission(pattern) {
  let permissionPresent;
  try {
    permissionPresent = await chrome.permissions.contains({
      origins: [pattern],
    }) === true;
  } catch {
    return false;
  }
  if (!permissionPresent) return true;

  let removed;
  try {
    removed = await chrome.permissions.remove({ origins: [pattern] }) === true;
  } catch {
    return false;
  }
  if (removed) return true;

  try {
    return await chrome.permissions.contains({
      origins: [pattern],
    }) === false;
  } catch {
    return false;
  }
}

function recordWithPendingCleanup(record, origin) {
  return connectionRecord({
    ...record,
    pendingCleanupOrigins: [
      ...normalizePendingCleanupOrigins(record?.pendingCleanupOrigins),
      origin,
    ],
  });
}

function recordWithoutPendingCleanup(record, origin) {
  return connectionRecord({
    ...record,
    pendingCleanupOrigins: normalizePendingCleanupOrigins(
      record?.pendingCleanupOrigins
    ).filter((candidate) => candidate !== origin),
  });
}

function memoryRecord(fallbackOrigin = "") {
  if (currentConnection) {
    return connectionRecord({
      serverUrl: currentConnection.serverUrl,
      installationId: currentConnection.installationId,
      installationToken: currentConnection.installationToken,
      invalidated: false,
      pendingCleanupOrigins: currentConnectionRecord?.pendingCleanupOrigins,
    });
  }
  if (currentConnectionRecord?.serverUrl) return currentConnectionRecord;
  return connectionRecord({
    serverUrl: fallbackOrigin,
    invalidated: true,
  });
}

async function persistPendingCleanup(origin, baseRecord = memoryRecord(origin)) {
  const pendingRecord = recordWithPendingCleanup(baseRecord, origin);
  try {
    await storeConnectionRecord(pendingRecord);
    return true;
  } catch {
    return false;
  }
}

async function cleanupPermissionAndRecord(origin, baseRecord) {
  const permissionClean = await removePermission(permissionPattern(origin));
  if (!permissionClean) {
    const persisted = await persistPendingCleanup(origin, baseRecord);
    return { permissionClean: false, recordClean: persisted };
  }

  const pendingRecord = recordWithoutPendingCleanup(baseRecord, origin);
  if (normalizePendingCleanupOrigins(baseRecord?.pendingCleanupOrigins).includes(origin)) {
    try {
      await storeConnectionRecord(pendingRecord);
    } catch {
      return { permissionClean: true, recordClean: false };
    }
  }
  return { permissionClean: true, recordClean: true };
}

async function setSessionTombstone(origin) {
  inMemoryConnectionTombstone = {
    ...(origin ? { serverUrl: origin } : {}),
    invalidated: true,
  };
  try {
    if (!chrome.storage.session?.set) return false;
    await chrome.storage.session.set({
      [CONNECTION_TOMBSTONE_KEY]: inMemoryConnectionTombstone,
    });
    return true;
  } catch {
    return false;
  }
}

async function clearSessionTombstone() {
  try {
    if (chrome.storage.session?.remove) {
      await chrome.storage.session.remove(CONNECTION_TOMBSTONE_KEY);
    }
    inMemoryConnectionTombstone = null;
    return true;
  } catch {
    return false;
  }
}

async function readSessionTombstone() {
  if (inMemoryConnectionTombstone) return inMemoryConnectionTombstone;
  try {
    if (!chrome.storage.session?.get) return null;
    const result = await chrome.storage.session.get([CONNECTION_TOMBSTONE_KEY]);
    const tombstone = result?.[CONNECTION_TOMBSTONE_KEY];
    if (tombstone && typeof tombstone === "object") {
      inMemoryConnectionTombstone = tombstone;
      return tombstone;
    }
    return null;
  } catch {
    return inMemoryConnectionTombstone;
  }
}

async function persistInvalidatedRecord(
  origin,
  pendingCleanupOrigins = [],
  metadata = {}
) {
  const record = connectionRecord({
    serverUrl: origin,
    installationId: metadata.installationId,
    invalidated: true,
    remoteRevocationUnconfirmed:
      metadata.remoteRevocationUnconfirmed === true,
    pendingCleanupOrigins,
  });
  try {
    const legacyClean = await storeConnectionRecord(record);
    if (legacyClean) return { record, storageClean: true, retried: false };
    try {
      await chrome.storage.local.remove([
        "serverUrl",
        "accessToken",
        "installationId",
        "installationToken",
      ]);
      return { record, storageClean: true, retried: true };
    } catch {
      return { record, storageClean: false, retried: true };
    }
  } catch {
    const storageClean = await purgeKnownCredentials();
    if (storageClean) currentConnectionRecord = null;
    return { record, storageClean, retried: true };
  }
}

async function connectServer() {
  const pairingCode = accessTokenInput.value;
  let origin;

  try {
    origin = normalizeServerOrigin(serverUrlInput.value);
  } catch (error) {
    accessTokenInput.value = "";
    setConnectionStatus(error.message, "error");
    serverUrlInput.focus();
    return;
  }

  if (!pairingCode) {
    setConnectionStatus("Enter a pairing code to connect.", "error");
    accessTokenInput.focus();
    return;
  }

  const pattern = permissionPattern(origin);
  setConnectionStatus("Requesting access to the server...", "info", true);

  try {
    // Both permission calls start directly from the click stack. Every later
    // credential/permission/status mutation remains inside one queued operation.
    const priorPermissionPromise = Promise.resolve(
      chrome.permissions.contains({ origins: [pattern] })
    ).then(
      (contains) => contains === true,
      () => "unknown"
    );
    const requestPromise = Promise.resolve(
      chrome.permissions.request({ origins: [pattern] })
    );
    await mutateCredentials(async () => {
      let priorPermissionState = "unknown";
      let granted = false;
      let committed = false;
      let phase = "permission";
      try {
        [priorPermissionState, granted] = await Promise.all([
          priorPermissionPromise,
          requestPromise,
        ]);
        if (!granted) {
          setConnectionStatus(
            "Server access was not granted. The previous connection is unchanged.",
            "error"
          );
          return;
        }

        phase = "storage-access";
        await requireTrustedStorage();
        phase = "pair";
        setConnectionStatus("Exchanging one-time pairing code...", "info", true);
        const response = await fetch(`${origin}/api/extension/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: pairingCode }),
        });
        if (response.status === 401) {
          throw new Error("The pairing code was not accepted.");
        }
        if (response.status === 403) {
          throw new Error("This extension is not allowed by the server.");
        }
        if (!response.ok) {
          throw new Error(`The server could not pair this installation (${response.status}).`);
        }
        const issued = await response.json();
        if (
          typeof issued?.installationId !== "string" ||
          typeof issued?.token !== "string" ||
          !/^jt_install_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u.test(
            issued.token
          )
        ) {
          throw new Error("The server returned an invalid installation credential.");
        }
        phase = "permission-confirm";
        let permissionStillGranted = false;
        try {
          permissionStillGranted = await chrome.permissions.contains({
            origins: [pattern],
          }) === true;
        } catch {
          permissionStillGranted = false;
        }
        if (!permissionStillGranted) {
          setConnectionStatus(
            "Server access changed while connecting. Click Connect again to grant access.",
            "error"
          );
          return;
        }

        phase = "storage";
        const hadSessionTombstone = Boolean(inMemoryConnectionTombstone);
        const previous = currentConnection ? { ...currentConnection } : null;
        const previousRecord = memoryRecord(previous?.serverUrl || origin);
        const oldOrigin = previous && previous.serverUrl !== origin
          ? previous.serverUrl
          : null;
        const tombstoneOrigin = hadSessionTombstone &&
          typeof inMemoryConnectionTombstone.serverUrl === "string"
          ? inMemoryConnectionTombstone.serverUrl
          : null;
        const pendingOrigins = normalizePendingCleanupOrigins([
          ...normalizePendingCleanupOrigins(previousRecord.pendingCleanupOrigins)
            .filter((candidate) => candidate !== origin),
          ...(oldOrigin ? [oldOrigin] : []),
          ...(tombstoneOrigin && tombstoneOrigin !== origin
            ? [tombstoneOrigin]
            : []),
        ]);
        const pendingBeforeCleanup = connectionRecord({
          serverUrl: origin,
          installationId: issued.installationId,
          installationToken: issued.token,
          invalidated: false,
          pendingCleanupOrigins: pendingOrigins,
        });
        const legacyClean = await storeConnectionRecord(pendingBeforeCleanup);
        if (hadSessionTombstone && !(await clearSessionTombstone())) {
          await persistInvalidatedRecord(origin, [origin]);
          throw new Error("Disconnect state could not be cleared safely.");
        }
        pendingStoredCredential = null;
        replaceCurrentConnection({
          serverUrl: origin,
          installationId: issued.installationId,
          installationToken: issued.token,
        });
        committed = true;
        const committedConnection = { ...currentConnection };
        clearApplicationTarget();
        serverUrlInput.value = origin;

        let permissionClean = true;
        let cleanupRecordClean = true;
        let workingRecord = pendingBeforeCleanup;
        for (const cleanupOrigin of pendingOrigins) {
          const cleanup = await cleanupPermissionAndRecord(
            cleanupOrigin,
            workingRecord
          );
          permissionClean = permissionClean && cleanup.permissionClean;
          cleanupRecordClean = cleanupRecordClean && cleanup.recordClean;
          if (cleanup.permissionClean && cleanup.recordClean) {
            workingRecord = recordWithoutPendingCleanup(
              workingRecord,
              cleanupOrigin
            );
          }
        }

        if (!sameConnection(currentConnection, committedConnection)) return;
        const warnings = [
          !permissionClean ? "Old host access could not be removed." : "",
          !cleanupRecordClean ? "Host cleanup state could not be saved." : "",
          !legacyClean ? "Legacy credential cleanup failed." : "",
        ].filter(Boolean).join(" ");
        setConnectionStatus(
          `Connected to ${origin}.${warnings ? ` ${warnings}` : ""}`,
          warnings ? "info" : "success"
        );
      } catch (error) {
        let cleanup = { permissionClean: true, recordClean: true };
        if (granted && priorPermissionState === false && !committed) {
          cleanup = await cleanupPermissionAndRecord(
            origin,
            memoryRecord(origin)
          );
        }

        if (phase === "storage-access") {
          await handleTrustedStorageFailure();
        } else if (phase === "permission") {
          setConnectionStatus(
            "Server access was not granted. The previous connection is unchanged.",
            "error"
          );
        } else if (phase === "storage") {
          setConnectionStatus(
            "Could not save the connection. The previous connection is unchanged.",
            "error"
          );
        } else if (error?.message?.startsWith("The pairing code") ||
                   error?.message?.includes("not allowed") ||
                   error?.message?.startsWith("The server could not pair") ||
                   error?.message?.startsWith("The server returned")) {
          setConnectionStatus(error.message, "error");
        } else {
          setConnectionStatus(
            "Could not reach the server. Check its URL and CORS configuration.",
            "error"
          );
        }
        if (!cleanup.permissionClean || !cleanup.recordClean) {
          setConnectionStatus(
            `${connectionStatus.textContent} Host access cleanup remains pending.`,
            "error"
          );
        }
      }
    });
  } catch {
    setConnectionStatus(
      "Server permission access is unavailable. The previous connection is unchanged.",
      "error"
    );
  } finally {
    accessTokenInput.value = "";
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
    disconnectBtn.disabled = !(currentConnection || pendingStoredCredential);
  }
}

async function disconnectServer() {
  await mutateCredentials(async () => {
    const connection = currentConnection || pendingStoredCredential;
    let origin = connection?.serverUrl;
    if (!origin) {
      try {
        origin = normalizeServerOrigin(serverUrlInput.value);
      } catch {
        origin = "";
      }
    }

    let remoteRevocationConfirmed = true;
    if (connection?.installationToken && connection?.installationId && origin) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(`${origin}/api/extension/revoke`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.installationToken}`,
          },
          signal: controller.signal,
        });
        remoteRevocationConfirmed = response.ok || response.status === 401;
      } catch {
        remoteRevocationConfirmed = false;
      } finally {
        clearTimeout(timeout);
      }
    }

    pendingStoredCredential = null;
    replaceCurrentConnection(null);
    clearApplicationTarget();
    accessTokenInput.value = "";
    await setSessionTombstone(origin);

    let storageClean = true;
    let storageRetried = false;
    let permissionClean = true;
    let cleanupRecordClean = true;
    if (origin) {
      const pendingOrigins = [
        ...normalizePendingCleanupOrigins(currentConnectionRecord?.pendingCleanupOrigins),
        origin,
      ];
      const persistence = await persistInvalidatedRecord(
        origin,
        pendingOrigins,
        {
          installationId: connection?.installationId,
          remoteRevocationUnconfirmed: !remoteRevocationConfirmed,
        }
      );
      storageClean = persistence.storageClean;
      storageRetried = persistence.retried;
      if (storageClean) {
        const cleanup = await cleanupPermissionAndRecord(
          origin,
          persistence.record
        );
        permissionClean = cleanup.permissionClean;
        cleanupRecordClean = cleanup.recordClean;
      } else {
        permissionClean = await removePermission(permissionPattern(origin));
      }
    }
    if (storageClean && permissionClean && cleanupRecordClean) {
      await clearSessionTombstone();
    }
    const warnings = [
      !storageClean ? "Credential storage could not be updated." : "",
      !permissionClean ? "Host access could not be removed." : "",
      !cleanupRecordClean ? "Host cleanup state could not be saved." : "",
      storageRetried && !storageClean ? "Credential purge also failed." : "",
      !remoteRevocationConfirmed
        ? "Remote revocation is unconfirmed; revoke it in web Settings."
        : "",
    ].filter(Boolean).join(" ");
    setConnectionStatus(
      warnings || "Disconnected. Enter a pairing code to reconnect.",
      warnings ? "error" : "info"
    );
  });
}

function sameConnection(left, right) {
  return Boolean(left && right &&
    left.generation === right.generation &&
    left.serverUrl === right.serverUrl &&
    left.installationId === right.installationId &&
    left.installationToken === right.installationToken);
}

async function invalidateUnauthorizedConnection(connection) {
  return mutateCredentials(async () => {
    if (!sameConnection(currentConnection, connection)) return false;

    const existingPending = normalizePendingCleanupOrigins(
      currentConnectionRecord?.pendingCleanupOrigins
    );
    pendingStoredCredential = null;
    replaceCurrentConnection(null);
    clearApplicationTarget();
    accessTokenInput.value = "";
    await setSessionTombstone(connection.serverUrl);

    const persistence = await persistInvalidatedRecord(
      connection.serverUrl,
      [...existingPending, connection.serverUrl],
      { installationId: connection.installationId }
    );
    let permissionClean;
    let cleanupRecordClean = true;
    if (persistence.storageClean) {
      const cleanup = await cleanupPermissionAndRecord(
        connection.serverUrl,
        persistence.record
      );
      permissionClean = cleanup.permissionClean;
      cleanupRecordClean = cleanup.recordClean;
    } else {
      permissionClean = await removePermission(
        permissionPattern(connection.serverUrl)
      );
    }
    if (persistence.storageClean && permissionClean && cleanupRecordClean) {
      await clearSessionTombstone();
    }
    const warnings = [
      !persistence.storageClean ? "Credential storage could not be updated." : "",
      !permissionClean ? "Host access could not be removed." : "",
      !cleanupRecordClean ? "Host cleanup state could not be saved." : "",
    ].filter(Boolean).join(" ");
    setConnectionStatus(
      warnings || "Connection expired. Enter the access token to reconnect.",
      "error"
    );
    return true;
  });
}

async function authenticatedRequest(path, init = {}) {
  await requireTrustedStorage();
  if (!currentConnection) {
    throw new Error("Connect this extension to a server before using its API.");
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("API paths must be relative to the connected server.");
  }

  const connection = { ...currentConnection };
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${connection.installationToken}`);
  const response = await fetch(`${connection.serverUrl}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    await invalidateUnauthorizedConnection(connection);
    throw new Error("Connection expired. Reconnect to the server.");
  }

  return { connection, response };
}

async function apiFetch(path, init = {}) {
  return (await authenticatedRequest(path, init)).response;
}

function showStatus(message, type) {
  statusMsg.textContent = message;
  statusMsg.className = `status ${type}`;
  statusMsg.style.display = "block";
}

function populateForm(data, tabUrl) {
  document.getElementById("jobTitle").value = data.jobTitle || "";
  document.getElementById("company").value = data.company || "";
  document.getElementById("location").value = data.location || "";
  document.getElementById("description").value = data.description || "";
  document.getElementById("salary").value = data.salary || "";
  document.getElementById("jobType").value = data.jobType || "";
  document.getElementById("jobUrl").value = data.url || tabUrl || "";

  extractingEl.style.display = "none";
  formEl.style.display = "block";

  if (!data.jobTitle && !data.company) {
    showStatus("Could not auto-detect job data. Please fill in manually.", "info");
  } else if (data.warning) {
    showStatus(data.warning, "info");
  }

  // Always show analyze button
  const analyzeBtn = document.getElementById("analyzeBtn");
  if (analyzeBtn) {
    analyzeBtn.style.display = "block";
  }
}

async function runKeywordAnalysis() {
  let description = document.getElementById("description").value.trim();

  // If no description extracted, try to get it from the page
  if (!description) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const response = await sendMessageWithRetry(tab.id, { action: "extractJob" });
        if (response?.description) {
          description = response.description;
          document.getElementById("description").value = description;
        }
      }
    } catch {
      // ignore
    }
  }

  if (!description) {
    showStatus("No job description found on this page.", "info");
    return;
  }

  const section = document.getElementById("analysisSection");
  const prompt = document.getElementById("analysisPrompt");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const analysisGeneration = connectionGeneration;

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";

  try {
    const request = await authenticatedRequest("/api/keyword-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    const res = request.response;
    if (!sameConnection(currentConnection, request.connection)) return;
    if (!res.ok) {
      analyzeBtn.textContent = "Analyze Keywords";
      analyzeBtn.disabled = false;
      return;
    }

    const data = await res.json();
    if (!sameConnection(currentConnection, request.connection)) return;

    if (data.error === "no_resume") {
      prompt.innerHTML = 'Add your resume in <a href="#" id="openSettings">Settings</a> to see keyword match.';
      prompt.style.display = "block";
      analyzeBtn.style.display = "none";
      document.getElementById("openSettings")?.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: `${request.connection.serverUrl}/settings` });
      });
      return;
    }

    if (!data.totalJobKeywords || data.totalJobKeywords === 0) {
      analyzeBtn.textContent = "No keywords found";
      return;
    }

    // Hide button, show results
    analyzeBtn.style.display = "none";

    // Show analysis
    const pct = data.matchPercentage;
    const badge = document.getElementById("analysisBadge");
    const fill = document.getElementById("progressFill");

    badge.textContent = `${pct}%`;
    badge.className = `analysis-badge ${pct >= 70 ? "badge-green" : pct >= 40 ? "badge-yellow" : "badge-red"}`;
    fill.style.width = `${pct}%`;
    fill.className = `progress-fill ${pct >= 70 ? "fill-green" : pct >= 40 ? "fill-yellow" : "fill-red"}`;

    document.getElementById("analysisSummary").textContent =
      `${data.matchedKeywords.length} of ${data.totalJobKeywords} keywords matched`;

    // Matched pills
    const matchedPills = document.getElementById("matchedPills");
    const matchedSection = document.getElementById("matchedSection");
    matchedPills.innerHTML = "";
    if (data.matchedKeywords.length > 0) {
      matchedSection.style.display = "block";
      for (const k of data.matchedKeywords) {
        const pill = document.createElement("span");
        pill.className = "pill pill-green";
        pill.textContent = k.keyword;
        matchedPills.appendChild(pill);
      }
    }

    // Missing pills
    const missingPills = document.getElementById("missingPills");
    const missingSection = document.getElementById("missingSection");
    missingPills.innerHTML = "";
    if (data.missingKeywords.length > 0) {
      missingSection.style.display = "block";
      for (const k of data.missingKeywords) {
        const pill = document.createElement("span");
        pill.className = "pill pill-red";
        pill.textContent = k.keyword;
        missingPills.appendChild(pill);
      }
    }

    section.style.display = "block";
  } catch {
    if (!isCurrentGeneration(analysisGeneration)) return;
    analyzeBtn.textContent = "Analyze Keywords";
    analyzeBtn.disabled = false;
  }
}

// Analyze button click
document.getElementById("analyzeBtn")?.addEventListener("click", () => {
  runKeywordAnalysis();
});

// Toggle analysis body
document.getElementById("analysisToggle")?.addEventListener("click", () => {
  const body = document.getElementById("analysisBody");
  const expanded = body.style.display !== "none";
  body.style.display = expanded ? "none" : "block";
  document.getElementById("analysisToggle").setAttribute(
    "aria-expanded",
    String(!expanded)
  );
});

// Try sendMessage first; if the content script isn't loaded (e.g. LinkedIn
// SPA navigation, or the tab pre-dates the extension install), inject it
// and retry once.
function isMissingReceiverError(error) {
  const message = typeof error?.message === "string"
    ? error.message
    : String(error);
  return message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist");
}

async function sendMessageWithRetry(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function serverExtract(url) {
  if (!url || url.startsWith("chrome://")) return null;
  try {
    const res = await apiFetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function extractFromPage() {
  extractingEl.style.display = "block";
  formEl.style.display = "none";
  noPageEl.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      noPageEl.style.display = "block";
      extractingEl.style.display = "none";
      return;
    }

    const response = await sendMessageWithRetry(tab.id, { action: "extractJob" });

    let result = response;

    // If content script couldn't extract, fall back to server-side extraction
    if (!response.jobTitle && !response.company) {
      const serverResult = await serverExtract(tab.url);
      if (serverResult && (serverResult.jobTitle || serverResult.company)) {
        // Merge: keep content script's location/description if server didn't provide them
        result = {
          ...response,
          ...serverResult,
          location: response.location || serverResult.location || "",
          description: response.description || serverResult.description || "",
        };
      }
    }

    populateForm(result, tab.url);
  } catch {
    // Content script failed entirely — try server-side extraction
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab?.url || "";

    const serverResult = await serverExtract(pageUrl);
    if (serverResult && (serverResult.jobTitle || serverResult.company)) {
      populateForm(serverResult, pageUrl);
    } else {
      extractingEl.style.display = "none";
      formEl.style.display = "block";
      document.getElementById("jobUrl").value = pageUrl;
      showStatus("Could not extract from this page. Enter details manually.", "info");
    }
  }
}

saveBtn.addEventListener("click", async () => {
  const jobTitle = document.getElementById("jobTitle").value.trim();
  const company = document.getElementById("company").value.trim();
  const location = document.getElementById("location").value.trim();
  const description = document.getElementById("description").value.trim();
  const salary = document.getElementById("salary").value.trim();
  const jobType = document.getElementById("jobType").value.trim();
  const url = document.getElementById("jobUrl").value.trim();

  if (!url) {
    showStatus("Job URL is required.", "error");
    return;
  }

  if (!jobTitle || !company) {
    showStatus("Job title and company are required.", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    const request = await authenticatedRequest("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        jobTitle,
        company,
        location: location || null,
        description: description || null,
        salary: salary || null,
        jobType: jobType || null,
      }),
    });

    if (!request.response.ok) {
      throw new Error("Server returned " + request.response.status);
    }

    const result = await request.response.json();
    if (!sameConnection(currentConnection, request.connection)) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Application";
      return;
    }
    const appUrl = `${request.connection.serverUrl}/applications/${result.id}`;

    if (result.result === "existing") {
      showStatus("Application already exists; saved details were kept.", "success");
    } else {
      showStatus("Application saved to JobTracker!", "success");
    }
    saveBtn.textContent = "Saved!";

    // Replace "Open" link to go directly to this application
    const openLink = document.getElementById("openTracker");
    openLink.textContent = "View";
    openLink.dataset.appUrl = appUrl;
  } catch (err) {
    showStatus(
      err?.message || "Failed to save. Check the JobTracker connection.",
      "error"
    );
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Application";
  }
});

refreshBtn.addEventListener("click", () => {
  statusMsg.style.display = "none";
  extractFromPage();
});

document.getElementById("openTracker").addEventListener("click", (e) => {
  e.preventDefault();
  const openLink = document.getElementById("openTracker");
  let trackerUrl = serverUrlInput.value;
  try {
    trackerUrl = normalizeServerOrigin(trackerUrl);
  } catch {
    // This is normal navigation, not an authenticated extension API request.
  }
  const targetUrl = openLink.dataset.appUrl || trackerUrl;
  chrome.tabs.create({ url: targetUrl });
});

// Auto-fill profile URLs on application forms
async function fillProfiles() {
  const fillBtn = document.getElementById("fillProfilesBtn");

  try {
    const res = await apiFetch("/api/extension/profile");
    if (!res.ok) return;
    const settings = await res.json();

    if (!settings.linkedinUrl && !settings.githubUrl) {
      if (fillBtn) fillBtn.style.display = "none";
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const response = await sendMessageWithRetry(tab.id, {
      action: "autoFillProfiles",
      profiles: {
        linkedinUrl: settings.linkedinUrl,
        githubUrl: settings.githubUrl,
      },
    });

    if (response?.filled?.length > 0) {
      showStatus(`Auto-filled: ${response.filled.join(", ")}`, "success");
    }
  } catch {
    // Silently fail — not on an application form
  }
}

document.getElementById("fillProfilesBtn")?.addEventListener("click", () => {
  fillProfiles();
});

connectBtn.addEventListener("click", () => {
  connectServer();
});

disconnectBtn.addEventListener("click", () => {
  disconnectServer();
});

async function initializePopup() {
  // Captured before the first asynchronous storage read: any newer mutation
  // makes the entire startup snapshot stale.
  const storageReadGeneration = connectionGeneration;
  try {
    await requireTrustedStorage();
    const [result, sessionTombstone] = await Promise.all([
      chrome.storage.local.get(CREDENTIAL_KEYS),
      readSessionTombstone(),
    ]);

    const startup = await mutateCredentials(async () => {
      if (!isCurrentGeneration(storageReadGeneration)) return null;
      const stored = getStoredConnection(result || {});
      pendingStoredCredential = null;
      replaceCurrentConnection(null);
      const verificationGeneration = connectionGeneration;
      clearApplicationTarget();
      accessTokenInput.value = "";
      currentConnectionRecord = connectionRecord(stored);

      if (typeof stored.serverUrl === "string" && stored.serverUrl) {
        serverUrlInput.value = stored.serverUrl;
      }

      let cleanupWarning = "";
      let workingRecord = currentConnectionRecord;
      for (const cleanupOrigin of stored.pendingCleanupOrigins) {
        const cleanup = await cleanupPermissionAndRecord(
          cleanupOrigin,
          workingRecord
        );
        if (cleanup.permissionClean && cleanup.recordClean) {
          workingRecord = recordWithoutPendingCleanup(
            workingRecord,
            cleanupOrigin
          );
        } else {
          cleanupWarning = " Host access cleanup remains pending.";
        }
      }
      currentConnectionRecord = workingRecord;

      const tombstoneOrigin = typeof sessionTombstone?.serverUrl === "string"
        ? sessionTombstone.serverUrl
        : "";
      const tombstoneMatchesStored = Boolean(sessionTombstone) &&
        (!tombstoneOrigin || tombstoneOrigin === stored.serverUrl);
      if (tombstoneMatchesStored) {
        const origin = tombstoneOrigin || stored.serverUrl || "";
        const persistence = origin
          ? await persistInvalidatedRecord(origin, [
            ...normalizePendingCleanupOrigins(
              workingRecord?.pendingCleanupOrigins
            ),
            origin,
          ])
          : { record: null, storageClean: await purgeKnownCredentials() };
        const permissionClean = origin
          ? await removePermission(permissionPattern(origin))
          : true;
        if (persistence.storageClean && permissionClean) {
          if (origin && persistence.record) {
            try {
              await storeConnectionRecord(
                recordWithoutPendingCleanup(persistence.record, origin)
              );
            } catch {
              // The invalidated record already prevents credential use.
            }
          }
          await clearSessionTombstone();
        }
        setConnectionStatus(
          persistence.storageClean && permissionClean
            ? "Disconnected. Enter an access token to reconnect."
            : "Disconnected. Credential or host-access cleanup remains pending.",
          persistence.storageClean && permissionClean ? "info" : "error"
        );
        return null;
      }

      if (sessionTombstone && tombstoneOrigin) {
        const permissionClean = await removePermission(
          permissionPattern(tombstoneOrigin)
        );
        if (permissionClean) await clearSessionTombstone();
        else cleanupWarning = " Host access cleanup remains pending.";
      }

      if (stored.legacy) {
        const legacyOrigin = typeof stored.serverUrl === "string"
          ? stored.serverUrl
          : "";
        const persistence = legacyOrigin
          ? await persistInvalidatedRecord(legacyOrigin)
          : { storageClean: await purgeKnownCredentials() };
        if (legacyOrigin) {
          await removePermission(permissionPattern(legacyOrigin));
        }
        setConnectionStatus(
          persistence.storageClean
            ? "Legacy credentials were removed. Create a pairing code in web Settings to re-pair."
            : "Legacy credentials are disabled but could not be removed. Re-pair after clearing extension storage.",
          persistence.storageClean ? "info" : "error"
        );
        return null;
      }

      if (stored.invalidated || !stored.installationId ||
          !stored.installationToken || !stored.serverUrl) {
        setConnectionStatus(
          `Disconnected — enter a pairing code to connect.${cleanupWarning}`,
          cleanupWarning ? "error" : "info"
        );
        return null;
      }

      let origin;
      try {
        origin = normalizeServerOrigin(stored.serverUrl);
      } catch {
        setConnectionStatus("Stored server URL is invalid. Reconnect.", "error");
        return null;
      }
      pendingStoredCredential = {
        serverUrl: origin,
        installationId: stored.installationId,
        flatInstallation: stored.flatInstallation === true,
        installationToken: stored.installationToken,
        generation: verificationGeneration,
      };
      setConnectionStatus("Verifying stored connection...", "info");
      return {
        cleanupWarning,
        flatInstallation: stored.flatInstallation === true,
        generation: verificationGeneration,
        installationId: stored.installationId,
        origin,
        token: stored.installationToken,
      };
    });
    if (!startup) return;

    let permissionGranted = false;
    try {
      permissionGranted = await chrome.permissions.contains({
        origins: [permissionPattern(startup.origin)],
      }) === true;
    } catch {
      permissionGranted = false;
    }
    if (!permissionGranted) {
      await mutateCredentials(async () => {
        if (!isCurrentGeneration(startup.generation)) return;
        pendingStoredCredential = null;
        await setSessionTombstone(startup.origin);
        const persistence = await persistInvalidatedRecord(startup.origin);
        if (persistence.storageClean) await clearSessionTombstone();
        setConnectionStatus(
          persistence.storageClean
            ? "Stored host access was revoked. Click Connect again to reconnect."
            : "Stored host access was revoked and credential cleanup failed. The token will not be used.",
          "error"
        );
      });
      return;
    }

    let response;
    try {
      response = await fetch(`${startup.origin}/api/auth/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${startup.token}` },
      });
    } catch {
      await mutateCredentials(async () => {
        if (!isCurrentGeneration(startup.generation)) return;
        setConnectionStatus(
          "Stored connection could not be verified. Disconnect to purge it or reconnect after checking the server.",
          "error"
        );
      });
      return;
    }

    if (response.ok) {
      await mutateCredentials(async () => {
        if (!isCurrentGeneration(startup.generation)) return;
        if (startup.flatInstallation) {
          await storeConnectionRecord({
            serverUrl: startup.origin,
            installationId: startup.installationId,
            installationToken: startup.token,
            invalidated: false,
            pendingCleanupOrigins:
              currentConnectionRecord?.pendingCleanupOrigins,
          });
        }
        pendingStoredCredential = null;
        replaceCurrentConnection({
          serverUrl: startup.origin,
          installationId: startup.installationId,
          installationToken: startup.token,
        });
        serverUrlInput.value = startup.origin;
        const warning = startup.cleanupWarning;
        setConnectionStatus(
          `Connected to ${startup.origin}.${warning}`,
          warning ? "info" : "success"
        );
      });
      return;
    }

    if (response.status === 401) {
      await mutateCredentials(async () => {
        if (!isCurrentGeneration(startup.generation)) return;
        pendingStoredCredential = null;
        await setSessionTombstone(startup.origin);
        const persistence = await persistInvalidatedRecord(
          startup.origin,
          [
            ...normalizePendingCleanupOrigins(
              currentConnectionRecord?.pendingCleanupOrigins
            ),
            startup.origin,
          ]
        );
        let permissionClean = false;
        let cleanupRecordClean = true;
        if (persistence.storageClean) {
          const cleanup = await cleanupPermissionAndRecord(
            startup.origin,
            persistence.record
          );
          permissionClean = cleanup.permissionClean;
          cleanupRecordClean = cleanup.recordClean;
        } else {
          permissionClean = await removePermission(
            permissionPattern(startup.origin)
          );
        }
        if (persistence.storageClean && permissionClean && cleanupRecordClean) {
          await clearSessionTombstone();
        }
        const warning = [
          !persistence.storageClean ? "Credential storage could not be updated." : "",
          !permissionClean ? "Host access could not be removed." : "",
          !cleanupRecordClean ? "Host cleanup state could not be saved." : "",
        ].filter(Boolean).join(" ");
        setConnectionStatus(
          warning || "Connection expired. Create a new pairing code to reconnect.",
          "error"
        );
      });
      return;
    }

    await mutateCredentials(async () => {
      if (!isCurrentGeneration(startup.generation)) return;
      setConnectionStatus(
        "Stored connection was rejected. Disconnect to purge it before reconnecting.",
        "error"
      );
    });
  } catch {
    // requireTrustedStorage already displayed a fail-closed compatibility error.
  } finally {
    extractFromPage();
  }
}

let initializationPromise = Promise.resolve();
if (typeof module === "undefined") {
  initializationPromise = initializePopup();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    apiFetch,
    connectServer,
    disconnectServer,
    extractFromPage,
    fillProfiles,
    initializationPromise,
    initializePopup,
    normalizeServerOrigin,
    permissionPattern,
    restoreConnection,
    runKeywordAnalysis,
    sendMessageWithRetry,
    serverExtract,
  };
}
