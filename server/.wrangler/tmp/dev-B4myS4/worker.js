var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
import { DurableObject } from "cloudflare:workers";
var APP_ORIGIN = "https://tomasgauchat.github.io";
var SUBJECT = "https://tomasgauchat.github.io/bitacora/";
var DEVICE_RE = /^[A-Za-z0-9_-]{20,64}$/;
var cors = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } }), "json");
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api" && parts[1] === "vapid" && req.method === "GET") {
      const cfg = env.DEVICE.get(env.DEVICE.idFromName("__config__"));
      return json({ key: await cfg.vapidPublic() });
    }
    if (parts[0] === "api" && (parts[1] === "sync" || parts[1] === "test") && req.method === "POST") {
      const device = parts[2];
      if (!DEVICE_RE.test(device || "")) return json({ error: "dispositivo inv\xE1lido" }, 400);
      let body = {};
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: "datos inv\xE1lidos" }, 400);
      }
      const stub = env.DEVICE.get(env.DEVICE.idFromName(device));
      if (parts[1] === "sync") return json(await stub.sync(body));
      return json(await stub.test(body));
    }
    if (parts[0] === "cal" && parts.length === 2 && req.method === "GET") {
      const device = parts[1].replace(/\.ics$/, "");
      if (!DEVICE_RE.test(device)) return new Response("No encontrado", { status: 404 });
      const stub = env.DEVICE.get(env.DEVICE.idFromName(device));
      return new Response(await stub.calendar(), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/") return new Response("Servidor de avisos de Bit\xE1cora", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response("No encontrado", { status: 404 });
  }
};
var Device = class extends DurableObject {
  static {
    __name(this, "Device");
  }
  async vapidPublic() {
    return (await this.vapidKeys()).publicB64;
  }
  async vapidKeys() {
    let k = await this.ctx.storage.get("vapid");
    if (!k) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      k = { priv, publicB64: b64url(pub) };
      await this.ctx.storage.put("vapid", k);
    }
    return k;
  }
  // La app manda la lista completa de avisos y eventos cada vez que algo cambia; reemplaza la anterior.
  async sync(body) {
    const now = Date.now();
    if (body.subscription && body.subscription.endpoint) await this.ctx.storage.put("sub", body.subscription);
    if (body.reminders !== void 0) {
      const reminders = (Array.isArray(body.reminders) ? body.reminders : []).filter((r) => r && typeof r.at === "number" && r.at > now - 6e4 && typeof r.title === "string").slice(0, 500).map((r) => ({ at: r.at, title: r.title.slice(0, 120), body: String(r.body || "").slice(0, 400), tag: String(r.tag || "").slice(0, 80) }));
      await this.ctx.storage.put("reminders", reminders);
    }
    if (body.events !== void 0) await this.ctx.storage.put("events", (Array.isArray(body.events) ? body.events : []).slice(0, 500));
    await this.schedule();
    return { ok: true, pending: (await this.ctx.storage.get("reminders") || []).length, subscribed: !!await this.ctx.storage.get("sub") };
  }
  async test(body) {
    const sub = await this.ctx.storage.get("sub");
    if (!sub) return { ok: false, error: "Este tel\xE9fono no tiene las notificaciones activadas" };
    const r = await this.push(sub, { title: "Bit\xE1cora", body: body && body.body || "Las notificaciones funcionan", tag: "prueba" });
    return { ok: r.ok, status: r.status };
  }
  async schedule() {
    const reminders = await this.ctx.storage.get("reminders") || [];
    const next = reminders.reduce((m, r) => Math.min(m, r.at), Infinity);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1e3));
  }
  async alarm() {
    const now = Date.now();
    const reminders = await this.ctx.storage.get("reminders") || [];
    const due = reminders.filter((r) => r.at <= now + 3e4);
    await this.ctx.storage.put("reminders", reminders.filter((r) => r.at > now + 3e4));
    const sub = await this.ctx.storage.get("sub");
    if (sub) {
      for (const r of due) {
        const res = await this.push(sub, r);
        if (res.status === 404 || res.status === 410) {
          await this.ctx.storage.delete("sub");
          break;
        }
      }
    }
    await this.schedule();
  }
  async push(sub, msg) {
    const cfg = this.env.DEVICE.get(this.env.DEVICE.idFromName("__config__"));
    const keys = await cfg.vapidKeys();
    const payload = new TextEncoder().encode(JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag }));
    const body = await encrypt(payload, sub.keys.p256dh, sub.keys.auth);
    const aud = new URL(sub.endpoint).origin;
    const jwt = await vapidJwt(keys.priv, aud);
    try {
      return await fetch(sub.endpoint, {
        method: "POST",
        headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${jwt}, k=${keys.publicB64}` },
        body
      });
    } catch (e) {
      return { ok: false, status: 0 };
    }
  }
  // Calendario para suscribirse desde el iPhone; se actualiza solo cuando la app sincroniza.
  async calendar() {
    const events = await this.ctx.storage.get("events") || [];
    const esc = /* @__PURE__ */ __name((s) => String(s || "").replace(/[\\,;]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n"), "esc");
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Bitacora de Camila//ES",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Bit\xE1cora",
      "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
      "X-PUBLISHED-TTL:PT15M"
    ];
    for (const e of events) {
      if (!/^\d{8}T\d{6}$/.test(e.start || "") || !/^\d{8}T\d{6}$/.test(e.end || "")) continue;
      lines.push("BEGIN:VEVENT", "UID:" + esc(e.uid) + "@bitacora", "DTSTAMP:" + stamp, "DTSTART:" + e.start, "DTEND:" + e.end, "SUMMARY:" + esc(e.title));
      if (e.desc) lines.push("DESCRIPTION:" + esc(e.desc));
      for (const a of e.alarms || []) {
        if (/^-?P(\d+D)?(T(\d+H)?(\d+M)?)?$/.test(a)) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(e.title), "TRIGGER:" + a, "END:VALARM");
      }
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    const fold = /* @__PURE__ */ __name((l) => {
      const p = [];
      for (let i = 0; i < l.length; i += 60) p.push(l.slice(i, i + 60));
      return p.join("\r\n ");
    }, "fold");
    return lines.map(fold).join("\r\n") + "\r\n";
  }
};
function b64url(bytes) {
  let s = "";
  bytes.forEach((b) => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64url, "b64url");
function unb64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
__name(unb64url, "unb64url");
var concat = /* @__PURE__ */ __name((...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}, "concat");
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
__name(hmac, "hmac");
var te = /* @__PURE__ */ __name((s) => new TextEncoder().encode(s), "te");
async function encrypt(payload, p256dhB64, authB64) {
  const uaPublic = unb64url(p256dhB64), authSecret = unb64url(authB64);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(te("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
__name(encrypt, "encrypt");
async function vapidJwt(privJwk, aud) {
  const key = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(te(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(te(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te(header + "." + claims)));
  return header + "." + claims + "." + b64url(sig);
}
__name(vapidJwt, "vapidJwt");

// ../../../../tmp/claude-0/-home-claude/93059d56-0958-5f70-8c92-f3c036bb7022/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/claude-0/-home-claude/93059d56-0958-5f70-8c92-f3c036bb7022/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-4lRX3w/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../tmp/claude-0/-home-claude/93059d56-0958-5f70-8c92-f3c036bb7022/scratchpad/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-4lRX3w/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Device,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
