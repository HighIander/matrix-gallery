(() => {
  "use strict";

  const SOURCE = "matrix-gallery-sender-page-bridge";
  const RESPONSE = "matrix-gallery-sender-session-response";
  const REQUEST = "matrix-gallery-sender-session-request";
  const SEND_REQUEST = "matrix-gallery-sender-send-request";
  const SEND_RESPONSE = "matrix-gallery-sender-send-response";
  const SEND_PROGRESS = "matrix-gallery-sender-send-progress";
  const GALLERY_REQUEST = "matrix-gallery-sender-gallery-request";
  const GALLERY_RESPONSE = "matrix-gallery-sender-gallery-response";
  const MEDIA_REQUEST = "matrix-gallery-sender-media-request";
  const MEDIA_RESPONSE = "matrix-gallery-sender-media-response";

  let lastSession = null;
  let installed = false;

  function cleanUrl(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\/+$/, "");
  }

  function looksLikeToken(value) {
    return typeof value === "string" && /^(syt_|yt_)[A-Za-z0-9_.-]+$/.test(value.trim());
  }

  function inferHomeserverFromUrl(url) {
    if (typeof url !== "string") return "";

    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.pathname.includes("/_matrix/")) {
        return parsed.origin;
      }
    } catch {}

    return "";
  }

  function postSession(session, reason) {
    if (!session || !looksLikeToken(session.accessToken)) return;

    lastSession = {
      accessToken: session.accessToken.trim(),
      homeserver: cleanUrl(session.homeserver || lastSession?.homeserver || ""),
      userId: session.userId || lastSession?.userId || "",
      deviceId: session.deviceId || lastSession?.deviceId || ""
    };

    window.postMessage({
      source: SOURCE,
      type: RESPONSE,
      reason,
      session: lastSession
    }, window.location.origin);
  }

  function extractBearer(value) {
    if (!value || typeof value !== "string") return "";

    const bearer = value.match(/Bearer\s+((?:syt_|yt_)[A-Za-z0-9_.-]+)/i);
    if (bearer) return bearer[1];

    const raw = value.match(/(?:syt_|yt_)[A-Za-z0-9_.-]+/);
    return raw ? raw[0] : "";
  }

  function headersToObject(headers) {
    const result = {};

    try {
      if (!headers) return result;

      if (headers instanceof Headers) {
        headers.forEach((value, key) => {
          result[key.toLowerCase()] = value;
        });
        return result;
      }

      if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
          result[String(key).toLowerCase()] = String(value);
        }
        return result;
      }

      if (typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) {
          result[String(key).toLowerCase()] = String(value);
        }
      }
    } catch {}

    return result;
  }

  function captureFromHeaders(headers, url, reason) {
    const obj = headersToObject(headers);
    const token =
      extractBearer(obj.authorization) ||
      extractBearer(obj.Authorization);

    if (!token) return;

    postSession({
      accessToken: token,
      homeserver: inferHomeserverFromUrl(url)
    }, reason);
  }

  function captureFromUrl(url, reason) {
    if (typeof url !== "string") return;

    const tokenMatch = url.match(/[?&]access_token=((?:syt_|yt_)[A-Za-z0-9_.-]+)/);
    if (!tokenMatch) return;

    postSession({
      accessToken: decodeURIComponent(tokenMatch[1]),
      homeserver: inferHomeserverFromUrl(url)
    }, reason);
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__mgTokenHooked) return;

    const originalFetch = window.fetch;

    const wrappedFetch = function(input, init = {}) {
      try {
        const url =
          typeof input === "string"
            ? input
            : input?.url || "";

        captureFromUrl(url, "fetch-url");

        if (input instanceof Request) {
          captureFromHeaders(input.headers, input.url, "fetch-request-headers");
        }

        captureFromHeaders(init.headers, url, "fetch-init-headers");
      } catch {}

      return originalFetch.apply(this, arguments).then(response => {
        try {
          const url = response?.url || (typeof input === "string" ? input : input?.url || "");
          if (url && url.includes("/_matrix/")) {
            const hs = inferHomeserverFromUrl(url);
            if (hs && lastSession?.accessToken && !lastSession.homeserver) {
              postSession({ ...lastSession, homeserver: hs }, "fetch-response-homeserver");
            }
          }
        } catch {}

        return response;
      });
    };

    wrappedFetch.__mgTokenHooked = true;
    window.fetch = wrappedFetch;
  }

  function installXhrHook() {
    if (!window.XMLHttpRequest || window.XMLHttpRequest.prototype.__mgTokenHooked) return;

    const proto = window.XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSetRequestHeader = proto.setRequestHeader;
    const originalSend = proto.send;

    proto.open = function(method, url) {
      try {
        this.__mgUrl = String(url || "");
        captureFromUrl(this.__mgUrl, "xhr-url");
      } catch {}

      return originalOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function(name, value) {
      try {
        if (String(name).toLowerCase() === "authorization") {
          captureFromHeaders({ authorization: value }, this.__mgUrl || "", "xhr-authorization-header");
        }
      } catch {}

      return originalSetRequestHeader.apply(this, arguments);
    };

    proto.send = function() {
      try {
        const url = this.__mgUrl || "";
        if (url.includes("/_matrix/") && lastSession?.accessToken && !lastSession.homeserver) {
          postSession({ ...lastSession, homeserver: inferHomeserverFromUrl(url) }, "xhr-send-homeserver");
        }
      } catch {}

      return originalSend.apply(this, arguments);
    };

    proto.__mgTokenHooked = true;
  }

  function safeCall(obj, method) {
    try {
      if (obj && typeof obj[method] === "function") return obj[method]();
    } catch {}
    return undefined;
  }

  function sessionFromClient(client) {
    if (!client || typeof client !== "object") return null;

    const accessToken =
      safeCall(client, "getAccessToken") ||
      client.accessToken ||
      client._accessToken ||
      client.opts?.accessToken ||
      client.clientOpts?.accessToken ||
      client.credentials?.accessToken;

    if (!looksLikeToken(accessToken)) return null;

    const homeserver =
      safeCall(client, "getHomeserverUrl") ||
      client.baseUrl ||
      client.opts?.baseUrl ||
      client.clientOpts?.baseUrl ||
      client.store?.getHomeserverUrl?.();

    const userId =
      safeCall(client, "getUserId") ||
      client.credentials?.userId ||
      client.credentials?.user_id ||
      client.userId;

    const deviceId =
      safeCall(client, "getDeviceId") ||
      client.deviceId ||
      client.credentials?.deviceId ||
      client.credentials?.device_id;

    return {
      accessToken,
      homeserver: cleanUrl(homeserver || ""),
      userId: userId || "",
      deviceId: deviceId || ""
    };
  }

  function findFromKnownGlobals() {
    const paths = [
      ["mxMatrixClientPeg"],
      ["MatrixClientPeg"],
      ["matrixClientPeg"],
      ["mxReactSdk", "MatrixClientPeg"],
      ["mxReactSdk", "default", "MatrixClientPeg"]
    ];

    for (const path of paths) {
      let obj = window;

      for (const part of path) obj = obj?.[part];

      if (!obj) continue;

      const client =
        safeCall(obj, "get") ||
        obj.matrixClient ||
        obj.client ||
        obj._matrixClient ||
        obj;

      const session = sessionFromClient(client);
      if (session) return session;
    }

    for (const key of Object.keys(window)) {
      if (!/matrix|client|peg|mx/i.test(key)) continue;

      try {
        const value = window[key];

        const session =
          sessionFromClient(value) ||
          sessionFromClient(value?.get?.()) ||
          sessionFromClient(value?.client) ||
          sessionFromClient(value?.matrixClient) ||
          sessionFromClient(value?._matrixClient);

        if (session) return session;
      } catch {}
    }

    return null;
  }

  function walkObjectForClient(root, maxNodes = 7000) {
    const seen = new WeakSet();
    const queue = [root];
    let nodes = 0;

    while (queue.length && nodes < maxNodes) {
      const value = queue.shift();
      nodes += 1;

      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      const session = sessionFromClient(value);
      if (session) return session;

      let children = [];
      try {
        children = Object.values(value).slice(0, 120);
      } catch {
        continue;
      }

      for (const child of children) {
        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push(child);
        }
      }
    }

    return null;
  }

  function findFromWebpack() {
    const chunkKeys = Object.keys(window).filter(key => key.startsWith("webpackChunk"));
    const modules = [];

    for (const chunkKey of chunkKeys) {
      const chunk = window[chunkKey];
      if (!Array.isArray(chunk)) continue;

      try {
        chunk.push([
          [Math.random()],
          {},
          req => {
            try {
              if (req?.c) {
                for (const mod of Object.values(req.c)) {
                  if (mod?.exports) modules.push(mod.exports);
                }
              }
            } catch {}
          }
        ]);
      } catch {}
    }

    for (const exp of modules) {
      const session =
        sessionFromClient(exp) ||
        sessionFromClient(exp?.default) ||
        sessionFromClient(exp?.MatrixClientPeg) ||
        sessionFromClient(exp?.default?.MatrixClientPeg);

      if (session) return session;

      const walked = walkObjectForClient(exp, 900);
      if (walked) return walked;
    }

    return null;
  }

  function findSession() {
    return findFromKnownGlobals() || findFromWebpack() || null;
  }

  function findClient() {
    const known = findClientFromKnownGlobals();
    if (known) return known;

    const fromWebpack = findClientFromWebpack();
    if (fromWebpack) return fromWebpack;

    return null;
  }

  function findClientFromKnownGlobals() {
    const paths = [
      ["mxMatrixClientPeg"],
      ["MatrixClientPeg"],
      ["matrixClientPeg"],
      ["mxReactSdk", "MatrixClientPeg"],
      ["mxReactSdk", "default", "MatrixClientPeg"]
    ];

    for (const path of paths) {
      let obj = window;
      for (const part of path) obj = obj?.[part];
      if (!obj) continue;

      const client =
        safeCall(obj, "get") ||
        obj.matrixClient ||
        obj.client ||
        obj._matrixClient ||
        obj;

      if (isUsableMatrixClient(client)) return client;
    }

    for (const key of Object.keys(window)) {
      if (!/matrix|client|peg|mx/i.test(key)) continue;

      try {
        const value = window[key];

        const client =
          (isUsableMatrixClient(value) && value) ||
          (isUsableMatrixClient(value?.get?.()) && value.get()) ||
          (isUsableMatrixClient(value?.client) && value.client) ||
          (isUsableMatrixClient(value?.matrixClient) && value.matrixClient) ||
          (isUsableMatrixClient(value?._matrixClient) && value._matrixClient);

        if (client) return client;
      } catch {}
    }

    return null;
  }

  function findClientFromWebpack() {
    const chunkKeys = Object.keys(window).filter(key => key.startsWith("webpackChunk"));
    const modules = [];

    for (const chunkKey of chunkKeys) {
      const chunk = window[chunkKey];
      if (!Array.isArray(chunk)) continue;

      try {
        chunk.push([
          [Math.random()],
          {},
          req => {
            try {
              if (req?.c) {
                for (const mod of Object.values(req.c)) {
                  if (mod?.exports) modules.push(mod.exports);
                }
              }
            } catch {}
          }
        ]);
      } catch {}
    }

    for (const exp of modules) {
      const direct =
        (isUsableMatrixClient(exp) && exp) ||
        (isUsableMatrixClient(exp?.default) && exp.default) ||
        (isUsableMatrixClient(exp?.MatrixClientPeg?.get?.()) && exp.MatrixClientPeg.get()) ||
        (isUsableMatrixClient(exp?.default?.MatrixClientPeg?.get?.()) && exp.default.MatrixClientPeg.get());

      if (direct) return direct;

      const walked = walkObjectForUsableClient(exp, 2500);
      if (walked) return walked;
    }

    return null;
  }

  function walkObjectForUsableClient(root, maxNodes = 2500) {
    const seen = new WeakSet();
    const queue = [root];
    let nodes = 0;

    while (queue.length && nodes < maxNodes) {
      const value = queue.shift();
      nodes += 1;

      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (isUsableMatrixClient(value)) return value;

      let children = [];
      try {
        children = Object.values(value).slice(0, 80);
      } catch {
        continue;
      }

      for (const child of children) {
        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push(child);
        }
      }
    }

    return null;
  }

  function isUsableMatrixClient(client) {
    return Boolean(
      client &&
      typeof client === "object" &&
      typeof client.sendMessage === "function" &&
      (
        typeof client.uploadContent === "function" ||
        client.http ||
        client._http
      )
    );
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

  async function sendGalleryViaClient(payload) {
    const client = findClient();

    if (!client) {
      throw new Error("No live MatrixClient found in Element page context");
    }

    let roomId = payload.room;

    if (roomId && roomId.startsWith("#") && typeof client.getRoomIdForAlias === "function") {
      const aliasResult = await client.getRoomIdForAlias(roomId);
      roomId = aliasResult?.room_id || aliasResult?.roomId || roomId;
    }

    if (!roomId) {
      throw new Error("Missing room id");
    }

    const galleryId = payload.galleryId || `mg_gallery_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const count = Array.isArray(payload.files) ? payload.files.length : 0;
    const uploadedUrls = [];

    if (payload.text) {
      await client.sendMessage(roomId, {
        msgtype: "m.text",
        body: payload.text,
        format: "org.matrix.custom.html",
        formatted_body: `${escapeHtml(payload.text)}${makeGalleryHtmlMetadata(galleryId, "caption", -1, count)}`,
        "de.tkluge.gallery": {
          id: galleryId,
          type: "caption",
          count
        }
      });
    }

    for (let i = 0; i < count; i++) {
      const file = payload.files[i];
      const meta = payload.fileMeta?.[i] || {};

      postSendProgress(payload.requestId, `Lade Bild ${i + 1}/${count} über Element hoch ...`);

      const mxcUrl = await uploadContentViaClient(client, file, meta);
      uploadedUrls.push(mxcUrl);

      postSendProgress(payload.requestId, `Sende Bild ${i + 1}/${count} ...`);

      await client.sendMessage(roomId, {
        msgtype: "m.image",
        body: meta.name || file.name || `image-${i + 1}`,
        url: mxcUrl,
        info: {
          mimetype: meta.type || file.type || "image/*",
          size: meta.size || file.size || 0,
          w: meta.width || undefined,
          h: meta.height || undefined
        },
        "de.tkluge.gallery": {
          id: galleryId,
          type: "image",
          index: i,
          count,
          caption: meta.caption || "",
          url: mxcUrl
        }
      });
    }

    return {
      galleryId,
      uploadedUrls
    };
  }

  async function uploadContentViaClient(client, file, meta) {
    if (typeof client.uploadContent === "function") {
      const result = await client.uploadContent(file, {
        name: meta.name || file.name,
        type: meta.type || file.type || "application/octet-stream",
        rawResponse: false
      });

      if (typeof result === "string") return result;
      if (result?.content_uri) return result.content_uri;
      if (result?.contentUri) return result.contentUri;
    }

    const http = client.http || client._http;
    if (http && typeof http.authedRequest === "function") {
      const result = await http.authedRequest(
        undefined,
        "POST",
        "/_matrix/media/v3/upload",
        { filename: meta.name || file.name },
        file,
        {
          headers: {
            "Content-Type": meta.type || file.type || "application/octet-stream"
          }
        }
      );

      if (typeof result === "string") return result;
      if (result?.content_uri) return result.content_uri;
      if (result?.contentUri) return result.contentUri;
    }

    throw new Error("MatrixClient has no usable upload method");
  }

  function postSendProgress(requestId, message) {
    window.postMessage({
      source: SOURCE,
      type: SEND_PROGRESS,
      requestId,
      message
    }, window.location.origin);
  }

  function poll() {
    installFetchHook();
    installXhrHook();

    const session = findSession();
    if (session) postSession(session, "poll-client");
  }

  function getRoomByIdOrAlias(client, roomIdOrAlias) {
    if (!client || !roomIdOrAlias) return null;

    let room = null;

    try {
      room = client.getRoom?.(roomIdOrAlias);
    } catch {}

    if (room) return room;

    try {
      const rooms = client.getRooms?.() || [];
      room = rooms.find(candidate =>
        candidate?.roomId === roomIdOrAlias ||
        candidate?.getCanonicalAlias?.() === roomIdOrAlias ||
        candidate?.getAltAliases?.()?.includes?.(roomIdOrAlias)
      );
    } catch {}

    return room || null;
  }

  function collectGalleryEvents(roomIdOrAlias) {
    const client = findClient();
    if (!client) return [];

    const room = getRoomByIdOrAlias(client, roomIdOrAlias);
    if (!room) return [];

    const events = [];

    try {
      const liveTimeline = room.getLiveTimeline?.();
      if (liveTimeline?.getEvents) {
        events.push(...liveTimeline.getEvents());
      }
    } catch {}

    try {
      if (Array.isArray(room.timeline)) {
        events.push(...room.timeline);
      }
    } catch {}

    try {
      const timelines = room.getLiveTimelineSet?.().getTimelines?.() || [];
      for (const timeline of timelines) {
        if (timeline?.getEvents) {
          events.push(...timeline.getEvents());
        }
      }
    } catch {}

    const seen = new Set();
    const result = [];

    for (const event of events) {
      try {
        const eventId = event.getId?.() || event.event?.event_id;
        if (!eventId || seen.has(eventId)) continue;
        seen.add(eventId);

        const content = event.getContent?.() || event.event?.content || {};
        const gallery = content["de.tkluge.gallery"];

        if (!gallery || !gallery.id) continue;

        result.push({
          eventId,
          gallery
        });
      } catch {}
    }

    return result;
  }

  function makeContentDownloadUrl(mxcUrl) {
    const client = findClient();

    if (!mxcUrl || !client) return "";

    try {
      if (client.mxcUrlToHttp) {
        return client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, true, true) ||
               client.mxcUrlToHttp(mxcUrl);
      }
    } catch {}

    try {
      const baseUrl =
        safeCall(client, "getHomeserverUrl") ||
        client.baseUrl ||
        client.opts?.baseUrl ||
        client.clientOpts?.baseUrl ||
        window.location.origin;

      const match = String(mxcUrl).match(/^mxc:\/\/([^/]+)\/(.+)$/);
      if (!match) return "";

      return `${String(baseUrl).replace(/\/+$/, "")}/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
    } catch {}

    return "";
  }

  function findMxcForEventId(eventId) {
    const client = findClient();
    if (!client || !eventId) return "";

    try {
      const rooms = client.getRooms?.() || [];
      for (const room of rooms) {
        const events = [];

        try {
          const liveTimeline = room.getLiveTimeline?.();
          if (liveTimeline?.getEvents) events.push(...liveTimeline.getEvents());
        } catch {}

        try {
          if (Array.isArray(room.timeline)) events.push(...room.timeline);
        } catch {}

        for (const event of events) {
          const id = event.getId?.() || event.event?.event_id;
          if (id !== eventId) continue;

          const content = event.getContent?.() || event.event?.content || {};
          return content.url || content.file?.url || content["de.tkluge.gallery"]?.url || "";
        }
      }
    } catch {}

    return "";
  }

  function install() {
    if (installed) return;
    installed = true;

    installFetchHook();
    installXhrHook();

    window.addEventListener("message", event => {
      if (event.source !== window) return;
      if (!event.data) return;

      if (event.data.type === REQUEST) {
        poll();

        if (lastSession) {
          postSession(lastSession, "request-last-session");
        }

        return;
      }

      if (event.data.type === SEND_REQUEST) {
        const requestId = event.data.requestId;

        sendGalleryViaClient(event.data)
          .then(result => {
            window.postMessage({
              source: SOURCE,
              type: SEND_RESPONSE,
              requestId,
              ok: true,
              result
            }, window.location.origin);
          })
          .catch(error => {
            window.postMessage({
              source: SOURCE,
              type: SEND_RESPONSE,
              requestId,
              ok: false,
              error: error?.message || String(error)
            }, window.location.origin);
          });

        return;
      }

      if (event.data.type === GALLERY_REQUEST) {
        const requestId = event.data.requestId;
        const events = collectGalleryEvents(event.data.room);

        window.postMessage({
          source: SOURCE,
          type: GALLERY_RESPONSE,
          requestId,
          events
        }, window.location.origin);

        return;
      }

      if (event.data.type === MEDIA_REQUEST) {
        const requestId = event.data.requestId;
        const mxcUrl = event.data.mxcUrl || findMxcForEventId(event.data.eventId);
        const downloadUrl = makeContentDownloadUrl(mxcUrl);

        window.postMessage({
          source: SOURCE,
          type: MEDIA_RESPONSE,
          requestId,
          ok: Boolean(downloadUrl),
          mxcUrl,
          downloadUrl,
          error: downloadUrl ? "" : "Could not resolve media URL"
        }, window.location.origin);
      }
    });

    poll();
    setInterval(poll, 1800);
  }

  install();
})();
