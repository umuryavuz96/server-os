// Docker Engine API over the unix socket (no CLI spawns). Docker Desktop for Mac exposes ~/.docker/run/docker.sock;
// Linux has /var/run/docker.sock (group `docker`) or a rootless socket under $XDG_RUNTIME_DIR.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./lib";

/** The Docker socket for this machine: DOCKER_HOST (unix://) first, then the usual places for the OS. */
export function dockerSocket(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string {
  const h = env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice(7) : "";
  if (h) return h;
  const desktop = join(HOME, ".docker/run/docker.sock"), system = "/var/run/docker.sock";
  const rootless = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "docker.sock") : "";
  const order = platform === "darwin" ? [desktop, system] : [system, rootless, desktop].filter(Boolean);
  return order.find(exists) ?? order[0];
}

export async function dockerApi<T = unknown>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T | null> {
  try {
    const res = await fetch(`http://localhost${path}`, { ...init, unix: dockerSocket(), signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
    if (res.status === 204 || res.status === 304) return {} as T;
    if (!res.ok) return null;
    const txt = await res.text();
    return (txt ? JSON.parse(txt) : {}) as T;
  } catch {
    return null;
  }
}

export interface ContainerInfo { name: string; id: string; state: string; }

export async function listContainers(): Promise<ContainerInfo[] | null> {
  const r = await dockerApi<Array<{ Id: string; Names: string[]; State: string }>>("/containers/json?all=1");
  return r ? r.map((c) => ({ id: c.Id, name: c.Names[0]?.replace(/^\//, "") ?? c.Id, state: c.State })) : null;
}

/** Memory in MB as `docker stats` reports it (usage minus inactive file cache). */
export async function containerMemMB(id: string): Promise<number> {
  const s = await dockerApi<{ memory_stats?: { usage?: number; stats?: Record<string, number> } }>(`/containers/${id}/stats?stream=false&one-shot=true`, {}, 10_000);
  const m = s?.memory_stats;
  if (!m?.usage) return 0;
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
  return (m.usage - cache) / 1048576;
}

export const startContainer = (name: string) => dockerApi(`/containers/${encodeURIComponent(name)}/start`, { method: "POST" }, 120_000);
export const stopContainer = (name: string) => dockerApi(`/containers/${encodeURIComponent(name)}/stop`, { method: "POST" }, 120_000);
export const setRestart = (name: string, policy: "no" | "unless-stopped") =>
  dockerApi(`/containers/${encodeURIComponent(name)}/update`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ RestartPolicy: { Name: policy } }),
  });

/** Stream container lifecycle events; calls onEvent for start/stop/die/etc. Reconnects forever. */
export async function watchEvents(onEvent: (name: string, action: string) => void) {
  for (;;) {
    try {
      const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["start", "stop", "die", "pause", "unpause", "restart", "destroy", "create"] }));
      const res = await fetch(`http://localhost/events?filters=${filters}`, { unix: dockerSocket() } as RequestInit);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            onEvent(e.Actor?.Attributes?.name ?? "", e.Action ?? e.status ?? "");
          } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000)); // Docker restarted or not up yet
  }
}
