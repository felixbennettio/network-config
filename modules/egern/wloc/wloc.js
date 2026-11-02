(() => {
  const VERSION = "1.1.1";
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

  let finalResponse;

  try {
    const response = typeof $response !== "undefined" ? $response : null;
    if (!response) throw new Error("not running in response mode");
    const settings = effectiveSettings();
    const diag = readDiag();
    diag.moduleVersion = VERSION;
    diag.tool = env;
    diag.lastWlocHitAt = Date.now();

    if (!settings) {
      diag.mode = "passthrough";
      diag.lastPassthroughAt = Date.now();
      diag.passthroughCount = (diag.passthroughCount || 0) + 1;
      diag.lastError = null;
      diag.updatedAt = Date.now();
      writeJSON(DIAG_KEY, diag);
      appendEvent("wloc_passthrough", "WLOC response passed through");
      finalResponse = response;
    } else {
      const bytes = bodyBytes(response);
      if (!bytes.length) throw new Error("empty response body");
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error("gzip response is not patchable by bundled script; force identity encoding or use an upstream compatible patcher");
      const patched = patchWloc(bytes, settings);
      const output = new Uint8Array(patched.data);
      response.body = output;
      response.bodyBytes = output;
      response.rawBody = output;
      response.status = 200;
      response.statusCode = 200;
      response.headers = response.headers || {};
      delete response.headers["Content-Encoding"];
      delete response.headers["content-encoding"];
      delete response.headers["Transfer-Encoding"];
      delete response.headers["transfer-encoding"];
      response.headers["Content-Length"] = String(output.length);
      diag.mode = settings.route ? "route" : "active";
      diag.lastPatchAt = Date.now();
      if (settings.route) {
        diag.lastRoutePatchAt = Date.now();
        diag.routeState = settings.route.state || "running";
        diag.routeName = settings.route.name || "Route";
      }
      diag.patchCount = (diag.patchCount || 0) + 1;
      diag.lastError = null;
      diag.patchStats = patched.stats;
      diag.updatedAt = Date.now();
      writeJSON(DIAG_KEY, diag);
      appendEvent("patch_success", "WLOC response patched");
      finalResponse = response;
    }
  } catch (error) {
    const diag = readDiag();
    diag.lastError = String(error && error.message ? error.message : error);
    diag.updatedAt = Date.now();
    writeJSON(DIAG_KEY, diag);
    appendEvent("patch_failed", diag.lastError);
    finalResponse = typeof $response !== "undefined" ? $response : {};
  } finally {
    done(finalResponse);
  }

  function effectiveSettings() {
    const route = readJSON(ROUTE_KEY, null);
    const routeSettings = effectiveRouteSettings(route);
    if (routeSettings) return routeSettings;
    return resolveStaticSettings().current;
  }

  function effectiveRouteSettings(route) {
    if (!route || !Array.isArray(route.pts) || route.pts.length < 2) return null;
    if (route.state !== "running" && route.state !== "paused") return null;
    const point = routeCoordinate(route, Date.now());
    if (!point || !validCoord(point.lat, point.lon)) return null;
    return {
      latitude: point.lat,
      longitude: point.lon,
      accuracy: clampInt(num(route.acc ?? route.accuracy, num(args.accuracy, 25)), 5, 200),
      route
    };
  }

  function patchWloc(bytes, settings) {
    const stats = { wifi: 0, cell: 0, locations: 0, skipped: 0 };
    const offsets = [0, 2, 4, 6, 8, 10, 12, 14, 16];
    const max = Math.min(96, Math.max(0, bytes.length - 10));
    for (let i = 0; i <= max; i += 1) if (!offsets.includes(i)) offsets.push(i);
    const reasons = [];
    for (const offset of offsets) {
      const snapshot = cloneStats(stats);
      try {
        const data = patchFrame(bytes, offset, settings, stats);
        return { data, stats };
      } catch (error) {
        restoreStats(stats, snapshot);
        if (reasons.length < 6) reasons.push("@" + offset + ":" + (error && error.message ? error.message : error));
      }
    }
    for (let offset = 0; offset <= Math.min(256, bytes.length); offset += 1) {
      const snapshot = cloneStats(stats);
      try {
        const payload = bytes.slice(offset);
        const patched = patchRootMessage(payload, settings, stats);
        if (stats.locations - snapshot.locations + stats.wifi - snapshot.wifi + stats.cell - snapshot.cell > 0 && !sameBytes(payload, patched)) {
          return { data: concat([bytes.slice(0, offset), patched]), stats };
        }
        restoreStats(stats, snapshot);
      } catch {
        restoreStats(stats, snapshot);
      }
    }
    throw new Error("no patchable WLOC payload found; " + reasons.join(" | "));
  }

  function patchFrame(bytes, offset, settings, stats) {
    if (bytes.length < offset + 10) throw new Error("body too short");
    const len = ((bytes[offset + 8] & 255) << 8) | (bytes[offset + 9] & 255);
    if (len <= 0 || offset + 10 + len > bytes.length) throw new Error("invalid frame length");
    const beforeStats = cloneStats(stats);
    const head = bytes.slice(0, offset + 8);
    const payload = bytes.slice(offset + 10, offset + 10 + len);
    const tail = bytes.slice(offset + 10 + len);
    const patched = patchRootMessage(payload, settings, stats);
    const delta = stats.locations - beforeStats.locations + stats.wifi - beforeStats.wifi + stats.cell - beforeStats.cell;
    if (delta <= 0 || sameBytes(payload, patched)) {
      restoreStats(stats, beforeStats);
      throw new Error("frame parsed but no patchable location");
    }
    if (patched.length > 65535) throw new Error("patched payload too large");
    return concat([head, [(patched.length >> 8) & 255, patched.length & 255], patched, tail]);
  }

  function patchRootMessage(bytes, settings, stats) {
    return encodeMessage(parseMessage(bytes).map(field => {
      if (field.wireType === 2 && field.fieldNo === 2) return fieldWithValue(field, patchWifiRecord(field.value, settings, stats));
      if (field.wireType === 2 && (field.fieldNo === 22 || field.fieldNo === 24)) return fieldWithValue(field, patchCellRecord(field.value, settings, stats));
      return field;
    }));
  }

  function patchWifiRecord(bytes, settings, stats) {
    const fields = parseMessage(bytes);
    const hasMac = fields.some(field => field.fieldNo === 1 && field.wireType === 2 && looksLikeMac(field.value));
    if (!hasMac) return bytes;
    let changed = false;
    const out = fields.map(field => {
      if (field.fieldNo === 2 && field.wireType === 2) {
        const patched = patchLocation(field.value, settings, stats);
        if (!sameBytes(patched, field.value)) changed = true;
        return fieldWithValue(field, patched);
      }
      return field;
    });
    if (changed) stats.wifi += 1;
    return encodeMessage(out);
  }

  function patchCellRecord(bytes, settings, stats) {
    let changed = false;
    const out = parseMessage(bytes).map(field => {
      if (field.fieldNo === 5 && field.wireType === 2) {
        const patched = patchLocation(field.value, settings, stats);
        if (!sameBytes(patched, field.value)) changed = true;
        return fieldWithValue(field, patched);
      }
      return field;
    });
    if (changed) stats.cell += 1;
    return encodeMessage(out);
  }

  function patchLocation(bytes, settings, stats) {
    const fields = parseMessage(bytes);
    const hasLat = fields.some(field => field.fieldNo === 1 && field.wireType === 0);
    const hasLon = fields.some(field => field.fieldNo === 2 && field.wireType === 0);
    if (!hasLat || !hasLon) return bytes;
    stats.locations += 1;
    return encodeMessage(fields.map(field => {
      if (field.fieldNo === 1 && field.wireType === 0) return fieldWithValue(field, encodeVarint(Math.round(settings.latitude * 1e8)));
      if (field.fieldNo === 2 && field.wireType === 0) return fieldWithValue(field, encodeVarint(Math.round(settings.longitude * 1e8)));
      if (field.fieldNo === 3 && field.wireType === 0) return fieldWithValue(field, encodeVarint(settings.accuracy));
      return field;
    }));
  }

  function parseMessage(bytes) {
    const fields = [];
    let index = 0;
    while (index < bytes.length) {
      const start = index;
      const tag = readVarint(bytes, index);
      index = tag.next;
      const fieldNo = Math.floor(tag.value / 8);
      const wireType = tag.value & 7;
      if (fieldNo <= 0) throw new Error("invalid protobuf field");
      let value;
      if (wireType === 0) {
        const parsed = readVarintBytes(bytes, index);
        value = parsed.bytes;
        index = parsed.next;
      } else if (wireType === 1) {
        value = bytes.slice(index, index + 8);
        index += 8;
      } else if (wireType === 2) {
        const len = readVarint(bytes, index);
        index = len.next;
        value = bytes.slice(index, index + len.value);
        index += len.value;
      } else if (wireType === 5) {
        value = bytes.slice(index, index + 4);
        index += 4;
      } else {
        throw new Error("unsupported wire type " + wireType);
      }
      if (index > bytes.length) throw new Error("truncated protobuf field");
      fields.push({ fieldNo, wireType, value, raw: bytes.slice(start, index) });
    }
    return fields;
  }

  function encodeMessage(fields) {
    return concat(fields.map(field => field.raw));
  }

  function fieldWithValue(field, value) {
    const tag = encodeVarint(field.fieldNo * 8 + field.wireType);
    if (field.wireType === 0 || field.wireType === 1 || field.wireType === 5) return { ...field, value, raw: concat([tag, value]) };
    if (field.wireType === 2) return { ...field, value, raw: concat([tag, encodeVarint(value.length), value]) };
    return field;
  }

  function readVarint(bytes, index) {
    let value = 0;
    let shift = 0;
    while (index < bytes.length) {
      const byte = bytes[index++] & 255;
      if (shift < 56) value += (byte & 127) * Math.pow(2, shift);
      if (!(byte & 128)) return { value, next: index };
      shift += 7;
      if (shift > 70) throw new Error("varint too long");
    }
    throw new Error("truncated varint");
  }

  function readVarintBytes(bytes, index) {
    const start = index;
    while (index < bytes.length) {
      const byte = bytes[index++] & 255;
      if (!(byte & 128)) return { bytes: bytes.slice(start, index), next: index };
    }
    throw new Error("truncated varint");
  }

  function encodeVarint(value) {
    let v = BigInt(Math.trunc(value));
    if (v < 0n) v = (1n << 64n) + v;
    const out = [];
    while (v >= 128n) {
      out.push(Number((v & 127n) | 128n));
      v >>= 7n;
    }
    out.push(Number(v));
    return out;
  }

  function bodyBytes(response) {
    const body = response.bodyBytes || response.rawBody || response.body;
    if (!body) return [];
    if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(body)) return Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    if (typeof body === "string") return Array.from(body).map(ch => ch.charCodeAt(0) & 255);
    if (typeof body.length === "number") return Array.from(body).map(n => n & 255);
    return [];
  }

  function effectiveDonePayload(response) {
    if (env === "Quantumult X") {
      response.status = response.status || 200;
      delete response.headers?.["Content-Length"];
      delete response.headers?.["content-length"];
      delete response.headers?.["Transfer-Encoding"];
      return response;
    }
    return { response };
  }

  function done(response) {
    if (typeof $done === "function") $done(effectiveDonePayload(response || {}));
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

  function readDiag() {
    const mode = activeRoute(readJSON(ROUTE_KEY, null)) ? "route" : (resolveStaticSettings().current ? "active" : "passthrough");
    const diag = Object.assign({
      moduleVersion: VERSION,
      tool: env,
      mode,
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

  function looksLikeMac(bytes) {
    const text = String.fromCharCode.apply(null, bytes);
    return /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(text);
  }

  function concat(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Array(total);
    let offset = 0;
    for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 1) out[offset++] = chunk[i] & 255;
    return out;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if ((a[i] & 255) !== (b[i] & 255)) return false;
    return true;
  }

  function cloneStats(stats) {
    return { wifi: stats.wifi, cell: stats.cell, locations: stats.locations, skipped: stats.skipped };
  }

  function restoreStats(stats, saved) {
    stats.wifi = saved.wifi;
    stats.cell = saved.cell;
    stats.locations = saved.locations;
    stats.skipped = saved.skipped;
  }

  function validCoord(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  function activeRoute(route) {
    return route && (route.state === "running" || route.state === "paused") && Array.isArray(route.pts) && route.pts.length >= 2;
  }

  function routeCoordinate(route, now) {
    const elapsed = normalizeElapsed(routeElapsed(route, now), route);
    const pts = route.pts || [];
    if (!pts.length) return null;
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

  function clampInt(value, min, max) {
    value = Math.round(Number.isFinite(value) ? value : min);
    return Math.max(min, Math.min(max, value));
  }

  function decode(value) {
    try { return decodeURIComponent(String(value).replace(/\+/g, " ")); } catch { return String(value); }
  }
})();