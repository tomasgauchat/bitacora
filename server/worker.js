// Servidor de avisos de Bitácora (Cloudflare Worker).
// Guarda, por cada teléfono, los avisos programados y manda la notificación a la hora justa.
// También publica un calendario (.ics) al que el iPhone se suscribe una vez.
// Solo recibe textos cortos con iniciales, nunca nombres completos de pacientes.
// Guarda además la copia diaria de la app, cifrada en el teléfono: el servidor no puede leerla.

import { DurableObject } from "cloudflare:workers";

const APP_ORIGIN = "https://tomasgauchat.github.io";
const SUBJECT = "https://tomasgauchat.github.io/bitacora/";
const DEVICE_RE = /^[A-Za-z0-9_-]{20,64}$/;
const BACKUP_RE = /^[0-9a-f]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_DAYS = 30;

const cors = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

export default {
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
      if (!DEVICE_RE.test(device || "")) return json({ error: "dispositivo inválido" }, 400);
      let body = {};
      try { body = await req.json(); } catch (e) { return json({ error: "datos inválidos" }, 400); }
      const stub = env.DEVICE.get(env.DEVICE.idFromName(device));
      if (parts[1] === "sync") return json(await stub.sync(body));
      return json(await stub.test(body));
    }
    // Copia cifrada: /api/backup/:id (POST guarda la del día, GET lista las fechas), /api/backup/:id/:fecha (GET la devuelve).
    if (parts[0] === "api" && parts[1] === "backup" && BACKUP_RE.test(parts[2] || "")) {
      const stub = env.DEVICE.get(env.DEVICE.idFromName("copia:" + parts[2]));
      if (req.method === "POST" && parts.length === 3) {
        let body = {};
        try { body = await req.json(); } catch (e) { return json({ error: "datos inválidos" }, 400); }
        if (!DATE_RE.test(body.date || "") || typeof body.data !== "string" || !body.data.length || body.data.length > 1900000) return json({ error: "copia inválida" }, 400);
        return json(await stub.backupPut(body.date, body.data));
      }
      if (req.method === "GET" && parts.length === 3) return json(await stub.backupList());
      if (req.method === "GET" && parts.length === 4 && DATE_RE.test(parts[3])) {
        const data = await stub.backupGet(parts[3]);
        return data ? json({ date: parts[3], data }) : json({ error: "no hay copia de ese día" }, 404);
      }
    }
    if (parts[0] === "cal" && parts.length === 2 && req.method === "GET") {
      const device = parts[1].replace(/\.ics$/, "");
      if (!DEVICE_RE.test(device)) return new Response("No encontrado", { status: 404 });
      const stub = env.DEVICE.get(env.DEVICE.idFromName(device));
      return new Response(await stub.calendar(), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/") return new Response("Servidor de avisos de Bitácora", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response("No encontrado", { status: 404 });
  },
};

// Un objeto por teléfono (y uno especial, "__config__", que guarda las claves para firmar los avisos).
export class Device extends DurableObject {
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
    if (body.reminders !== undefined) {
      const reminders = (Array.isArray(body.reminders) ? body.reminders : [])
        .filter((r) => r && typeof r.at === "number" && r.at > now - 60000 && typeof r.title === "string")
        .slice(0, 500)
        .map((r) => ({ at: r.at, title: r.title.slice(0, 120), body: String(r.body || "").slice(0, 400), tag: String(r.tag || "").slice(0, 80) }));
      await this.ctx.storage.put("reminders", reminders);
    }
    if (body.events !== undefined) await this.ctx.storage.put("events", (Array.isArray(body.events) ? body.events : []).slice(0, 500));
    await this.schedule();
    return { ok: true, pending: ((await this.ctx.storage.get("reminders")) || []).length, subscribed: !!(await this.ctx.storage.get("sub")) };
  }

  async test(body) {
    const sub = await this.ctx.storage.get("sub");
    if (!sub) return { ok: false, error: "Este teléfono no tiene las notificaciones activadas" };
    const r = await this.push(sub, { title: "Bitácora", body: (body && body.body) || "Las notificaciones funcionan", tag: "prueba" });
    return { ok: r.ok, status: r.status };
  }

  async schedule() {
    const reminders = (await this.ctx.storage.get("reminders")) || [];
    const next = reminders.reduce((m, r) => Math.min(m, r.at), Infinity);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  async alarm() {
    const now = Date.now();
    const reminders = (await this.ctx.storage.get("reminders")) || [];
    const due = reminders.filter((r) => r.at <= now + 30000);
    await this.ctx.storage.put("reminders", reminders.filter((r) => r.at > now + 30000));
    const sub = await this.ctx.storage.get("sub");
    if (sub) {
      for (const r of due) {
        const res = await this.push(sub, r);
        // 404/410: el teléfono dio de baja las notificaciones.
        if (res.status === 404 || res.status === 410) { await this.ctx.storage.delete("sub"); break; }
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
        body,
      });
    } catch (e) {
      return { ok: false, status: 0 };
    }
  }

  // Copias: una por día (la última de ese día reemplaza a la anterior); se guardan los últimos 30 días.
  async backupPut(date, data) {
    await this.ctx.storage.put("copia:" + date, data);
    const dates = await this.backupDates();
    for (const d of dates.slice(BACKUP_DAYS)) await this.ctx.storage.delete("copia:" + d);
    return { ok: true, date };
  }
  async backupDates() {
    const keys = await this.ctx.storage.list({ prefix: "copia:" });
    return [...keys.keys()].map((k) => k.slice(6)).sort().reverse();
  }
  async backupList() {
    return { dates: await this.backupDates() };
  }
  async backupGet(date) {
    return (await this.ctx.storage.get("copia:" + date)) || null;
  }

  // Calendario para suscribirse desde el iPhone; se actualiza solo cuando la app sincroniza.
  async calendar() {
    const events = (await this.ctx.storage.get("events")) || [];
    const esc = (s) => String(s || "").replace(/[\\,;]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bitacora de Camila//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:Bitácora", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
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
    const fold = (l) => { const p = []; for (let i = 0; i < l.length; i += 60) p.push(l.slice(i, i + 60)); return p.join("\r\n "); };
    return lines.map(fold).join("\r\n") + "\r\n";
  }
}

// ---------- Web Push (RFC 8291 y RFC 8292) ----------
function b64url(bytes) {
  let s = ""; bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const te = (s) => new TextEncoder().encode(s);

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

async function vapidJwt(privJwk, aud) {
  const key = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(te(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(te(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te(header + "." + claims)));
  return header + "." + claims + "." + b64url(sig);
}
