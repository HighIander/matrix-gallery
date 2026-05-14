(() => {
  "use strict";

  if (window.__matrixGallerySenderInitialized) {
    return;
  }

  window.__matrixGallerySenderInitialized = true;

  const STORAGE_KEY = "matrix_gallery_sender_config";
  const BUTTON_POSITION_KEY = "mg_button_position";
  const GALLERY_CONTENT_KEY = "de.tkluge.gallery";
  const GALLERY_HISTORY_KEY = "matrix_gallery_sender_gallery_history";
  const PAGE_BRIDGE_SOURCE = "matrix-gallery-sender-page-bridge";
  const PAGE_BRIDGE_REQUEST = "matrix-gallery-sender-session-request";
  const PAGE_BRIDGE_RESPONSE = "matrix-gallery-sender-session-response";
  const PAGE_BRIDGE_SEND_REQUEST = "matrix-gallery-sender-send-request";
  const PAGE_BRIDGE_SEND_RESPONSE = "matrix-gallery-sender-send-response";
  const PAGE_BRIDGE_SEND_PROGRESS = "matrix-gallery-sender-send-progress";
  const PAGE_BRIDGE_GALLERY_REQUEST = "matrix-gallery-sender-gallery-request";
  const PAGE_BRIDGE_GALLERY_RESPONSE = "matrix-gallery-sender-gallery-response";
  const PAGE_BRIDGE_MEDIA_REQUEST = "matrix-gallery-sender-media-request";
  const PAGE_BRIDGE_MEDIA_RESPONSE = "matrix-gallery-sender-media-response";
  const CHAT_MESSAGE_SELECTOR = "[data-event-id], .mx_EventTile";
  const MESSAGE_IMAGE_BODY_SELECTOR = [
    ".mx_MImageBody",
    ".mx_MVideoBody",
    ".mx_MStickerBody",
    ".mx_ImageBody",
    ".mx_EventTile_body",
    ".mx_EventTile_content",
    ".mx_EventTile_line"
  ].join(", ");
  const NON_CHAT_IMAGE_SELECTOR = [
    "#mg-panel",
    "#mg-toggle",
    ".mg-lightbox",
    ".mx_BaseAvatar",
    ".mx_DecoratedRoomAvatar",
    ".mx_EventTile_avatar",
    ".mx_RoomAvatar",
    ".mx_RoomTile_avatar",
    ".mx_SpacePanel",
    ".mx_SpaceButton",
    ".mx_LeftPanel",
    ".mx_RoomList",
    ".mx_ContextualMenu",
    ".mx_UserMenu",
    ".mx_RightPanel",
    "[data-testid='avatar-img']",
    "[data-testid*='avatar']",
    "[class*='Avatar']",
    "[class*='avatar']"
  ].join(", ");

  let selectedFiles = [];
  let previewUrls = [];
  let currentLightboxImages = [];
  let currentLightboxIndex = 0;
  let globalDragDepth = 0;
  let galleryRebuildTimer = null;
  let dragCleanupTimer = null;
  let lastSentGallery = null;
  let galleryHistory = [];
  let currentLightboxZoom = 1;
  let currentLightboxFitScale = 1;
  let currentLightboxPanX = 0;
  let currentLightboxPanY = 0;
  let currentLightboxPanning = false;
  const lightboxDownloadObjectUrls = new Set();
  const imageCaptions = new WeakMap();
  let pageSession = null;
  let lastComposerElement = null;
  let lastKnownRoomKey = "";
  let lastPasteSignature = "";
  let lastPasteAt = 0;
  let lastDropSignature = "";
  let lastDropAt = 0;
  const queuedFileFingerprints = new Set();
  const recentlyAddedFingerprints = new Map();
  let pasteProcessingLockUntil = 0;
  const clipboardContentHashes = new Map();
  const galleryEventMetadataByEventId = new Map();

  injectPageBridge();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  function boot() {
    createGlobalDropHint();
    createToggleButton();
    createPanel();
    installLightboxHandler();
    installHardPasteDropInterceptors();
    installGlobalPasteAndDropHandlers();
    loadGalleryHistory();
    installGalleryObserver();
    installRoomChangeWatcher();
    requestPageSession();
    installHardOverlayCleanup();
    window.addEventListener("pagehide", revokeLightboxDownloadObjectUrls, { once: true });
  }

  function injectPageBridge() {
    window.addEventListener("message", event => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== PAGE_BRIDGE_SOURCE) return;
      if (event.data.type !== PAGE_BRIDGE_RESPONSE) return;

      const session = event.data.session || {};
      if (session.accessToken) {
        pageSession = session;
        fillSessionFieldsFromPageSession();
      }
    });

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.onload = () => script.remove();

    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function requestPageSession() {
    window.postMessage({
      type: PAGE_BRIDGE_REQUEST
    }, window.location.origin);
  }

  function fillSessionFieldsFromPageSession() {
    if (!pageSession) return;

    const hsInput = document.getElementById("mg-homeserver");
    const tokenInput = document.getElementById("mg-token");

    if (hsInput && pageSession.homeserver) {
      hsInput.value = pageSession.homeserver;
    }

    if (tokenInput && pageSession.accessToken) {
      tokenInput.value = pageSession.accessToken;
    }
  }

  function installHardOverlayCleanup() {
    const cleanup = () => {
      hideDropOverlay();
    };

    document.addEventListener("drop", cleanup, true);
    document.addEventListener("dragend", cleanup, true);
    document.addEventListener("dragexit", cleanup, true);
    document.addEventListener("pointerup", cleanup, true);
    document.addEventListener("pointercancel", cleanup, true);
    document.addEventListener("mouseup", cleanup, true);
    document.addEventListener("mouseleave", cleanup, true);
    window.addEventListener("drop", cleanup, true);
    window.addEventListener("dragend", cleanup, true);
    window.addEventListener("blur", cleanup, true);
    window.addEventListener("focus", cleanup, true);
    document.addEventListener("visibilitychange", cleanup, true);

    setInterval(() => {
      if (!document.body.classList.contains("mg-global-dragover")) {
        const hint = document.getElementById("mg-global-drop-hint");
        if (hint) hint.style.display = "";
      }
    }, 1000);
  }

  function installRoomChangeWatcher() {
    lastKnownRoomKey = getCurrentRoomKey();

    window.addEventListener("hashchange", closePanelOnRoomChange, true);
    window.addEventListener("popstate", closePanelOnRoomChange, true);

    document.addEventListener("click", event => {
      const target = event.target.closest("a, button, [role='button'], [role='treeitem'], [data-room-id], [data-testid]");
      if (!target) return;

      setTimeout(closePanelOnRoomChange, 120);
    }, true);

    setInterval(closePanelOnRoomChange, 1000);
  }

  function getCurrentRoomKey() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function closePanelOnRoomChange() {
    const current = getCurrentRoomKey();

    if (!lastKnownRoomKey) {
      lastKnownRoomKey = current;
      return;
    }

    if (current === lastKnownRoomKey) return;

    lastKnownRoomKey = current;

    const panel = document.getElementById("mg-panel");
    if (panel && !panel.classList.contains("mg-hidden")) {
      closePanelAndClear();
    }
  }

  function createGlobalDropHint() {
    const old = document.getElementById("mg-global-drop-hint");
    if (old) old.remove();

    const hint = document.createElement("div");
    hint.id = "mg-global-drop-hint";
    hint.innerHTML = "<div><strong>Bilder hier loslassen</strong><br><span>werden in die Galerie übernommen</span></div>";
    hint.style.display = "none";
    hint.style.visibility = "hidden";
    hint.style.opacity = "0";
    hint.style.pointerEvents = "none";
    document.body.appendChild(hint);
  }

  function createToggleButton() {
    const button = document.createElement("button");
    button.id = "mg-toggle";
    button.textContent = "+";
    button.title = "Matrix-Galerie senden";
    button.setAttribute("aria-label", "Matrix-Galerie senden");

    document.body.appendChild(button);

    restoreButtonPosition(button);
    makeDraggable(button);
    installButtonResizeGuard(button);

    button.addEventListener("click", event => {
      if (button.dataset.dragMoved === "1") {
        event.preventDefault();
        event.stopPropagation();
        button.dataset.dragMoved = "0";
        return;
      }

      openPanel();
    });
  }

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "mg-panel";
    panel.className = "mg-hidden";

    panel.innerHTML = `
      <button id="mg-close" type="button">×</button>
      <h3>Matrix-Galerie senden</h3>

      <button id="mg-settings-toggle" type="button" title="Verbindungseinstellungen">⚙ Einstellungen</button>

      <div id="mg-settings" class="mg-settings-hidden">
        <label>Homeserver URL</label>
        <input id="mg-homeserver" placeholder="https://matrix.example.org">

        <label>Access Token</label>
        <input id="mg-token" type="password" placeholder="Matrix access token">

        <label>Raum-ID oder Alias</label>
        <input id="mg-room" placeholder="wird aus der URL gelesen, falls möglich">

        <div id="mg-status"></div>
      </div>

      <label>Textnachricht</label>
      <textarea id="mg-text" placeholder="Text vor der Bildergalerie"></textarea>

      <div id="mg-upload-pane">
        <div id="mg-dropzone">
          <div class="mg-dropzone-title">Bilder hier ablegen oder einfügen</div>
          <div class="mg-dropzone-subtitle">Drag & Drop, Ctrl+V oder Datei auswählen</div>
          <input id="mg-files" type="file" accept="image/*" multiple>
        </div>

        <div id="mg-preview"></div>

        <div id="mg-upload-actions">
          <button id="mg-clear" type="button">Leeren</button>
          <button id="mg-send" type="button">Text + Bilder senden</button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById("mg-close").addEventListener("click", closePanelAndClear);

    document.getElementById("mg-settings-toggle").addEventListener("click", () => {
      document.getElementById("mg-settings").classList.toggle("mg-settings-hidden");
    });

    document.getElementById("mg-files").addEventListener("change", event => {
      addFiles(Array.from(event.target.files || []));
      event.target.value = "";
    });

    document.getElementById("mg-clear").addEventListener("click", () => {
      selectedFiles = [];
      renderPreview();
    });

    document.getElementById("mg-send").addEventListener("click", sendGallery);

    installPanelDropHandlers();

    loadConfig();
    setRoomFromCurrentUrl();
  }

  async function openPanel(options = {}) {
    forceDropOverlayClosed();

    const panel = document.getElementById("mg-panel");
    panel.classList.remove("mg-hidden");

    forceDropOverlayClosed();

    setRoomFromCurrentUrl();
    await autofillSessionData(true);

    forceDropOverlayClosed();

    if (options.copyComposerText !== false) {
      const composerText = getMatrixComposerText();
      if (composerText) {
        const textBox = document.getElementById("mg-text");
        if (!textBox.value.trim()) {
          textBox.value = composerText;
        }
      }
    }
  }

  function closePanelAndClear() {
    document.getElementById("mg-panel").classList.add("mg-hidden");
    clearDraft();
  }

  function clearDraft() {
    selectedFiles = [];
    queuedFileFingerprints.clear();
    recentlyAddedFingerprints.clear();
    renderPreview();

    document.getElementById("mg-text").value = "";
    document.getElementById("mg-status").textContent = "";

    const fileInput = document.getElementById("mg-files");
    if (fileInput) fileInput.value = "";
  }

  async function autofillSessionData(forceFreshToken = false) {
    const status = document.getElementById("mg-status");
    if (status && forceFreshToken) {
      status.textContent = "Suche aktiven Matrix-Token ...";
    }

    requestPageSession();
    await sleep(350);

    if (pageSession?.accessToken) {
      fillSessionFieldsFromPageSession();
      if (status && forceFreshToken) status.textContent = "Aktiver Token aus Element-Seitenkontext gefunden.";
    } else {
      const detected = await detectMatrixSession();

      if (detected.homeserver) {
        document.getElementById("mg-homeserver").value = detected.homeserver;
      }

      if (detected.accessToken && (forceFreshToken || !document.getElementById("mg-token").value.trim())) {
        document.getElementById("mg-token").value = detected.accessToken;
      }

      if (status && forceFreshToken) {
        status.textContent = detected.accessToken
          ? "Aktiver Token automatisch aus Browser-Speicher gefunden."
          : "Token nicht im Speicher gefunden. Versuche Element-Einstellungen automatisch auszulesen ...";
      }

      if (!detected.accessToken && forceFreshToken && status) {
        status.textContent = "Token nicht passiv gefunden. Senden läuft bevorzugt über den laufenden Element-Client ohne Token-Auslesen.";
      }
    }

    const room = extractRoomFromUrl();
    if (room) {
      document.getElementById("mg-room").value = room;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function detectMatrixSession() {
    const storageCandidates = collectSessionCandidatesFromWebStorage();
    const indexedDbCandidates = await collectSessionCandidatesFromIndexedDb();
    const candidates = [...storageCandidates, ...indexedDbCandidates];

    const currentUser = detectCurrentUserId();
    const currentHs = detectCurrentHomeserver();

    const scored = candidates.map(candidate => {
      let score = 0;

      if (candidate.accessToken) score += 20;
      if (candidate.homeserver) score += 10;
      if (currentHs && candidate.homeserver && normalizeHomeserver(candidate.homeserver) === normalizeHomeserver(currentHs)) score += 25;
      if (currentUser && candidate.userId && candidate.userId === currentUser) score += 20;
      if (candidate.deviceId) score += 3;
      if (candidate.source.includes("indexedDB")) score += 5;
      if (candidate.source.includes("matrix") || candidate.source.includes("mx_") || candidate.source.includes("crypto")) score += 4;

      return { ...candidate, score };
    }).filter(candidate => candidate.accessToken);

    scored.sort((a, b) => b.score - a.score);

    for (const candidate of scored.slice(0, 8)) {
      const hs = normalizeHomeserver(candidate.homeserver || currentHs || "");
      if (!hs) continue;

      if (await tokenWorks(hs, candidate.accessToken)) {
        return {
          homeserver: hs,
          accessToken: candidate.accessToken
        };
      }
    }

    const best = scored[0] || {};
    return {
      homeserver: normalizeHomeserver(best.homeserver || currentHs || ""),
      accessToken: best.accessToken || ""
    };
  }

  function collectSessionCandidatesFromWebStorage() {
    const candidates = [];
    const stores = [
      { name: "localStorage", store: localStorage },
      { name: "sessionStorage", store: sessionStorage }
    ];

    for (const { name, store } of stores) {
      const directToken = safeGetItem(store, "mx_access_token") || safeGetItem(store, "access_token");
      const directHs = safeGetItem(store, "mx_hs_url") || safeGetItem(store, "mx_homeserver_url") || safeGetItem(store, "mx_hsUrl");
      const directUser = safeGetItem(store, "mx_user_id") || safeGetItem(store, "user_id");
      const directDevice = safeGetItem(store, "mx_device_id") || safeGetItem(store, "device_id");

      if (looksLikeMatrixToken(directToken)) {
        candidates.push({
          source: `${name}:direct`,
          accessToken: directToken.trim(),
          homeserver: directHs,
          userId: directUser,
          deviceId: directDevice
        });
      }

      for (const key of Object.keys(store)) {
        const raw = safeGetItem(store, key);
        if (!raw) continue;

        const extracted = extractSessionsFromValue(raw);
        for (const item of extracted) {
          candidates.push({
            source: `${name}:${key}`,
            accessToken: item.accessToken,
            homeserver: item.homeserver || directHs || "",
            userId: item.userId || directUser || "",
            deviceId: item.deviceId || directDevice || ""
          });
        }
      }
    }

    return candidates;
  }

  async function collectSessionCandidatesFromIndexedDb() {
    const candidates = [];

    if (!indexedDB.databases) {
      return candidates;
    }

    let databases = [];
    try {
      databases = await indexedDB.databases();
    } catch {
      return candidates;
    }

    for (const dbInfo of databases) {
      if (!dbInfo || !dbInfo.name) continue;

      let db = null;

      try {
        db = await openIndexedDb(dbInfo.name);
        const storeNames = Array.from(db.objectStoreNames || []);

        for (const storeName of storeNames) {
          const values = await readSomeIndexedDbValues(db, storeName, 300);

          for (const value of values) {
            const extracted = extractSessionsFromValue(serializeForSearch(value));

            for (const item of extracted) {
              candidates.push({
                source: `indexedDB:${dbInfo.name}:${storeName}`,
                accessToken: item.accessToken,
                homeserver: item.homeserver || "",
                userId: item.userId || "",
                deviceId: item.deviceId || ""
              });
            }
          }
        }
      } catch {
        // Some Element databases or object stores may be unavailable while Element is using them.
      } finally {
        try {
          if (db) db.close();
        } catch {}
      }
    }

    return candidates;
  }

  function openIndexedDb(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
      request.onupgradeneeded = () => reject(new Error("Refusing to upgrade IndexedDB"));
    });
  }

  function readSomeIndexedDbValues(db, storeName, limit) {
    return new Promise(resolve => {
      const values = [];

      try {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.openCursor();

        request.onsuccess = event => {
          const cursor = event.target.result;
          if (!cursor || values.length >= limit) {
            resolve(values);
            return;
          }

          values.push(cursor.value);
          cursor.continue();
        };

        request.onerror = () => resolve(values);
        transaction.onerror = () => resolve(values);
      } catch {
        resolve(values);
      }
    });
  }

  function serializeForSearch(value) {
    if (typeof value === "string") return value;

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  async function tokenWorks(homeserver, token) {
    try {
      const response = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { "Authorization": `Bearer ${token}` }
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  function extractSessionsFromValue(raw) {
    const sessions = [];

    const tokenMatches = String(raw).match(/(?:syt_|yt_)[A-Za-z0-9_.-]+/g) || [];
    for (const token of tokenMatches) {
      sessions.push({ accessToken: token, homeserver: "", userId: "", deviceId: "" });
    }

    try {
      const parsed = JSON.parse(raw);
      walkForSessions(parsed, sessions, {});
    } catch {
      const hs = findHomeserverInString(raw);
      if (hs) {
        for (const session of sessions) {
          session.homeserver = session.homeserver || hs;
        }
      }
    }

    return sessions.filter(item => looksLikeMatrixToken(item.accessToken));
  }

  function walkForSessions(value, sessions, context) {
    if (!value || typeof value !== "object") return;

    const nextContext = {
      homeserver: context.homeserver || "",
      userId: context.userId || "",
      deviceId: context.deviceId || ""
    };

    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested !== "string") continue;

      if (["hs_url", "homeserver", "homeserverUrl", "baseUrl", "base_url", "serverUrl", "homeServer", "homeserver_url"].includes(key) && looksLikeUrl(nested)) {
        nextContext.homeserver = nested;
      }

      if (["user_id", "userId", "mx_user_id"].includes(key) && nested.startsWith("@")) {
        nextContext.userId = nested;
      }

      if (["device_id", "deviceId", "mx_device_id"].includes(key)) {
        nextContext.deviceId = nested;
      }
    }

    const token =
      value.access_token ||
      value.accessToken ||
      value.mx_access_token ||
      value.token ||
      value.accessTokenString;

    if (typeof token === "string" && looksLikeMatrixToken(token)) {
      sessions.push({
        accessToken: token,
        homeserver: nextContext.homeserver,
        userId: nextContext.userId,
        deviceId: nextContext.deviceId
      });
    }

    for (const nested of Object.values(value)) {
      walkForSessions(nested, sessions, nextContext);
    }
  }

  function detectCurrentUserId() {
    const stores = [localStorage, sessionStorage];

    for (const store of stores) {
      const direct = safeGetItem(store, "mx_user_id") || safeGetItem(store, "user_id");
      if (direct && direct.startsWith("@")) return direct;

      for (const key of Object.keys(store)) {
        const raw = safeGetItem(store, key);
        if (!raw) continue;

        const match = raw.match(/@[A-Za-z0-9._=\-/]+:[A-Za-z0-9.\-:]+/);
        if (match) return match[0];
      }
    }

    return "";
  }

  function detectCurrentHomeserver() {
    const stores = [localStorage, sessionStorage];

    for (const store of stores) {
      const direct =
        safeGetItem(store, "mx_hs_url") ||
        safeGetItem(store, "mx_homeserver_url") ||
        safeGetItem(store, "mx_hsUrl");

      if (looksLikeUrl(direct)) return normalizeHomeserver(direct);

      for (const key of Object.keys(store)) {
        const raw = safeGetItem(store, key);
        if (!raw) continue;

        const found = findHomeserverInString(raw);
        if (found) return normalizeHomeserver(found);
      }
    }

    return "";
  }

  function safeGetItem(store, key) {
    try {
      return store.getItem(key);
    } catch {
      return "";
    }
  }

  function looksLikeMatrixToken(value) {
    return typeof value === "string" && /^(syt_|yt_)[A-Za-z0-9_\-.]+$/.test(value.trim());
  }

  function findHomeserverInString(value) {
    if (!value) return "";

    try {
      const parsed = JSON.parse(value);
      return findHomeserverInObject(parsed);
    } catch {
      const match = String(value).match(/https?:\/\/[^"'\s\\]+/);
      return match ? match[0].replace(/\\\//g, "/") : "";
    }
  }

  function findHomeserverInObject(value) {
    if (!value || typeof value !== "object") return "";

    const keys = ["hs_url", "homeserver", "homeserverUrl", "baseUrl", "base_url", "serverUrl", "homeServer", "homeserver_url"];

    for (const key of keys) {
      if (typeof value[key] === "string" && looksLikeUrl(value[key])) {
        return value[key];
      }
    }

    for (const nested of Object.values(value)) {
      const found = findHomeserverInObject(nested);
      if (found) return found;
    }

    return "";
  }

  function looksLikeUrl(value) {
    return typeof value === "string" && /^https?:\/\//.test(value.trim());
  }

  function installHardPasteDropInterceptors() {
    const targets = [window, document, document.documentElement];

    for (const target of targets) {
      if (!target) continue;

      target.addEventListener("paste", hardInterceptPaste, {
        capture: true,
        passive: false
      });

      target.addEventListener("dragenter", hardInterceptDrag, {
        capture: true,
        passive: false
      });

      target.addEventListener("dragover", hardInterceptDrag, {
        capture: true,
        passive: false
      });

      target.addEventListener("drop", hardInterceptDrop, {
        capture: true,
        passive: false
      });

      target.addEventListener("dragend", hardCleanupNativeDropOverlay, {
        capture: true,
        passive: false
      });

      target.addEventListener("dragleave", event => {
        if (!event.relatedTarget) {
          hardCleanupNativeDropOverlay();
        }
      }, {
        capture: true,
        passive: false
      });
    }
  }

  function hardInterceptPaste(event) {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const now = Date.now();

    // Absolute lock: Chromium/Element can deliver the same clipboard payload to
    // window/document/documentElement capture listeners. Only the first handler
    // may process image paste.
    if (now < pasteProcessingLockUntil) {
      return;
    }

    pasteProcessingLockUntil = now + 1200;

    hardCleanupNativeDropOverlay();
    forceDropOverlayClosed();

    processPastedFilesOnce(files).catch(error => {
      console.error("Paste processing failed:", error);
    });
  }

  async function processPastedFilesOnce(files) {
    const uniqueFiles = [];

    for (const file of files) {
      const fingerprint = await makeRobustFileFingerprint(file);

      if (isRecentlySeenClipboardFingerprint(fingerprint)) {
        continue;
      }

      rememberClipboardFingerprint(fingerprint);
      uniqueFiles.push(file);
    }

    if (uniqueFiles.length === 0) return;

    await openPanel();
    addFiles(uniqueFiles);

    hardCleanupNativeDropOverlay();
    forceDropOverlayClosed();
  }

  function isRecentlySeenClipboardFingerprint(fingerprint) {
    const now = Date.now();
    const previous = clipboardContentHashes.get(fingerprint);

    return Boolean(previous && now - previous < 8000);
  }

  function rememberClipboardFingerprint(fingerprint) {
    const now = Date.now();

    clipboardContentHashes.set(fingerprint, now);

    for (const [key, timestamp] of clipboardContentHashes.entries()) {
      if (now - timestamp > 30000) {
        clipboardContentHashes.delete(key);
      }
    }
  }

  async function makeRobustFileFingerprint(file) {
    const metadata = makeSingleFileFingerprint(file);

    try {
      const slice = file.slice(0, Math.min(file.size, 1024 * 1024));
      const buffer = await slice.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const hash = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");

      return `${makeStableClipboardFingerprint(file)}:${hash}`;
    } catch {
      return metadata;
    }
  }

  function hardInterceptDrag(event) {
    if (!hasImageFiles(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    document.body.classList.add("mg-native-drop-blocked");
    document.documentElement.classList.add("mg-native-drop-blocked");

    const panel = document.getElementById("mg-panel");
    if (!panel || panel.classList.contains("mg-hidden")) {
      showDropOverlay();
    } else {
      forceDropOverlayClosed();
    }
  }

  function hardInterceptDrop(event) {
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      hardCleanupNativeDropOverlay();
      forceDropOverlayClosed();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const signature = makeFileListSignature(files);
    const now = Date.now();

    hardCleanupNativeDropOverlay();
    forceDropOverlayClosed();

    if (!(signature && signature === lastDropSignature && now - lastDropAt < 1200)) {
      lastDropSignature = signature;
      lastDropAt = now;

      openPanel();
      addFiles(files);
    }

    hardCleanupNativeDropOverlay();
    forceDropOverlayClosed();

    setTimeout(hardCleanupNativeDropOverlay, 0);
    setTimeout(forceDropOverlayClosed, 0);
    setTimeout(hardCleanupNativeDropOverlay, 150);
    setTimeout(forceDropOverlayClosed, 150);
    setTimeout(hardCleanupNativeDropOverlay, 600);
    setTimeout(forceDropOverlayClosed, 600);
  }

  function hardCleanupNativeDropOverlay() {
    document.body.classList.remove("mg-native-drop-blocked");
    document.documentElement.classList.remove("mg-native-drop-blocked");

    // Do not hide arbitrary Element/Matrix nodes by broad class names. Earlier
    // versions hid large containers whose class names contained "drop/upload",
    // which could make the whole Matrix UI disappear after cancelling a drag.
    // Only our own overlay is removed.
    forceDropOverlayClosed();
  }

  function installGlobalPasteAndDropHandlers() {
    document.addEventListener("paste", event => {
      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;

      // Image paste is handled only by hardInterceptPaste. This listener exists
      // solely to block Element/editor fallback paste behavior.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);

    document.addEventListener("dragenter", event => {
      if (!hasImageFiles(event.dataTransfer)) return;

      globalDragDepth += 1;
      showDropOverlay();
    }, true);

    document.addEventListener("dragover", event => {
      if (!hasImageFiles(event.dataTransfer)) return;

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      showDropOverlay();
    }, true);

    document.addEventListener("dragleave", event => {
      if (!hasImageFiles(event.dataTransfer)) return;

      globalDragDepth = Math.max(0, globalDragDepth - 1);
      if (globalDragDepth === 0) {
        hideDropOverlay();
      }
    }, true);

    document.addEventListener("drop", event => {
      hideDropOverlay();
      setTimeout(forceDropOverlayClosed, 0);
      setTimeout(forceDropOverlayClosed, 150);
      setTimeout(forceDropOverlayClosed, 500);
      setTimeout(forceDropOverlayClosed, 1200);

      const files = filesFromDataTransfer(event.dataTransfer);

      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      forceDropOverlayClosed();
      openPanel();
      addFiles(files);
      forceDropOverlayClosed();
    }, true);

    document.addEventListener("dragend", hideDropOverlay, true);
    document.addEventListener("dragexit", hideDropOverlay, true);
    document.addEventListener("mouseup", hideDropOverlay, true);
    document.addEventListener("pointerup", hideDropOverlay, true);
    document.addEventListener("pointercancel", hideDropOverlay, true);
    document.addEventListener("keyup", event => {
      if (event.key === "Escape") hideDropOverlay();
    }, true);

    window.addEventListener("blur", hideDropOverlay, true);
    window.addEventListener("focus", hideDropOverlay, true);
    window.addEventListener("dragend", hideDropOverlay, true);
    window.addEventListener("drop", hideDropOverlay, true);
  }

  function showDropOverlay() {
    const panel = document.getElementById("mg-panel");

    if (panel && !panel.classList.contains("mg-hidden")) {
      forceDropOverlayClosed();
      return;
    }

    let hint = document.getElementById("mg-global-drop-hint");
    if (!hint) {
      createGlobalDropHint();
      hint = document.getElementById("mg-global-drop-hint");
    }

    document.body.classList.add("mg-global-dragover");

    if (hint) {
      hint.style.display = "flex";
      hint.style.visibility = "visible";
      hint.style.opacity = "1";
      hint.style.pointerEvents = "none";
    }

    if (dragCleanupTimer) {
      clearTimeout(dragCleanupTimer);
    }

    dragCleanupTimer = setTimeout(forceDropOverlayClosed, 2500);
  }

  function hideDropOverlay() {
    forceDropOverlayClosed();
  }

  function forceDropOverlayClosed() {
    globalDragDepth = 0;

    document.body.classList.remove("mg-global-dragover");
    document.documentElement.classList.remove("mg-global-dragover");

    for (const element of Array.from(document.querySelectorAll("#mg-global-drop-hint"))) {
      element.remove();
    }

    if (dragCleanupTimer) {
      clearTimeout(dragCleanupTimer);
      dragCleanupTimer = null;
    }

    // Recreate the hidden hint node later, so no stale visible overlay can survive.
    setTimeout(() => {
      if (!document.getElementById("mg-global-drop-hint")) {
        createGlobalDropHint();
      }
    }, 100);
  }

  function installPanelDropHandlers() {
    const dropzone = document.getElementById("mg-dropzone");

    dropzone.addEventListener("dragenter", event => {
      if (!hasImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      dropzone.classList.add("mg-dragover");
    });

    dropzone.addEventListener("dragover", event => {
      if (!hasImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      dropzone.classList.add("mg-dragover");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("mg-dragover");
    });

    dropzone.addEventListener("drop", event => {
      const files = filesFromDataTransfer(event.dataTransfer);
      hideDropOverlay();

      if (files.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      dropzone.classList.remove("mg-dragover");
      forceDropOverlayClosed();
      openPanel();
      addFiles(files);
      forceDropOverlayClosed();
    });
  }

  function hasImageFiles(dataTransfer) {
    if (!dataTransfer) return false;

    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        return true;
      }
    }

    for (const file of Array.from(dataTransfer.files || [])) {
      if (file.type.startsWith("image/")) {
        return true;
      }
    }

    return false;
  }

  function filesFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return [];

    const files = [];

    for (const item of Array.from(dataTransfer.items || [])) {
      if (item.kind === "file") {
        const file = item.getAsFile();

        if (file && file.type.startsWith("image/")) {
          files.push(file);
        }
      }
    }

    for (const file of Array.from(dataTransfer.files || [])) {
      if (file.type.startsWith("image/")) {
        files.push(file);
      }
    }

    return deduplicateFiles(files);
  }

  function makeSingleFileFingerprint(file) {
    // Clipboard images may arrive with unstable generated names or lastModified
    // values across duplicate paste events. Use size+type as the stable core,
    // with name/lastModified only as extra information.
    return [
      file.size || 0,
      file.type || "",
      file.name || "",
      file.lastModified || 0
    ].join(":");
  }

  function makeStableClipboardFingerprint(file) {
    return [
      file.size || 0,
      file.type || ""
    ].join(":");
  }

  function makeFileListSignature(files) {
    return files
      .map(makeSingleFileFingerprint)
      .sort()
      .join("|");
  }

  function addFiles(files) {
    const now = Date.now();
    const imageFiles = files.filter(file => file.type.startsWith("image/"));
    const accepted = [];

    for (const file of imageFiles) {
      const fingerprint = makeSingleFileFingerprint(file);
      const stableFingerprint = makeStableClipboardFingerprint(file);

      // Prevent the same image from being queued twice even when clipboard
      // duplicate events produce unstable filenames/lastModified values.
      if (queuedFileFingerprints.has(fingerprint) || queuedFileFingerprints.has(stableFingerprint)) {
        continue;
      }

      const recentlyAddedAt =
        recentlyAddedFingerprints.get(fingerprint) ||
        recentlyAddedFingerprints.get(stableFingerprint);

      if (recentlyAddedAt && now - recentlyAddedAt < 10000) {
        continue;
      }

      queuedFileFingerprints.add(fingerprint);
      queuedFileFingerprints.add(stableFingerprint);
      recentlyAddedFingerprints.set(fingerprint, now);
      recentlyAddedFingerprints.set(stableFingerprint, now);
      accepted.push(file);
    }

    // Clean short-term dedupe map.
    for (const [fingerprint, timestamp] of recentlyAddedFingerprints.entries()) {
      if (now - timestamp > 10000) {
        recentlyAddedFingerprints.delete(fingerprint);
      }
    }

    if (accepted.length === 0) {
      return;
    }

    selectedFiles = [
      ...selectedFiles,
      ...accepted
    ];

    renderPreview();
  }

  function removeFileAt(index) {
    const file = selectedFiles[index];

    if (file) {
      queuedFileFingerprints.delete(makeSingleFileFingerprint(file));
      queuedFileFingerprints.delete(makeStableClipboardFingerprint(file));
    }

    selectedFiles.splice(index, 1);
    renderPreview();
  }

  function deduplicateFiles(files) {
    const seen = new Set();

    return files.filter(file => {
      const key = `${file.name}_${file.size}_${file.lastModified}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function getMatrixComposerText() {
    const selectors = [
      '[contenteditable="true"][role="textbox"]',
      '.mx_BasicMessageComposer_input[contenteditable="true"]',
      '.mx_MessageComposer_editor[contenteditable="true"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      if (element.closest("#mg-panel")) continue;

      const text = getEditableText(element).trim();
      if (text) {
        lastComposerElement = element;
        return text;
      }
    }

    return "";
  }

  function getEditableText(element) {
    if ("value" in element) {
      return element.value || "";
    }

    return element.innerText || element.textContent || "";
  }

  async function loadGalleryHistory() {
    try {
      const data = await chrome.storage.local.get(GALLERY_HISTORY_KEY);
      galleryHistory = Array.isArray(data[GALLERY_HISTORY_KEY]) ? data[GALLERY_HISTORY_KEY] : [];
      galleryHistory = galleryHistory
        .filter(item => item && item.id && Array.isArray(item.urls))
        .slice(-200);
    } catch {
      galleryHistory = [];
    }
  }

  async function rememberGallery(gallery) {
    galleryHistory = [
      ...galleryHistory.filter(item => item.id !== gallery.id),
      gallery
    ].slice(-200);

    await chrome.storage.local.set({
      [GALLERY_HISTORY_KEY]: galleryHistory
    });
  }

  function clearOriginalComposerText() {
    if (!lastComposerElement || !document.contains(lastComposerElement)) {
      lastComposerElement = findCurrentComposerElement();
    }

    const element = lastComposerElement;
    if (!element) return;

    if ("value" in element) {
      element.value = "";
      dispatchComposerInputEvents(element);
      return;
    }

    element.focus();
    element.textContent = "";
    element.innerHTML = "";
    dispatchComposerInputEvents(element);
  }

  function findCurrentComposerElement() {
    const selectors = [
      '[contenteditable="true"][role="textbox"]',
      '.mx_BasicMessageComposer_input[contenteditable="true"]',
      '.mx_MessageComposer_editor[contenteditable="true"]',
      'textarea'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element || element.closest("#mg-panel")) continue;
      return element;
    }

    return null;
  }

  function dispatchComposerInputEvents(element) {
    for (const eventName of ["beforeinput", "input", "change", "keyup"]) {
      try {
        element.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
      } catch {}
    }
  }

  async function loadConfig() {
    const config = await chrome.storage.local.get(STORAGE_KEY);
    const value = config[STORAGE_KEY] || {};

    document.getElementById("mg-homeserver").value = value.homeserver || "";
    document.getElementById("mg-token").value = value.token || "";
    document.getElementById("mg-room").value = value.room || "";

    await autofillSessionData(true);
  }

  async function saveConfig(homeserver, token, room) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { homeserver, token, room }
    });
  }

  function setRoomFromCurrentUrl() {
    const room = extractRoomFromUrl();
    if (room) {
      document.getElementById("mg-room").value = room;
    }
  }

  function extractRoomFromUrl() {
    const hash = decodeURIComponent(window.location.hash || "");
    const match = hash.match(/\/room\/([^/?]+)/);
    return match ? match[1] : "";
  }

  function editImageCaption(file) {
    const current = imageCaptions.get(file) || "";
    const next = prompt("Caption für dieses Bild:", current);

    if (next === null) return;

    const trimmed = next.trim();

    if (trimmed) {
      imageCaptions.set(file, trimmed);
    } else {
      imageCaptions.delete(file);
    }

    renderPreview();
  }

  function renderPreview() {
    const preview = document.getElementById("mg-preview");

    for (const url of previewUrls) {
      URL.revokeObjectURL(url);
    }

    previewUrls = [];
    preview.innerHTML = "";

    selectedFiles.forEach((file, index) => {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);

      const item = document.createElement("div");
      item.className = "mg-preview-item";

      const img = document.createElement("img");
      img.src = url;
      img.title = imageCaptions.get(file) ? `${file.name}\n${imageCaptions.get(file)}` : file.name;

      const captionBadge = document.createElement("button");
      captionBadge.className = "mg-caption-image";
      captionBadge.type = "button";
      captionBadge.textContent = imageCaptions.get(file) ? "✎" : "+";
      captionBadge.title = imageCaptions.get(file) ? "Caption bearbeiten" : "Caption hinzufügen";
      captionBadge.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        editImageCaption(file);
      });

      img.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        editImageCaption(file);
      });

      const remove = document.createElement("button");
      remove.className = "mg-remove-image";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Bild aus Warteschlange entfernen";
      remove.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        removeFileAt(index);
      });

      item.appendChild(img);
      item.appendChild(captionBadge);
      item.appendChild(remove);
      preview.appendChild(item);
    });
  }

  async function sendGalleryViaLiveElementClient(room, text, files, galleryId) {
    const requestId = `mg_send_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const fileMeta = [];

    for (const file of files) {
      const info = await getImageInfo(file).catch(() => ({ width: undefined, height: undefined }));

      fileMeta.push({
        name: file.name,
        type: file.type,
        size: file.size,
        width: info.width,
        height: info.height,
        caption: imageCaptions.get(file) || ""
      });
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Live Element MatrixClient send timed out"));
      }, 120000);

      const onMessage = event => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== PAGE_BRIDGE_SOURCE) return;
        if (event.data.requestId !== requestId) return;

        if (event.data.type === PAGE_BRIDGE_SEND_PROGRESS) {
          const status = document.getElementById("mg-status");
          if (status) status.textContent = event.data.message || "Sende über Element ...";
          return;
        }

        if (event.data.type === PAGE_BRIDGE_SEND_RESPONSE) {
          cleanup();

          if (event.data.ok) {
            resolve(event.data.result || {});
          } else {
            reject(new Error(event.data.error || "Live Element MatrixClient send failed"));
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);

      window.postMessage({
        type: PAGE_BRIDGE_SEND_REQUEST,
        requestId,
        room,
        text,
        files,
        fileMeta,
        galleryId
      }, window.location.origin);
    });
  }

  async function sendGallery() {
    const status = document.getElementById("mg-status");

    await autofillSessionData(true);

    const homeserver = normalizeHomeserver(document.getElementById("mg-homeserver").value);
    const token = document.getElementById("mg-token").value.trim();
    let room = document.getElementById("mg-room").value.trim();
    const text = document.getElementById("mg-text").value.trim();

    if (!room) {
      status.textContent = "Bitte Raum-ID oder Alias angeben.";
      return;
    }

    if (!text && selectedFiles.length === 0) {
      status.textContent = "Bitte Text oder mindestens ein Bild angeben.";
      return;
    }

    const galleryId = createGalleryId();
    const galleryCount = selectedFiles.length;

    try {
      status.textContent = "Sende über laufenden Element-Client ...";

      const liveResult = await sendGalleryViaLiveElementClient(room, text, [...selectedFiles], galleryId);

      if (galleryCount > 0) {
        lastSentGallery = {
          id: liveResult.galleryId || galleryId,
          urls: liveResult.uploadedUrls || [],
          names: selectedFiles.map(file => file.name),
          createdAt: Date.now()
        };

        await rememberGallery(lastSentGallery);
      }

      clearOriginalComposerText();
      clearDraft();
      document.getElementById("mg-panel").classList.add("mg-hidden");

      setTimeout(rebuildInlineGalleries, 500);
      setTimeout(rebuildInlineGalleries, 1500);
      setTimeout(rebuildInlineGalleries, 4000);
      setTimeout(hideDropOverlay, 0);
      setTimeout(hideDropOverlay, 300);

      return;
    } catch (liveError) {
      console.warn("Live Element MatrixClient send failed, falling back to token API:", liveError);
      status.textContent = `Element-Client-Senden fehlgeschlagen, versuche Token/API-Fallback: ${liveError.message}`;
    }

    if (!homeserver || !token) {
      status.textContent = "Senden über Element-Client fehlgeschlagen; Token/API-Fallback übersprungen, weil kein Token gesetzt ist.";
      return;
    }

    try {
      status.textContent = "Sende per Matrix API ...";
      await saveConfig(homeserver, token, room);

      if (room.startsWith("#")) {
        room = await resolveRoomAlias(homeserver, token, room);
      }

      if (text) {
        await sendTextMessage(homeserver, token, room, text, galleryId, galleryCount);
      }

      const sentUrls = [];
      const fileNames = selectedFiles.map(file => file.name);

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        status.textContent = `Lade Bild ${i + 1}/${selectedFiles.length} hoch ...`;
        const mxcUrl = await uploadMedia(homeserver, token, file);

        status.textContent = `Sende Bild ${i + 1}/${selectedFiles.length} ...`;
        const info = await getImageInfo(file);

        await sendImageMessage(homeserver, token, room, file, mxcUrl, info, galleryId, i, galleryCount);
        sentUrls.push(mxcUrl);
      }

      if (galleryCount > 0) {
        lastSentGallery = {
          id: galleryId,
          urls: sentUrls,
          names: fileNames,
          createdAt: Date.now()
        };

        await rememberGallery(lastSentGallery);
      }

      clearOriginalComposerText();
      clearDraft();
      document.getElementById("mg-panel").classList.add("mg-hidden");

      setTimeout(rebuildInlineGalleries, 500);
      setTimeout(rebuildInlineGalleries, 1500);
      setTimeout(rebuildInlineGalleries, 4000);
      setTimeout(hideDropOverlay, 0);
      setTimeout(hideDropOverlay, 300);
    } catch (error) {
      console.error(error);

      const retried = await retryWithFreshTokenIfUnauthorized(error);
      if (!retried) {
        status.textContent = `Fehler: ${error.message}`;
      }
    }
  }

  async function retryWithFreshTokenIfUnauthorized(error) {
    if (!String(error.message || "").includes("401")) return false;

    const status = document.getElementById("mg-status");
    status.textContent = "Token wurde abgelehnt. Suche frischen Token ...";

    requestPageSession();
    await sleep(1200);

    if (pageSession?.accessToken) {
      document.getElementById("mg-token").value = pageSession.accessToken;
      if (pageSession.homeserver) document.getElementById("mg-homeserver").value = pageSession.homeserver;
      status.textContent = "Frischer Token aus Element gefunden. Bitte erneut auf Senden klicken.";
      return true;
    }

    const detected = await detectMatrixSession();
    if (detected.accessToken) {
      document.getElementById("mg-token").value = detected.accessToken;
      status.textContent = "Frischer Token gefunden. Bitte erneut auf Senden klicken.";
      return true;
    }

    return false;
  }

  function normalizeHomeserver(value) {
    return value.trim().replace(/\/+$/, "");
  }

  async function resolveRoomAlias(homeserver, token, alias) {
    const url = `${homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`;
    const response = await matrixFetch(url, token, { method: "GET" });
    return response.room_id;
  }

  async function uploadMedia(homeserver, token, file) {
    const endpoints = [
      `${homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`,
      `${homeserver}/_matrix/media/r0/upload?filename=${encodeURIComponent(file.name)}`
    ];

    let lastError = "";

    for (const uploadUrl of endpoints) {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": file.type || "application/octet-stream"
        },
        body: file
      });

      if (response.ok) {
        const data = await response.json();

        if (!data.content_uri) {
          throw new Error("Upload-Antwort enthält keine content_uri.");
        }

        return data.content_uri;
      }

      lastError = `HTTP ${response.status} – ${await response.text()}`;
    }

    throw new Error(`Upload fehlgeschlagen: ${lastError}`);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function makeGalleryHtmlMetadata(galleryId, type, index, count, mxcUrl = "") {
    const payload = {
      id: galleryId,
      type,
      index,
      count,
      url: mxcUrl
    };

    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));

    return `<span data-mg-gallery="${escapeHtml(encoded)}" style="display:none"></span>`;
  }

  async function sendTextMessage(homeserver, token, room, body, galleryId, galleryCount) {
    const txnId = createTxnId();

    const url =
      `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(room)}` +
      `/send/m.room.message/${encodeURIComponent(txnId)}`;

    await matrixFetch(url, token, {
      method: "PUT",
      body: JSON.stringify({
        msgtype: "m.text",
        body,
        format: "org.matrix.custom.html",
        formatted_body: `${escapeHtml(body)}${makeGalleryHtmlMetadata(galleryId, "caption", -1, galleryCount)}`,
        [GALLERY_CONTENT_KEY]: {
          id: galleryId,
          type: "caption",
          count: galleryCount
        }
      })
    });
  }

  async function sendImageMessage(homeserver, token, room, file, mxcUrl, info, galleryId, index, galleryCount) {
    const txnId = createTxnId();

    const url =
      `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(room)}` +
      `/send/m.room.message/${encodeURIComponent(txnId)}`;

    await matrixFetch(url, token, {
      method: "PUT",
      body: JSON.stringify({
        msgtype: "m.image",
        body: file.name,
        url: mxcUrl,
        info: {
          mimetype: file.type || "image/*",
          size: file.size,
          w: info.width,
          h: info.height
        },
        [GALLERY_CONTENT_KEY]: {
          id: galleryId,
          type: "image",
          index,
          count: galleryCount,
          caption: imageCaptions.get(file) || "",
          url: mxcUrl
        }
      })
    });
  }

  async function matrixFetch(url, token, options) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      let message = `Matrix API Fehler: HTTP ${response.status}`;

      try {
        const data = await response.json();
        if (data.error) {
          message += ` – ${data.error}`;
        }
      } catch {}

      throw new Error(message);
    }

    return response.json();
  }

  function createTxnId() {
    return `mg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function createGalleryId() {
    return `mg_gallery_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  async function getImageInfo(file) {
    const url = URL.createObjectURL(file);

    try {
      const img = new Image();

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });

      return {
        width: img.naturalWidth,
        height: img.naturalHeight
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function installGalleryObserver() {
    const observer = new MutationObserver(() => {
      scheduleGalleryRebuild();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-event-id", "title", "aria-label"]
    });

    scheduleGalleryRebuild();
  }

  function scheduleGalleryRebuild() {
    if (galleryRebuildTimer) {
      clearTimeout(galleryRebuildTimer);
    }

    galleryRebuildTimer = setTimeout(rebuildInlineGalleries, 450);
  }

  async function refreshGalleryMetadataFromElementTimeline() {
    const requestId = `mg_gallery_meta_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const room = extractRoomFromUrl();

    if (!room) return;

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, 2000);

      const onMessage = event => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== PAGE_BRIDGE_SOURCE) return;
        if (event.data.type !== PAGE_BRIDGE_GALLERY_RESPONSE) return;
        if (event.data.requestId !== requestId) return;

        cleanup();

        if (Array.isArray(event.data.events)) {
          for (const item of event.data.events) {
            if (item.eventId && item.gallery) {
              galleryEventMetadataByEventId.set(item.eventId, item.gallery);
            }
          }
        }

        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);

      window.postMessage({
        type: PAGE_BRIDGE_GALLERY_REQUEST,
        requestId,
        room
      }, window.location.origin);
    });
  }

  async function rebuildInlineGalleries() {
    galleryRebuildTimer = null;

    await refreshGalleryMetadataFromElementTimeline();

    restorePreviouslyHiddenPlaceholders();

    const explicitGroups = findExplicitGalleryGroups();
    for (const group of explicitGroups) {
      if (group.images.length > 0) {
        buildInlineGallery(group.anchor, group.images, group.id);
      }
    }

    buildStoredGalleryFallbacks();
  }

  function restorePreviouslyHiddenPlaceholders() {
    for (const element of document.querySelectorAll(".mg-gallery-placeholder")) {
      element.classList.remove("mg-gallery-placeholder");
    }

    for (const gallery of document.querySelectorAll(".mg-inline-gallery")) {
      gallery.remove();
    }
  }

  function findExplicitGalleryGroups() {
    const imageMessages = findImageMessages();
    const groups = new Map();

    for (const item of imageMessages) {
      const id = extractGalleryIdFromElement(item.element) || extractGalleryIdFromImage(item.img);

      if (!id) continue;

      if (!groups.has(id)) {
        groups.set(id, {
          id,
          anchor: item.element,
          images: []
        });
      }

      const group = groups.get(id);
      group.images.push(item);

      if (comesBefore(item.element, group.anchor)) {
        group.anchor = item.element;
      }
    }

    return Array.from(groups.values())
      .map(group => ({
        ...group,
        images: group.images.sort((a, b) => {
          const ai = extractGalleryIndex(a.element);
          const bi = extractGalleryIndex(b.element);
          if (ai !== null && bi !== null) return ai - bi;
          return comesBefore(a.element, b.element) ? -1 : 1;
        })
      }))
      .filter(group => group.images.length >= 1);
  }

  function findImageMessages() {
    const containers = Array.from(document.querySelectorAll(CHAT_MESSAGE_SELECTOR));
    const result = [];

    for (const container of containers) {
      if (container.closest("#mg-panel") || container.closest(".mg-lightbox") || container.closest(".mg-inline-gallery")) continue;

      const img = findMainImage(container);
      if (!img) continue;

      const message = findMessageContainer(container);
      if (!message) continue;

      if (result.some(item => item.element === message)) continue;

      result.push({
        element: message,
        img
      });
    }

    return result;
  }

  function findMainImage(element) {
    const images = Array.from(element.querySelectorAll("img")).filter(img => {
      const rect = img.getBoundingClientRect();
      const src = img.currentSrc || img.src || "";
      if (!src) return false;
      if (!isChatMessageImage(img)) return false;
      if (rect.width < 35 || rect.height < 35) return false;

      const lowerSrc = src.toLowerCase();
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      const title = (img.getAttribute("title") || "").toLowerCase();

      // Exclude Element's generic attachment/file icons. These icons caused rows of
      // downloadable files to be treated as image galleries when image rendering failed.
      if (lowerSrc.includes("attachment") || lowerSrc.includes("paperclip") || lowerSrc.includes("file")) return false;
      if (alt.includes("attachment") || alt.includes("file")) return false;
      if (title.includes("attachment") || title.includes("file")) return false;

      return true;
    });

    if (images.length === 0) return null;

    images.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });

    return images[0];
  }

  function isChatMessageImage(img) {
    if (!img || !img.src) return false;
    if (img.closest(NON_CHAT_IMAGE_SELECTOR)) return false;

    const message = img.closest(CHAT_MESSAGE_SELECTOR);
    if (!message) return false;

    if (img.dataset.mgGalleryImage === "1") return true;
    if (img.closest(MESSAGE_IMAGE_BODY_SELECTOR)) return true;
    if (img.dataset.fullSrc || img.dataset.mxcUrl || img.getAttribute("data-full-src") || img.getAttribute("data-mxc-url")) return true;

    const src = img.currentSrc || img.src || "";
    const href = img.closest("a")?.href || "";
    return isMatrixMediaUrl(src) || isMatrixMediaUrl(href);
  }

  function isLightboxImage(img) {
    if (!img || !img.src) return false;
    if (img.closest("#mg-panel") || img.closest(".mg-lightbox")) return false;
    if (img.closest(".mg-inline-gallery")) return true;
    return isChatMessageImage(img);
  }

  function findMessageContainer(element) {
    return element.closest(CHAT_MESSAGE_SELECTOR) ||
           element;
  }

  function extractGalleryIdFromElement(element) {
    const metadata = extractGalleryMetadataFromElement(element);
    if (metadata && metadata.id) return metadata.id;

    const text = element.textContent || "";
    const markerMatch = text.match(/mg-gallery:(mg_gallery_\d+_[a-z0-9]+)|mg_gallery_\d+_[a-z0-9]+/);
    if (markerMatch) return markerMatch[1] || markerMatch[0];

    const html = element.outerHTML || "";
    const htmlMatch = html.match(/mg-gallery:(mg_gallery_\d+_[a-z0-9]+)|mg_gallery_\d+_[a-z0-9]+/);
    if (htmlMatch) return htmlMatch[1] || htmlMatch[0];

    return "";
  }

  function extractGalleryMetadataFromElement(element) {
    const eventId =
      element.getAttribute("data-event-id") ||
      element.closest("[data-event-id]")?.getAttribute("data-event-id");

    if (eventId && galleryEventMetadataByEventId.has(eventId)) {
      return galleryEventMetadataByEventId.get(eventId);
    }

    const html = element.outerHTML || "";
    const htmlMatch = html.match(/data-mg-gallery=["']([^"']+)["']/);
    const encoded = htmlMatch?.[1];

    if (!encoded) return null;

    try {
      return JSON.parse(decodeURIComponent(escape(atob(encoded))));
    } catch {
      return null;
    }
  }

  function extractGalleryIdFromImage(img) {
    const src = img.currentSrc || img.src || "";
    if (!lastSentGallery || Date.now() - lastSentGallery.createdAt > 10 * 60 * 1000) return "";

    for (const url of lastSentGallery.urls) {
      const part = mxcServerPart(url);
      if (part && (src.includes(part) || src.includes(encodeURIComponent(part)))) {
        return lastSentGallery.id;
      }
    }

    return "";
  }

  function extractGalleryIndex(element) {
    const metadata = extractGalleryMetadataFromElement(element);
    if (metadata && Number.isFinite(Number(metadata.index))) {
      return Number(metadata.index);
    }

    const text = element.outerHTML || element.textContent || "";
    const match = text.match(/"index"\s*:\s*(\d+)/) || text.match(/:index:(\d+):/);
    return match ? Number(match[1]) : null;
  }

  function mxcServerPart(mxcUrl) {
    return String(mxcUrl || "").replace(/^mxc:\/\//, "");
  }

  function buildStoredGalleryFallbacks() {
    const galleries = [
      ...(lastSentGallery ? [lastSentGallery] : []),
      ...galleryHistory
    ];

    const unique = new Map();

    for (const gallery of galleries) {
      if (!gallery || !gallery.id || !Array.isArray(gallery.urls)) continue;
      unique.set(gallery.id, gallery);
    }

    for (const gallery of unique.values()) {
      buildStoredGalleryFallback(gallery);
    }
  }

  function buildStoredGalleryFallback(galleryData) {
    const items = findImageMessages().filter(item => {
      const src = item.img.currentSrc || item.img.src || "";
      const alt = item.img.getAttribute("alt") || "";
      const title = item.img.getAttribute("title") || "";
      const text = `${item.element.textContent || ""} ${alt} ${title}`;

      if (text.includes(galleryData.id)) return true;

      return galleryData.urls.some(url => {
        const part = mxcServerPart(url);
        return part && (
          src.includes(part) ||
          src.includes(encodeURIComponent(part)) ||
          text.includes(part) ||
          text.includes(encodeURIComponent(part))
        );
      });
    });

    if (items.length < 1) return;

    const anchor = items.reduce((first, item) => (
      comesBefore(item.element, first.element) ? item : first
    ), items[0]).element;

    buildInlineGallery(anchor, items, galleryData.id);
  }

  function buildInlineGallery(anchor, imageItems, galleryId) {
    const parent = findBestGalleryParent(anchor);
    if (!parent) return;

    const existing = document.querySelector(`.mg-inline-gallery[data-mg-gallery-id="${cssEscape(galleryId)}"]`);
    if (existing) existing.remove();

    const gallery = document.createElement("div");
    gallery.className = "mg-inline-gallery";
    gallery.dataset.mgGalleryId = galleryId;

    for (const item of imageItems) {
      const img = item.img;
      if (!img) continue;

      const wrapper = document.createElement("div");
      wrapper.className = "mg-gallery-item";

      const clone = img.cloneNode(true);
      clone.dataset.mgGalleryImage = "1";
      clone.dataset.fullSrc = img.dataset.fullSrc || img.dataset.mxcUrl || img.getAttribute("data-full-src") || img.getAttribute("data-mxc-url") || img.currentSrc || img.src;

      const sourceEventId = item.element.getAttribute("data-event-id") || item.element.closest("[data-event-id]")?.getAttribute("data-event-id") || "";
      const sourceMeta = sourceEventId ? galleryEventMetadataByEventId.get(sourceEventId) : null;
      if (sourceEventId) clone.dataset.eventId = sourceEventId;
      if (sourceMeta?.url) clone.dataset.mxcUrl = sourceMeta.url;
      if (sourceMeta?.caption) clone.dataset.caption = sourceMeta.caption;

      wrapper.appendChild(clone);
      gallery.appendChild(wrapper);

      item.element.classList.add("mg-gallery-placeholder");
    }

    parent.insertBefore(gallery, anchor);
  }

  function findBestGalleryParent(anchor) {
    return anchor.closest('[role="list"]') || anchor.parentElement;
  }

  function comesBefore(a, b) {
    if (a === b) return false;
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function installLightboxHandler() {
    const maybeOpen = event => {
      const img = event.target.closest("img");
      if (!isLightboxImage(img)) return;

      const gallery = img.closest(".mg-inline-gallery");
      const message = img.closest(CHAT_MESSAGE_SELECTOR);

      let images = [];

      if (gallery) {
        images = Array.from(gallery.querySelectorAll("img")).filter(isLightboxImage);
      } else if (message) {
        images = Array.from(message.querySelectorAll("img")).filter(candidate => {
          const rect = candidate.getBoundingClientRect();
          return isLightboxImage(candidate) &&
            rect.width >= 35 &&
            rect.height >= 35;
        });
      }

      if (images.length === 0) return;

      const index = images.indexOf(img);
      if (index < 0) return;

      event.preventDefault();
      event.stopPropagation();
      hideDropOverlay();

      openLightbox(images, index);
    };

    document.addEventListener("click", maybeOpen, true);

    // Element sometimes consumes the first click immediately after a DOM rewrite.
    // Pointerup catches the same user action after our gallery has just been inserted.
    document.addEventListener("pointerup", event => {
      if (event.button !== 0) return;
      if (!event.target.closest(".mg-inline-gallery img")) return;
      maybeOpen(event);
    }, true);
  }

  function openLightbox(images, startIndex) {
    closeLightbox();

    currentLightboxImages = images;
    currentLightboxIndex = startIndex;
    currentLightboxZoom = 1;
    currentLightboxFitScale = 1;
    currentLightboxPanX = 0;
    currentLightboxPanY = 0;

    const overlay = document.createElement("div");
    overlay.className = "mg-lightbox";
    overlay.id = "mg-lightbox";
    overlay.tabIndex = -1;

    const imageWrap = document.createElement("div");
    imageWrap.className = "mg-lightbox-image-wrap";
    installLightboxPanHandlers(imageWrap);

    const img = document.createElement("img");
    img.id = "mg-lightbox-image";
    imageWrap.appendChild(img);

    const close = document.createElement("button");
    close.className = "mg-lightbox-close";
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", closeLightbox);

    const controls = document.createElement("div");
    controls.className = "mg-lightbox-controls";

    const zoomOut = document.createElement("button");
    zoomOut.className = "mg-lightbox-control";
    zoomOut.type = "button";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom out";
    zoomOut.addEventListener("click", event => {
      event.stopPropagation();
      setLightboxZoom(currentLightboxZoom / 1.25);
    });

    const zoomIn = document.createElement("button");
    zoomIn.className = "mg-lightbox-control";
    zoomIn.type = "button";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom in";
    zoomIn.addEventListener("click", event => {
      event.stopPropagation();
      setLightboxZoom(currentLightboxZoom * 1.25);
    });

    const download = document.createElement("button");
    download.className = "mg-lightbox-control";
    download.type = "button";
    download.textContent = "↓";
    download.title = "Download image";
    download.addEventListener("click", event => {
      event.stopPropagation();
      downloadCurrentLightboxImage();
    });

    controls.appendChild(zoomOut);
    controls.appendChild(zoomIn);
    controls.appendChild(download);

    const counter = document.createElement("div");
    counter.className = "mg-lightbox-counter";
    counter.id = "mg-lightbox-counter";

    const caption = document.createElement("div");
    caption.className = "mg-lightbox-caption";
    caption.textContent = "";

    overlay.appendChild(imageWrap);
    overlay.appendChild(close);
    overlay.appendChild(controls);
    overlay.appendChild(counter);
    overlay.appendChild(caption);

    document.body.appendChild(overlay);
    overlay.focus();

    overlay.addEventListener("click", event => {
      if (event.target === overlay) {
        closeLightbox();
      }
    });

    document.addEventListener("keydown", handleLightboxKey, true);
    updateLightbox();
  }

  function updateLightbox() {
    const image = document.getElementById("mg-lightbox-image");
    const counter = document.getElementById("mg-lightbox-counter");

    if (!image || !counter) return;

    const source = currentLightboxImages[currentLightboxIndex];
    const src = source.dataset.fullSrc || source.currentSrc || source.src;

    image.onload = () => {
      resetLightboxTransform();
      computeLightboxFitScale();
      applyLightboxZoom();
    };

    image.src = src;
    image.style.background = "white";
    counter.textContent = `${currentLightboxIndex + 1} / ${currentLightboxImages.length}`;

    const caption = document.querySelector(".mg-lightbox-caption");
    const imageCaption = source.dataset.caption || "";
    if (caption) {
      const lightboxHint = "← / → switch, + / − zoom, drag to pan, D download, Esc close";
      caption.replaceChildren(
        ...(imageCaption ? [document.createTextNode(imageCaption), document.createElement("br")] : []),
        document.createTextNode(lightboxHint)
      );
    }

    if (image.complete && image.naturalWidth > 0) {
      resetLightboxTransform();
      computeLightboxFitScale();
      applyLightboxZoom();
    }
  }

  function handleLightboxKey(event) {
    if (!document.getElementById("mg-lightbox")) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeLightbox();
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      currentLightboxIndex =
        (currentLightboxIndex + 1) % currentLightboxImages.length;
      resetLightboxTransform();
      updateLightbox();
      scrollSourceImageIntoView();
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      currentLightboxIndex =
        (currentLightboxIndex - 1 + currentLightboxImages.length) %
        currentLightboxImages.length;
      resetLightboxTransform();
      updateLightbox();
      scrollSourceImageIntoView();
      return;
    }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      event.stopPropagation();
      setLightboxZoom(currentLightboxZoom * 1.25);
      return;
    }

    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      event.stopPropagation();
      setLightboxZoom(currentLightboxZoom / 1.25);
      return;
    }

    if (event.key.toLowerCase() === "d") {
      event.preventDefault();
      event.stopPropagation();
      downloadCurrentLightboxImage();
    }
  }

  function installLightboxPanHandlers(imageWrap) {
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    imageWrap.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      if (currentLightboxZoom <= 1) return;

      currentLightboxPanning = true;
      startX = event.clientX;
      startY = event.clientY;
      startPanX = currentLightboxPanX;
      startPanY = currentLightboxPanY;

      imageWrap.classList.add("mg-panning");
      imageWrap.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    imageWrap.addEventListener("pointermove", event => {
      if (!currentLightboxPanning) return;

      currentLightboxPanX = startPanX + (event.clientX - startX);
      currentLightboxPanY = startPanY + (event.clientY - startY);
      clampLightboxPan();
      applyLightboxZoom();

      event.preventDefault();
      event.stopPropagation();
    });

    const stop = event => {
      if (!currentLightboxPanning) return;
      currentLightboxPanning = false;
      imageWrap.classList.remove("mg-panning");
      try {
        imageWrap.releasePointerCapture(event.pointerId);
      } catch {}
    };

    imageWrap.addEventListener("pointerup", stop);
    imageWrap.addEventListener("pointercancel", stop);

    imageWrap.addEventListener("wheel", event => {
      event.preventDefault();
      event.stopPropagation();

      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setLightboxZoom(currentLightboxZoom * factor);
    }, { passive: false });
  }

  function resetLightboxTransform() {
    currentLightboxZoom = 1;
    currentLightboxFitScale = 1;
    currentLightboxPanX = 0;
    currentLightboxPanY = 0;
  }

  function computeLightboxFitScale() {
    const image = document.getElementById("mg-lightbox-image");
    const wrap = document.querySelector(".mg-lightbox-image-wrap");
    if (!image || !wrap || !image.naturalWidth || !image.naturalHeight) {
      currentLightboxFitScale = 1;
      return;
    }

    const padding = 24;
    const availableWidth = Math.max(1, wrap.clientWidth - padding);
    const availableHeight = Math.max(1, wrap.clientHeight - padding);

    currentLightboxFitScale = Math.min(
      1,
      availableWidth / image.naturalWidth,
      availableHeight / image.naturalHeight
    );
  }

  function setLightboxZoom(value) {
    const oldZoom = currentLightboxZoom;
    currentLightboxZoom = Math.max(0.1, Math.min(12, value));

    if (currentLightboxZoom <= 1 || oldZoom <= 1) {
      currentLightboxPanX = 0;
      currentLightboxPanY = 0;
    }

    clampLightboxPan();
    applyLightboxZoom();
  }

  function clampLightboxPan() {
    const image = document.getElementById("mg-lightbox-image");
    const wrap = document.querySelector(".mg-lightbox-image-wrap");
    if (!image || !wrap || !image.naturalWidth || !image.naturalHeight) return;

    const scale = currentLightboxFitScale * currentLightboxZoom;
    const displayedWidth = image.naturalWidth * scale;
    const displayedHeight = image.naturalHeight * scale;

    const maxPanX = Math.max(0, (displayedWidth - wrap.clientWidth) / 2);
    const maxPanY = Math.max(0, (displayedHeight - wrap.clientHeight) / 2);

    currentLightboxPanX = Math.max(-maxPanX, Math.min(maxPanX, currentLightboxPanX));
    currentLightboxPanY = Math.max(-maxPanY, Math.min(maxPanY, currentLightboxPanY));
  }

  function applyLightboxZoom() {
    const image = document.getElementById("mg-lightbox-image");
    if (!image) return;

    clampLightboxPan();

    const totalScale = currentLightboxFitScale * currentLightboxZoom;
    image.style.transform = `translate(${currentLightboxPanX}px, ${currentLightboxPanY}px) scale(${totalScale})`;
  }

  function getCurrentLightboxSource() {
    return currentLightboxImages[currentLightboxIndex] || null;
  }

  async function resolveMediaDownloadFromBridge(source) {
    const requestId = `mg_media_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ downloadUrl: "", mxcUrl: "" });
      }, 2500);

      const onMessage = event => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== PAGE_BRIDGE_SOURCE) return;
        if (event.data.type !== PAGE_BRIDGE_MEDIA_RESPONSE) return;
        if (event.data.requestId !== requestId) return;

        cleanup();
        resolve({
          downloadUrl: event.data.ok ? event.data.downloadUrl || "" : "",
          mxcUrl: event.data.mxcUrl || ""
        });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);

      window.postMessage({
        type: PAGE_BRIDGE_MEDIA_REQUEST,
        requestId,
        eventId: source.dataset.eventId || "",
        mxcUrl: source.dataset.mxcUrl || ""
      }, window.location.origin);
    });
  }

  async function downloadCurrentLightboxImage() {
    const source = getCurrentLightboxSource();
    if (!source) return;

    const filename =
      source.getAttribute("alt") ||
      source.getAttribute("title") ||
      `matrix-image-${currentLightboxIndex + 1}`;

    try {
      const blob = await fetchBestMatrixMediaBlob(source);
      downloadBlob(blob, filename);
    } catch (error) {
      console.error("Download failed:", error);

      try {
        const renderedBlob = await makeRenderedLightboxImageBlob(source);
        if (renderedBlob) {
          downloadBlob(renderedBlob, filename);
          return;
        }
      } catch (renderError) {
        console.error("Rendered image download fallback failed:", renderError);
      }

      const fallback = source.dataset.fullSrc || source.currentSrc || source.src;
      if (isBrowserDownloadUrl(fallback) && !isMatrixMediaUrl(fallback)) {
        downloadUrl(fallback, filename);
      }
    }
  }

  function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    lightboxDownloadObjectUrls.add(objectUrl);

    downloadUrl(objectUrl, filenameForBlob(filename, blob));

    setTimeout(() => {
      revokeLightboxDownloadObjectUrl(objectUrl);
    }, 5 * 60 * 1000);
  }

  function downloadUrl(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = sanitizeFilename(filename) || "matrix-image";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function makeRenderedLightboxImageBlob(source) {
    const image = [document.getElementById("mg-lightbox-image"), source]
      .find(candidate => candidate?.complete && candidate.naturalWidth && candidate.naturalHeight);
    if (!image) return null;

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext("2d");
    if (!context) return null;

    context.drawImage(image, 0, 0);

    return new Promise(resolve => {
      canvas.toBlob(blob => resolve(blob), "image/png");
    });
  }

  function isBrowserDownloadUrl(url) {
    return /^(https?:|blob:|data:)/i.test(String(url || ""));
  }

  function isMatrixMediaUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.pathname.includes("/_matrix/") && parsed.pathname.includes("/media/");
    } catch {
      return false;
    }
  }

  function filenameForBlob(filename, blob) {
    const safeName = sanitizeFilename(filename) || "matrix-image";
    if (/\.[A-Za-z0-9]{1,8}$/.test(safeName)) return safeName;

    const extension = extensionForMimeType(blob?.type);
    return extension ? `${safeName}.${extension}` : safeName;
  }

  function extensionForMimeType(type) {
    const normalized = String(type || "").split(";")[0].trim().toLowerCase();
    const map = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/avif": "avif",
      "image/bmp": "bmp",
      "image/svg+xml": "svg"
    };

    return map[normalized] || "";
  }

  function revokeLightboxDownloadObjectUrl(objectUrl) {
    if (!lightboxDownloadObjectUrls.delete(objectUrl)) return;

    try {
      URL.revokeObjectURL(objectUrl);
    } catch {}
  }

  function revokeLightboxDownloadObjectUrls() {
    for (const objectUrl of Array.from(lightboxDownloadObjectUrls)) {
      revokeLightboxDownloadObjectUrl(objectUrl);
    }
  }

  async function fetchBestMatrixMediaBlob(source) {
    const bridgeMedia = await resolveMediaDownloadFromBridge(source);
    if (bridgeMedia.mxcUrl && !source.dataset.mxcUrl) {
      source.dataset.mxcUrl = bridgeMedia.mxcUrl;
    }

    const candidates = [
      ...(bridgeMedia.downloadUrl ? [bridgeMedia.downloadUrl] : []),
      ...buildMatrixMediaDownloadCandidates(source)
    ];

    let lastError = null;

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: buildDownloadHeaders()
        });

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} for ${url}`);
          continue;
        }

        return await response.blob();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("No downloadable media URL found");
  }

  function buildDownloadHeaders() {
    const token = document.getElementById("mg-token")?.value?.trim() || pageSession?.accessToken || "";
    return token ? { "Authorization": `Bearer ${token}` } : {};
  }

  function buildMatrixMediaDownloadCandidates(source) {
    const rawUrls = [
      source.dataset.mxcUrl,
      source.dataset.fullSrc,
      source.getAttribute("data-full-src"),
      source.getAttribute("data-mxc-url"),
      source.currentSrc,
      source.src
    ].filter(Boolean);

    const candidates = [];

    for (const rawUrl of rawUrls) {
      addDownloadCandidatesFromUrl(rawUrl, candidates);
    }

    // Try to recover MXC URL from stored galleries for cloned thumbnails.
    const src = source.currentSrc || source.src || "";
    for (const gallery of [
      ...(lastSentGallery ? [lastSentGallery] : []),
      ...galleryHistory
    ]) {
      if (!gallery || !Array.isArray(gallery.urls)) continue;

      for (const mxcUrl of gallery.urls) {
        const part = mxcServerPart(mxcUrl);
        if (part && (src.includes(part) || src.includes(encodeURIComponent(part)))) {
          addDownloadCandidatesFromUrl(mxcUrl, candidates);
        }
      }
    }

    // Preserve order, remove duplicates.
    return Array.from(new Set(candidates));
  }

  function addDownloadCandidatesFromUrl(rawUrl, candidates) {
    if (!rawUrl) return;

    const homeserver =
      pageSession?.homeserver ||
      document.getElementById("mg-homeserver")?.value?.trim() ||
      window.location.origin;

    if (rawUrl.startsWith("mxc://")) {
      const m = rawUrl.match(/^mxc:\/\/([^\/]+)\/(.+)$/);
      if (!m) return;

      const base = homeserver.replace(/\/+$/, "");
      candidates.push(`${base}/_matrix/client/v1/media/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`);
      candidates.push(`${base}/_matrix/media/v3/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`);
      candidates.push(`${base}/_matrix/media/r0/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`);
      return;
    }

    const mediaMatch = rawUrl.match(
      /^(https?:\/\/[^\/]+)\/_matrix\/(?:client\/v1\/media|media\/(?:r0|v3))\/(?:thumbnail|download)\/([^\/\?#]+)\/([^\/\?#]+)/
    );

    if (mediaMatch) {
      const origin = mediaMatch[1];
      const server = decodeURIComponent(mediaMatch[2]);
      const mediaId = decodeURIComponent(mediaMatch[3]);

      candidates.push(`${origin}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`);
      candidates.push(`${origin}/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`);
      candidates.push(`${origin}/_matrix/media/r0/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`);
      return;
    }

    candidates.push(rawUrl);
  }

  function sanitizeFilename(name) {
    return String(name || "matrix-image")
      .replace(/[\\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function scrollSourceImageIntoView() {
    const source = currentLightboxImages[currentLightboxIndex];
    if (!source) return;

    source.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  function closeLightbox() {
    const old = document.getElementById("mg-lightbox");
    if (old) old.remove();

    document.removeEventListener("keydown", handleLightboxKey, true);
    currentLightboxImages = [];
    currentLightboxIndex = 0;
    currentLightboxZoom = 1;
    currentLightboxPanX = 0;
    currentLightboxPanY = 0;
    currentLightboxPanning = false;
  }

  function makeDraggable(element) {
    let dragging = false;
    let pointerId = null;
    let startPointerX = 0;
    let startPointerY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    element.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;

      dragging = true;
      pointerId = event.pointerId;
      moved = false;
      element.dataset.dragMoved = "0";

      startPointerX = event.clientX;
      startPointerY = event.clientY;

      const rect = element.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      element.style.left = `${startLeft}px`;
      element.style.top = `${startTop}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";

      element.setPointerCapture(pointerId);
      document.body.style.userSelect = "none";

      event.preventDefault();
    });

    element.addEventListener("pointermove", event => {
      if (!dragging || event.pointerId !== pointerId) return;

      const dx = event.clientX - startPointerX;
      const dy = event.clientY - startPointerY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved = true;
        element.dataset.dragMoved = "1";
      }

      let left = startLeft + dx;
      let top = startTop + dy;

      const margin = 8;
      const maxLeft = window.innerWidth - element.offsetWidth - margin;
      const maxTop = window.innerHeight - element.offsetHeight - margin;

      left = Math.max(margin, Math.min(left, maxLeft));
      top = Math.max(margin, Math.min(top, maxTop));

      element.style.left = `${left}px`;
      element.style.top = `${top}px`;

      saveButtonPosition(left, top);
    });

    element.addEventListener("pointerup", event => {
      if (!dragging || event.pointerId !== pointerId) return;

      dragging = false;

      try {
        element.releasePointerCapture(pointerId);
      } catch {}

      pointerId = null;
      document.body.style.userSelect = "";

      if (!moved) {
        element.dataset.dragMoved = "0";
      }

      clampToggleButtonToViewport(element);
      saveCurrentButtonPosition(element);
    });

    element.addEventListener("pointercancel", () => {
      dragging = false;
      pointerId = null;
      document.body.style.userSelect = "";
    });
  }

  async function saveButtonPosition(left, top) {
    const right = Math.max(0, window.innerWidth - left - getToggleButtonWidth());
    const bottom = Math.max(0, window.innerHeight - top - getToggleButtonHeight());

    await chrome.storage.local.set({
      [BUTTON_POSITION_KEY]: { right, bottom }
    });
  }

  async function restoreButtonPosition(button) {
    const data = await chrome.storage.local.get(BUTTON_POSITION_KEY);
    const pos = data[BUTTON_POSITION_KEY] || {};

    const right = Number.isFinite(pos.right) ? pos.right : 18;
    const bottom = Number.isFinite(pos.bottom) ? pos.bottom : 18;

    button.style.left = "auto";
    button.style.top = "auto";
    button.style.right = `${right}px`;
    button.style.bottom = `${bottom}px`;

    requestAnimationFrame(() => clampToggleButtonToViewport(button));
  }

  function installButtonResizeGuard(button) {
    window.addEventListener("resize", () => {
      clampToggleButtonToViewport(button);
      saveCurrentButtonPosition(button);
    }, { passive: true });

    window.addEventListener("orientationchange", () => {
      setTimeout(() => {
        clampToggleButtonToViewport(button);
        saveCurrentButtonPosition(button);
      }, 150);
    }, { passive: true });
  }

  function clampToggleButtonToViewport(button) {
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const margin = 8;

    let left = rect.left;
    let top = rect.top;

    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    left = Math.max(margin, Math.min(left, maxLeft));
    top = Math.max(margin, Math.min(top, maxTop));

    const right = Math.max(margin, window.innerWidth - left - rect.width);
    const bottom = Math.max(margin, window.innerHeight - top - rect.height);

    button.style.left = "auto";
    button.style.top = "auto";
    button.style.right = `${right}px`;
    button.style.bottom = `${bottom}px`;
  }

  async function saveCurrentButtonPosition(button) {
    const rect = button.getBoundingClientRect();

    const right = Math.max(0, window.innerWidth - rect.left - rect.width);
    const bottom = Math.max(0, window.innerHeight - rect.top - rect.height);

    await chrome.storage.local.set({
      [BUTTON_POSITION_KEY]: { right, bottom }
    });
  }

  function getToggleButtonWidth() {
    const button = document.getElementById("mg-toggle");
    return button ? button.offsetWidth : 0;
  }

  function getToggleButtonHeight() {
    const button = document.getElementById("mg-toggle");
    return button ? button.offsetHeight : 0;
  }

})();
