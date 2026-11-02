(() => {
  const VERSION = "1.1.1";
  const SIGNATURE = "wloc-control-center-device-bridge";
  const SETTINGS_SCHEMA_VERSION = 2;
  const SETTINGS_KEY = "wloc_settings";
  const ROUTE_KEY = "wloc_route_session";
  const DIAG_KEY = "wloc_diag";
  const EVENTS_KEY = "wloc_events";

  const env = detectEnv();
  const args = parseQuery(typeof $argument === "string" ? $argument : "");

  function resolveStaticSettings() {
    const raw = readItem(SETTINGS_KEY);
    if (raw !== null && raw !== undefined && raw !== "") {
      let stored;
      try {
        stored = JSON.parse(raw);
      } catch {
        return { source: "invalid", current: null };
      }
      if (stored && typeof stored === "object" && stored.enabled === false) {
        return { source: "disabled", current: null };
      }
      const current = normalizeStaticSettings(stored, 25);
      return current
        ? { source: "stored", current }
        : { source: "invalid", current: null };
    }

    const fallback = normalizeStaticSettings({
      latitude: args.latitude,
      longitude: args.longitude,
      accuracy: args.accuracy
    }, 25);
    return fallback
      ? { source: "module", current: fallback }
      : { source: "none", current: null };
  }

  function normalizeStaticSettings(value, defaultAccuracy) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const latitude = num(value.latitude ?? value.lat, NaN);
    const longitude = num(value.longitude ?? value.lon, NaN);
    if (!validCoord(latitude, longitude)) return null;
    return Object.assign({}, value, {
      lat: latitude,
      lon: longitude,
      latitude,
      longitude,
      accuracy: clampInt(num(value.accuracy, defaultAccuracy), 5, 200)
    });
  }

  function num(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== "number" && typeof value !== "string") return fallback;
    if (typeof value === "string" && value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  const requestUrl = (typeof $request !== "undefined" && $request.url) || "";
  const query = parseQuery(requestUrl.split("?")[1] || "");
  const action = actionFromURL(requestUrl, query);

  try {
    if (action === "ping") {
      respond({
        ok: true,
        signature: SIGNATURE,
        moduleVersion: VERSION,
        tool: env,
        features: ["ping", "status", "save", "clear", "export", "diag", "route"],
        now: Date.now()
      });
      return;
    }

    if (action === "save") {
      const lat = Number(query.lat || query.latitude);
      const lon = Number(query.lon || query.lng || query.longitude);
      const accuracy = clampInt(Number(query.accuracy || query.acc || args.accuracy || 25), 5, 200);
      if (!validCoord(lat, lon)) throw new Error("invalid lat/lon");
      const previousSettingsRaw = readItem(SETTINGS_KEY);
      const writtenAt = Date.now();
      const current = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        enabled: true,
        lat, lon, latitude: lat, longitude: lon, accuracy,
        source: query.source || "wloc-control-center",
        name: query.name || "",
        updatedAt: writtenAt
      };
      if (writeJSON(SETTINGS_KEY, current) === false) throw new Error("settings storage write failed");
      const persistedCurrent = readJSON(SETTINGS_KEY, null);
      if (!persistedCurrent
          || persistedCurrent.enabled === false
          || Number(persistedCurrent.lat) !== lat
          || Number(persistedCurrent.lon) !== lon
          || Number(persistedCurrent.accuracy) !== accuracy) {
        if (restoreItem(SETTINGS_KEY, previousSettingsRaw) === false) {
          throw new Error("settings storage readback failed; settings rollback failed");
        }
        throw new Error("settings storage readback failed");
      }
      const diag = readDiag();
      diag.mode = "active";
      diag.moduleVersion = VERSION;
      diag.tool = env;
      diag.lastSettingsWriteAt = writtenAt;
      diag.lastError = null;
      diag.updatedAt = Date.now();
      if (writeJSON(DIAG_KEY, diag) === false) {
        if (restoreItem(SETTINGS_KEY, previousSettingsRaw) === false) {
          throw new Error("settings diagnostic write failed; settings rollback failed");
        }
        throw new Error("settings diagnostic write failed");
      }
      const persistedDiag = readDiag();
      if (Number(persistedDiag.lastSettingsWriteAt) !== writtenAt) {
        if (restoreItem(SETTINGS_KEY, previousSettingsRaw) === false) {
          throw new Error("settings diagnostic readback failed; settings rollback failed");
        }
        throw new Error("settings diagnostic readback failed");
      }
      appendEvent("settings_saved", "Coordinate saved from WLOC Control Center");
      respond(statusPayload(true));
      return;
    }

    if (action === "clear") {
      const previousSettingsRaw = readItem(SETTINGS_KEY);
      const clearedAt = Date.now();
      const tombstone = {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        enabled: false,
        clearedAt,
        updatedAt: clearedAt
      };
      if (writeJSON(SETTINGS_KEY, tombstone) === false) {
        throw new Error("settings disable write failed");
      }
      const persistedTombstone = readJSON(SETTINGS_KEY, null);
      if (!persistedTombstone
          || Number(persistedTombstone.schemaVersion) !== SETTINGS_SCHEMA_VERSION
          || persistedTombstone.enabled !== false
          || Number(persistedTombstone.clearedAt) !== clearedAt) {
        if (restoreItem(SETTINGS_KEY, previousSettingsRaw) === false) {
          throw new Error("settings disable readback failed; settings rollback failed");
        }
        throw new Error("settings disable readback failed");
      }
      const diag = readDiag();
      diag.mode = activeRoute(readJSON(ROUTE_KEY, null)) ? "route" : "passthrough";
      diag.moduleVersion = VERSION;
      diag.tool = env;
      diag.lastClearAt = clearedAt;
      diag.lastError = null;
      diag.updatedAt = Date.now();
      if (writeJSON(DIAG_KEY, diag) === false) throw new Error("clear diagnostic write failed");
      appendEvent("settings_cleared", "Static coordinate override disabled");
      respond(statusPayload(true));
      return;
    }

    if (action === "export" || action === "diag") {
      respond({
        ok: true,
        signature: SIGNATURE,
        settings: readJSON(SETTINGS_KEY, null),
        diag: readDiag(),
        events: readJSON(EVENTS_KEY, [])
      });
      return;
    }

    respond(statusPayload(true));
  } catch (error) {
    const diag = readDiag();
    diag.lastError = String(error && error.message ? error.message : error);
    diag.updatedAt = Date.now();
    writeJSON(DIAG_KEY, diag);
    respond({ ok: false, error: diag.lastError, moduleVersion: VERSION, tool: env, checkedAt: Date.now() }, 422);
  }

  function statusPayload(ok) {
    const staticState = resolveStaticSettings();
    const current = staticState.current;
    const route = routeStatus(readJSON(ROUTE_KEY, null));
    const diag = readDiag();
    const routeActive = route && (route.state === "running" || route.state === "paused");
    const effectiveCurrent = routeActive && route.current ? route.current : current;
    return {
      ok,
      signature: SIGNATURE,
      moduleVersion: VERSION,
      tool: env,
      mode: routeActive ? "route" : (current ? "active" : "passthrough"),
      current: effectiveCurrent,
      route,
      lastSettingsWriteAt: diag.lastSettingsWriteAt || null,
      lastClearAt: diag.lastClearAt || null,
      lastWlocHitAt: diag.lastWlocHitAt || null,
      lastPatchAt: diag.lastPatchAt || null,
      lastPassthroughAt: diag.lastPassthroughAt || null,
      lastRouteWriteAt: diag.lastRouteWriteAt || null,
      lastRoutePatchAt: diag.lastRoutePatchAt || null,
      patchCount: diag.patchCount || 0,
      passthroughCount: diag.passthroughCount || 0,
      lastError: diag.lastError || null,
      warnings: diag.warnings || [],
      checkedAt: Date.now()
    };
  }

  function readDiag() {
    const staticState = resolveStaticSettings();
    const mode = activeRoute(readJSON(ROUTE_KEY, null)) ? "route" : (staticState.current ? "active" : "passthrough");
    const diag = Object.assign({
      moduleVersion: VERSION,
      tool: env,
      mode,
      lastSettingsWriteAt: null,
      lastClearAt: null,
      lastWlocHitAt: null,
      lastPatchAt: null,
      lastPassthroughAt: null,
      lastRouteWriteAt: null,
      lastRoutePatchAt: null,
      patchCount: 0,
      passthroughCount: 0,
      lastError: null,
      warnings: [],
      updatedAt: Date.now()
    }, readJSON(DIAG_KEY, {}) || {});
    diag.mode = mode;
    return diag;
  }

  function appendEvent(type, message) {
    const events = readJSON(EVENTS_KEY, []);
    events.unshift({ type, time: Date.now(), message });
    writeJSON(EVENTS_KEY, events.slice(0, 20));
  }

  function actionFromURL(url, query) {
    if (query.action) return String(query.action).toLowerCase();
    const path = String(url).split("?")[0] || "";
    const match = path.match(/\/wloc-settings\/([^/?#]+)/);
    if (match && match[1]) return match[1].toLowerCase();
    return "status";
  }

  function detectEnv() {
    if (typeof $task !== "undefined") return "Quantumult X";
    if (typeof $loon !== "undefined") return "Loon";
    if (typeof $rocket !== "undefined") return "Shadowrocket";
    if (typeof Egern !== "undefined") return "Egern";
    if (typeof $environment !== "undefined" && $environment["surge-version"]) return "Surge";
    if (typeof $environment !== "undefined" && $environment["stash-version"]) return "Stash";
    return "Unknown";
  }

  function parseQuery(raw) {
    const out = {};
    String(raw || "").replace(/^\?/, "").split("&").forEach(part => {
      if (!part) return;
      const index = part.indexOf("=");
      const key = decode(index >= 0 ? part.slice(0, index) : part);
      const value = decode(index >= 0 ? part.slice(index + 1) : "");
      if (!(key in out)) out[key] = value;
    });
    return out;
  }

  function readJSON(key, fallback) {
    const raw = readItem(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  function writeJSON(key, value) {
    return writeItem(key, JSON.stringify(value));
  }

  function readItem(key) {
    if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
    if (typeof $prefs !== "undefined") return $prefs.valueForKey(key);
    return null;
  }

  function writeItem(key, value) {
    if (typeof $persistentStore !== "undefined") return $persistentStore.write(value, key);
    if (typeof $prefs !== "undefined") return $prefs.setValueForKey(value, key);
    return false;
  }

  function removeItem(key) {
    if (typeof $persistentStore !== "undefined") return $persistentStore.write(null, key);
    if (typeof $prefs !== "undefined") return $prefs.removeValueForKey(key);
    return false;
  }

  function restoreItem(key, raw) {
    return raw === null || raw === undefined
      ? removeItem(key)
      : writeItem(key, raw);
  }

  function respond(body, status) {
    const response = {
      status: status || 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify(body)
    };
    if (env === "Quantumult X") {
      response.status = "HTTP/1.1 " + (status || 200) + " OK";
      $done(response);
    } else {
      $done({ response });
    }
  }

  function validCoord(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  function clampInt(value, min, max) {
    value = Math.round(Number.isFinite(value) ? value : min);
    return Math.max(min, Math.min(max, value));
  }

  function routeStatus(route) {
    if (!route || !Array.isArray(route.pts) || route.pts.length < 2) return null;
    const current = routeCoordinate(route, Date.now());
    const elapsed = routeElapsed(route, Date.now());
    const duration = Number(route.totalDurationSec || route.pts[route.pts.length - 1][2] || 0);
    return {
      id: route.id || null,
      name: route.name || "Route",
      state: route.state || "idle",
      current: current ? { lat: current.lat, lon: current.lon, latitude: current.lat, longitude: current.lon, accuracy: clampInt(Number(route.acc || route.accuracy || 25), 5, 200) } : null,
      progress: duration > 0 ? Math.max(0, Math.min(1, normalizeElapsed(elapsed, route) / duration)) : 0,
      elapsedSec: Math.max(0, normalizeElapsed(elapsed, route)),
      totalDurationSec: duration,
      totalDistanceM: Number(route.totalDistanceM || 0),
      updatedAt: Date.now()
    };
  }

  function activeRoute(route) {
    return route && (route.state === "running" || route.state === "paused") && Array.isArray(route.pts) && route.pts.length >= 2;
  }

  function routeCoordinate(route, now) {
    if (!route || !Array.isArray(route.pts) || route.pts.length < 1) return null;
    const elapsed = normalizeElapsed(routeElapsed(route, now), route);
    const pts = route.pts;
    if (elapsed <= Number(pts[0][2] || 0)) return { lat: Number(pts[0][0]), lon: Number(pts[0][1]) };
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const at = Number(a[2] || 0);
      const bt = Number(b[2] || 0);
      if (elapsed <= bt) {
        const ratio = Math.max(0, Math.min(1, (elapsed - at) / Math.max(0.001, bt - at)));
        return { lat: Number(a[0]) + (Number(b[0]) - Number(a[0])) * ratio, lon: Number(a[1]) + (Number(b[1]) - Number(a[1])) * ratio };
      }
    }
    const last = pts[pts.length - 1];
    return { lat: Number(last[0]), lon: Number(last[1]) };
  }

  function routeElapsed(route, now) {
    if (!route) return 0;
    if (route.state === "running" && route.startedAt) return Math.max(0, (now - Number(route.startedAt)) / 1000) * Number(route.speedMultiplier || 1);
    if (route.state === "paused") return Math.max(0, Number(route.elapsedBeforePauseSec || 0));
    if (route.state === "finished") return Number(route.totalDurationSec || 0);
    return 0;
  }

  function normalizeElapsed(elapsed, route) {
    const duration = Number(route.totalDurationSec || (route.pts && route.pts.length ? route.pts[route.pts.length - 1][2] : 0) || 0);
    if (duration <= 0) return 0;
    if (route.loop) {
      const cycle = Math.floor(elapsed / duration);
      const remainder = elapsed % duration;
      if (route.reverseOnLoop && cycle % 2 === 1) return duration - remainder;
      return remainder;
    }
    return Math.max(0, Math.min(duration, elapsed));
  }

  function decode(value) {
    try { return decodeURIComponent(String(value).replace(/\+/g, " ")); } catch { return String(value); }
  }
})();