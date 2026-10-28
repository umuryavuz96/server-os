#!/usr/bin/env bun
// server-os CLI: `init` lays out the home folder, `pair` opens a pairing window, `devices` / `revoke <id>` manage them.
import { CONFIG_FILE, initLayout, ROOT } from "./core/config";
import { adminKey } from "./core/devices";

const BASE = process.env.SERVER_OS_URL ?? process.env.SERVER_DASH_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3094}`;
const call = async (method: string, path: string) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${adminKey()}`, "Content-Type": "application/json" } })
    .catch(() => { console.error(`Server OS is not answering at ${BASE}`); process.exit(1); });
  if (!r.ok) { console.error(`${r.status} ${await r.text()}`); process.exit(1); }
  return r.status === 204 ? null : r.json();
};

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "init": {
    const made = initLayout();
    console.log(made.length ? `Created:\n  ${made.join("\n  ")}` : `Already set up: ${ROOT}`);
    console.log(`Config: ${CONFIG_FILE}`);
    break;
  }
  case "pair": {
    const { code, expires } = await call("POST", "/pair/start");
    console.log(`\n  Pairing code:  ${code.slice(0, 3)} ${code.slice(3)}\n\n  Enter it in the Server OS app within ${Math.round((expires - Date.now()) / 60000)} minutes.\n`);
    break;
  }
  case "devices": {
    const { devices } = await call("GET", "/devices");
    if (!devices.length) console.log("No paired devices.");
    for (const d of devices) console.log(`${d.id}  ${d.name} (${d.platform})  last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never"}`);
    break;
  }
  case "revoke":
    if (!arg) { console.error("usage: server-os revoke <device-id>"); process.exit(2); }
    await call("DELETE", `/devices/${encodeURIComponent(arg)}`);
    console.log("Revoked.");
    break;
  default:
    console.log("usage: server-os <init | pair | devices | revoke <id>>");
    process.exit(cmd ? 2 : 0);
}
