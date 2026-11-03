// Switching an app on or off, shared by the drawer's rocker (DetailPanel) and the glass desktop app cards (AppCard).
// Every switch goes through ConfirmDialog first; these give it the plain-words steps and do the call.
import { mb, post, toast, type AppState } from "../store";

export const appIsOn = (a: AppState) => a.kind === "lock" || a.state !== "off";

/** What the switch will actually do, in plain words, for the confirm dialog. */
export function switchSteps(a: AppState): string[] {
  const off = appIsOn(a), out: string[] = [];
  const parts = Object.keys(a.parts);
  const ctr = parts.filter((p) => p.startsWith("docker:")).map((p) => p.slice(7));
  const ld = parts.filter((p) => p.startsWith("launchd:")).map((p) => p.slice(8));
  if (ctr.length) out.push(`${off ? "Stops" : "Starts"} ${ctr.length === 1 ? "container" : ctr.length + " containers"}: ${ctr.join(", ")}`);
  if (ld.length) out.push(`${off ? "Unloads" : "Loads"} background service${ld.length > 1 ? "s" : ""}: ${ld.join(", ")}`);
  if (parts.some((p) => p.startsWith("vm:"))) out.push(off ? "Shuts down the virtual machine" : "Boots the virtual machine (takes a minute)");
  if (a.kind === "gate") out.push(off ? "Visitors see a “switched off” page instead of the site" : "The site is served again");
  if (off && a.mem > 0) out.push(`Frees about ${mb(a.mem)} of RAM`);
  out.push(off ? "Stays off after a reboot — nothing is deleted" : "Starts again automatically after a reboot");
  return out;
}

/** Flip the app; the new state arrives over the live stream, so this only reports the outcome. */
export async function toggleApp(name: string, on: boolean) {
  try {
    const r = await post<{ ok: boolean; detail: string | string[] }>("/svc-api/toggle", { name, on });
    toast(r.ok ? `${name} ${on ? "started" : "stopped"}` : `Couldn't change ${name}: ${r.detail}`);
  } catch { toast(`Couldn't reach the server to change ${name}`); }
}
