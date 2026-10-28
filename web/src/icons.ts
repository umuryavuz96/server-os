// One icon set for the whole panel: Lucide (24 px grid, stroke 1.8, the weight of the old hand-drawn nav icons).
// Add an icon here and use it by name through <Icon name="…">; only the icons listed end up in the bundle.
import { AudioLines, Bell, Blocks, Bot, ChevronDown, CircleCheck, Clock, Cloud, Compass, Database, Globe, LayoutDashboard, LayoutGrid, LoaderCircle, Menu, Monitor, Network, Play, ScrollText, ShieldCheck, SlidersHorizontal, Square, Volume2, Webhook, X } from "lucide-vue-next";

export const ICONS = {
  "audio-lines": AudioLines, bell: Bell, blocks: Blocks, bot: Bot, "chevron-down": ChevronDown, "circle-check": CircleCheck, clock: Clock, cloud: Cloud,
  compass: Compass, database: Database, globe: Globe, "layout-dashboard": LayoutDashboard, "layout-grid": LayoutGrid, loader: LoaderCircle, menu: Menu,
  monitor: Monitor, network: Network, play: Play, "scroll-text": ScrollText, "shield-check": ShieldCheck, sliders: SlidersHorizontal, square: Square,
  volume: Volume2, webhook: Webhook, x: X,
} as const;
export type IconName = keyof typeof ICONS;
