// Shapes of the Discover API (GET /api/v1/catalog*, see server/modules/catalog.ts) and small shared helpers.
export type Tier = "ready" | "oneclick" | "agent";
export type Health = "active" | "slowing" | "stale" | "archived" | "unknown";
export interface Opt { method: string; ref: string; label: string }
export interface Item {
  id: string; name: string; description: string; category: string; sub?: string | null; genre?: string; tier?: Tier; health?: Health;
  replaces?: string[]; screenshots?: string[]; arch?: string[] | null; why?: string;
  website: string | null; repo: string | null; license: string | null; stars: number | null; updated: string | null; archived: boolean;
  logo: string | null; sources: string[]; install: Opt[]; installed?: boolean;
}
export interface Detail extends Item {
  similar: Item[]; pairs: (Item & { why: string })[]; packs: { id: string; name: string }[]; runningHref: string | null;
  installPreview: { address: string | null; agentSetup: boolean; owner: string };
}
export interface Genre { id: string; label: string; blurb: string; icon: string; count: number; installable: number; categories: { category: string; count: number }[]; logos: { logo: string; name: string }[] }
export interface Shelf { id: string; title: string; subtitle: string; genre?: string; items: Item[] }
export interface Pick { id: string; kicker: string; why: string; item: Item }
export interface Pack { id: string; name: string; blurb: string; tint: string; apps: string[]; items: Item[] }
export interface Replace { service: string; items: Item[] }
export interface Featured { hero: Pick[]; side: Pick[][] }
export interface Home { picks: Pick[]; featured?: Featured; replaces: Replace[]; packs: Pack[]; shelves: Shelf[] }

export const auto = (it: Item) => it.install.filter((o) => o.method !== "dockerhub");
export const tierOf = (it: Item): Tier => it.tier ?? (it.install[0]?.method === "recipe" ? "ready" : auto(it).length ? "oneclick" : "agent");
export const TIER: Record<Tier, { label: string; hint: string }> = {
  ready: { label: "Ready to use", hint: "Tested recipe: installs, gets an address and is set up for you" },
  oneclick: { label: "One-click", hint: "Installs automatically; the agent can finish the setup" },
  agent: { label: "Agent installs", hint: "No automatic install: the agent writes a recipe and installs it" },
};
export const HEALTH: Record<Health, string> = { active: "Active", slowing: "Slowing", stale: "Stale", archived: "Archived", unknown: "No release info" };
export const stars = (n: number | null) => (n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
/** "3 days ago", "9 months ago", "2 years ago". */
export function ago(d: string | null): string {
  if (!d) return "";
  const days = Math.max(0, Math.round((Date.now() - Date.parse(d)) / 86_400_000));
  if (days < 1) return "today";
  if (days < 45) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 548) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}
// iOS and some browsers can't show every SVG logo; the icon CDN serves a PNG next to each SVG.
export const logoOf = (it: { logo: string | null }) => it.logo ?? "";

// Line icons for genres (24×24, stroke).
export const ICON: Record<string, string> = {
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4", image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5a1.5 1.5 0 1 0 0-.01",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  home: "M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5", check: "M5 12.5l4 4L19 7M4 4h16v16H4z", chat: "M4 5h16v11H9l-5 4z",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14", shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
  gauge: "M4 17a8 8 0 1 1 16 0M12 17l4-5M4 17h3M17 17h3", globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  coin: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2",
  game: "M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14 13h-4l-1.6 1.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4zM8 10.5v3M6.5 12h3M15.5 11.5h.01M17.5 12.5h.01",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
};
// Genre tints: dark, so white icons and text keep contrast.
export const TINT: Record<string, string> = {
  home: "#134e4a", media: "#4c1d95", photos: "#14532d", files: "#0c4a6e", docs: "#713f12", productivity: "#1e3a8a", chat: "#831843",
  ai: "#581c87", dev: "#27272a", network: "#7f1d1d", server: "#1f2937", web: "#0e3b52", business: "#3f3f12", games: "#4a1d3d", other: "#27272a",
};

// App lifecycle (server: installer.ts lifecycle(), SSE slice "lifecycle"): absent = available.
export type LifeState = "installing" | "setting-up" | "removing" | "ready" | "installed" | "setup-failed" | "failed";
export interface Life { name: string; logo: string | null; state: LifeState; step: string; op: string | null; agent: boolean; since: number; href: string | null; error: string | null; checklist: Check[] }
export const BUSY: LifeState[] = ["installing", "setting-up", "removing"];
export const LIFE_LABEL: Record<LifeState, string> = {
  installing: "Installing", "setting-up": "Setting up", removing: "Removing", ready: "Ready", installed: "Installed", "setup-failed": "Setup failed", failed: "Install failed",
};
export interface Check { label: string; state: "todo" | "doing" | "done" | "skipped" | "failed"; note?: string; group?: string }
