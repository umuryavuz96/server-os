// HTTP plumbing shared by every route: trace ids, request logging, auth, RFC 9457 errors.
import type { Context, MiddlewareHandler } from "hono";
import { config } from "./config";
import { adminKey, verify, type Device } from "./devices";
import { fromTraceparent, logEvent, traceparent, type Trace } from "./logger";

export type Env = { Variables: { trace: Trace; actor: string; device: Device | null } };

/** RFC 9457 problem details. */
export function problem(c: Context, status: number, title: string, detail?: string) {
  return c.body(JSON.stringify({ type: "about:blank", title, status, detail, trace_id: c.get("trace")?.trace_id }), status as 400,
    { "Content-Type": "application/problem+json" });
}

/** Trace id per request (continues a W3C traceparent if the caller sent one) + one structured log line. */
export const tracing: MiddlewareHandler<Env> = async (c, next) => {
  const trace = fromTraceparent(c.req.header("traceparent"));
  c.set("trace", trace);
  c.set("actor", "anonymous");
  c.set("device", null);
  const t0 = performance.now();
  await next();
  c.header("traceparent", traceparent(trace));
  const ms = Math.round(performance.now() - t0);
  // Mutations at info; reads only at debug (the apps poll), but always when they fail or are slow.
  const level = c.res.status >= 500 ? "error" : c.req.method !== "GET" || c.res.status >= 400 || ms > 2000 ? "info" : "debug";
  logEvent(level, `${c.req.method} ${c.req.path} ${c.res.status}`, { "http.method": c.req.method, "http.route": c.req.path, "http.status_code": c.res.status, duration_ms: ms, actor: c.get("actor") }, trace);
};

/** Browsers sign in once and keep an HttpOnly cookie; apps and tools send a Bearer token. */
export const COOKIE = "sd_token";
export const cookieToken = (c: Context) => (c.req.header("cookie") ?? "").split(/;\s*/).find((p) => p.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
export const bearer = (c: Context) => {
  const h = c.req.header("authorization") ?? "";
  // ?token= for EventSource clients that can't set headers; the cookie for the web panel
  return h.startsWith("Bearer ") ? h.slice(7).trim() : (c.req.query("token") ?? "") || decodeURIComponent(cookieToken(c));
};
/** Set-Cookie for a paired browser: a year, HttpOnly, same-site only, Secure when served over https. */
export const signInCookie = (c: Context, token: string) => {
  const https = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${https ? "; Secure" : ""}`;
};
export const signOutCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;

/** auth: token → every API call needs a paired device's token (or the local admin key). auth: off → open. */
export const requireAuth = (open: (path: string) => boolean): MiddlewareHandler<Env> => async (c, next) => {
  const t = bearer(c);
  // The admin key is held by local tools; the agent kit's MCP server says it is the agent.
  if (t && t === adminKey()) c.set("actor", c.req.header("x-actor") === "agent" ? "agent" : "admin");
  else {
    const d = t ? verify(t) : null;
    if (d) { c.set("device", d); c.set("actor", `device:${d.id}`); }
    else if (config.auth === "token" && !open(c.req.path)) return problem(c, 401, "Unauthorized", "Pair this device first: run `server-os pair` on the server.");
  }
  await next();
};

/** Pairing and device management: the local admin key or an already-paired device — never an anonymous caller. */
export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (!["admin", "agent"].includes(c.get("actor")) && !c.get("device")) return problem(c, 403, "Forbidden", "Needs the server's admin key or a paired device.");
  await next();
};
