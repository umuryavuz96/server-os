// "How to grant" content per permission: numbered steps, each with a small mock visual (PermVisual.vue). Wording follows what
// macOS 13-26 shows; the visuals are generic on purpose. The program name and path come from the server's own report.

/** What a guide needs from a permission (structural, so the server tests can import this file). */
export interface GuideInput { id: string; how?: "dialog" | "settings" | "" | undefined; processes: { role: string; path: string }[]; targets?: string[] }
/** What the last Fix did: "prompt" the Allow popup is up, "granted" macOS had nothing to ask, "pane" only Settings is left. */
export type Outcome = "prompt" | "granted" | "pane" | "";
export type Vis = "sidebar" | "plus" | "toggle" | "expand" | "folders" | "password" | "dialog" | "quit";
export interface Step {
  title: string; body: string; vis: Vis;
  /** One-line label for the compact strip. */
  short: string;
  /** Only if the step before did not do it. */
  optional?: boolean;
  /** Paths to offer a Copy button for. */
  copy?: string[];
  /** Offers an "Open Settings" button (the popup cannot be had twice). */
  pane?: boolean;
  /** Lines of the mock popup. */
  lines?: string[];
}
export interface Guide { name: string; paneLabel: string; steps: Step[] }

const PANE: Record<string, string> = {
  "full-disk-access": "Full Disk Access", "local-network": "Local Network", "removable-volumes": "Removable Volumes",
  "files-folders": "Files & Folders", microphone: "Microphone", automation: "Automation",
};
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** The program that holds the grant: the first process with a real path, else the server (bun). */
export function progName(p: Pick<GuideInput, "processes">): string {
  const x = p.processes.find((q) => q.path.startsWith("/"));
  return x ? base(x.path) : "bun";
}
export function wrap(s: string, n = 26): string[] {
  const out: string[] = []; let cur = "";
  for (const w of s.split(" ")) { if (cur && (cur + " " + w).length > n) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
  if (cur) out.push(cur);
  return out;
}

/** Panes whose list is a DISCLOSURE row per program (click its arrow, then switch the places it may reach). The others are flat lists. */
export const DISCLOSURE = new Set(["files-folders", "removable-volumes", "automation"]);
/** What the switches under the program are called when the config does not name any. */
const USUAL: Record<string, string[]> = { "files-folders": ["Desktop Folder", "Documents Folder", "Downloads Folder"], "removable-volumes": ["Removable Volumes"], automation: ["System Events"] };
export const targetsOf = (p: Pick<GuideInput, "id" | "targets">) => (p.targets?.length ? p.targets : USUAL[p.id] ?? []);

const POPUP: Record<string, (n: string) => string> = {
  "local-network": (n) => `“${n}” would like to find and connect to devices on your local network.`,
  "removable-volumes": (n) => `“${n}” would like to access files on a removable volume.`,
  "files-folders": (n) => `“${n}” would like to access files in your Documents, Desktop or Downloads folder.`,
  automation: (n) => `“${n}” wants access to control “System Events”.`,
};

export function guideFor(p: GuideInput, outcome: Outcome = ""): Guide | null {
  const name = progName(p), pane = PANE[p.id];
  if (!pane) return null;
  const paths = p.processes.map((x) => x.path).filter((x) => x.startsWith("/"));
  const where = `Privacy & Security, then ${pane}`;
  const open: Step = { title: "Open the pane", short: "Open the pane", body: `Settings opens at ${where}.`, vis: "sidebar" };
  const password: Step = { title: "Password only if macOS asks", short: "Password if asked", body: "macOS asks for your password or Touch ID before it changes the setting.", vis: "password", optional: true };
  // The switch(es): a flat list has one next to the program; a disclosure row has to be expanded first (the list is long).
  let find: Step[];
  if (DISCLOSURE.has(p.id)) {
    const t = targetsOf(p), list = t.join(", ");
    find = [
      { title: `Click the arrow next to ${name} to expand it`, short: `Expand ${name}`, vis: "expand", copy: paths.length ? paths.slice(0, 1) : undefined,
        body: `The list is long (version numbers, cron, Docker, …): look for “${name}” and click the arrow at its right. If it is not listed yet, macOS adds it the first time ${name} needs it.` },
      { title: `Switch on ${list}`, short: t.length > 1 ? `Switch on ${t.length} places` : "Switch on " + (t[0] ?? "it").replace(/ Folder$/, ""), vis: "folders", lines: t.slice(0, 3),
        body: p.id === "automation" ? `Under ${name}, switch on ${list}.` : `Under ${name} there is one switch per place. Turn on ${list}.` },
    ];
    if (p.id === "files-folders" && t.length > 1) find[1].short = `Switch on ${t.length} folders`;
  } else {
    find = [{ title: `Switch ${name} on`, short: `Switch ${name} on`, body: `Find ${name} in the list and turn its switch on. If it is not listed yet, macOS adds it the first time ${name} needs it.`, vis: "toggle" }];
  }
  if (p.how === "dialog") {
    const settings: Step[] = outcome === "pane"
      ? [open, ...find, password]
      : [{ ...open, title: "No popup, or you said Don't Allow?", short: "No popup? Settings", body: `macOS will not ask twice. Open Settings, then ${where}.`, optional: true, pane: true }, ...find.map((s) => ({ ...s, optional: true }))];
    return {
      name, paneLabel: pane,
      steps: outcome === "pane" ? settings : [
        { title: "Click Allow on the Mac screen", short: "Click Allow", body: "macOS is asking on the Mac now. Click Allow; it asks only once.", vis: "dialog", lines: wrap(POPUP[p.id]?.(name) ?? `“${name}” would like access.`) },
        ...settings,
      ],
    };
  }
  if (p.id === "full-disk-access") {
    return {
      name, paneLabel: pane,
      steps: [
        { ...open, body: `Settings opens at ${where}. There is no popup for this one: the switch is the only way.` },
        { title: `Add ${name} if it is not listed`, short: `Add ${name} with +`, body: "Click +, unlock if asked, press ⌘⇧G in the file picker, paste the path, press Return, then Open.", vis: "plus", optional: true, copy: paths.length ? paths : undefined },
        ...find,
        { ...password, title: "Confirm with your Mac password", optional: false },
        { title: "If macOS offers Quit & Reopen", short: "Quit & Reopen", body: "Choose it so the program starts with the new access.", vis: "quit", optional: true, lines: wrap(`“${name}” may not see the change until it is reopened.`, 24) },
      ],
    };
  }
  return { name, paneLabel: pane, steps: [open, ...find] };
}
