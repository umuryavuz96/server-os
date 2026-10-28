// Discover genres: a small, fixed set of shelves above the ~100 categories the sources use
// (awesome-selfhosted tags, CasaOS and LinuxServer categories). Each category is matched to the first genre
// whose words it contains — order matters ("Video Surveillance" is Smart Home, not Media); the category itself
// stays as the genre's sub-shelf.

export interface Genre { id: string; label: string; blurb: string; icon: string; words: string[] }

export const GENRES: Genre[] = [
  { id: "home", label: "Smart Home", icon: "home", blurb: "Control lights, sensors and cameras locally, without the vendor clouds.",
    words: ["internet of things", "iot", "home", "surveillance", "camera"] },
  { id: "media", label: "Movies, TV & Music", icon: "film", blurb: "Stream your own library, request and organise films, series, music and audiobooks.",
    words: ["media", "music", "audiobook", "books", "ebook", "video", "audio", "downloader", "indexer", "podcast", "stream"] },
  { id: "photos", label: "Photos", icon: "image", blurb: "Back up phone photos, browse galleries and edit images.",
    words: ["photo", "image", "galler"] },
  { id: "files", label: "Files & Backup", icon: "folder", blurb: "Your own cloud drive, sync between devices, share files and keep backups.",
    words: ["file", "ftp", "storage", "backup", "cloud", "sync"] },
  { id: "docs", label: "Notes & Documents", icon: "doc", blurb: "Notes, wikis, scanned paperwork, office documents, bookmarks and reading lists.",
    words: ["document", "note", "wiki", "knowledge", "office", "pastebin", "archiv", "bookmark", "feed", "rss", "reader"] },
  { id: "productivity", label: "Productivity & Automation", icon: "check", blurb: "Tasks, calendars, time tracking, recipes, inventory and workflows that run themselves.",
    words: ["task", "to-do", "productivity", "calendar", "contact", "time tracking", "poll", "event", "booking", "scheduling", "groupware", "recipe", "inventory", "automation", "health", "fitness", "travel", "family"] },
  { id: "chat", label: "Chat & Social", icon: "chat", blurb: "Messaging, video calls, email, forums and your own social network.",
    words: ["communication", "chat", "irc", "email", "social", "conference", "forum"] },
  { id: "ai", label: "AI", icon: "spark", blurb: "Run language and image models on your own hardware, with chat front-ends and tools.",
    words: ["artificial intelligence", "genai", "machine learning", "ai"] },
  { id: "dev", label: "Developer Tools", icon: "code", blurb: "Git hosting, CI, databases, code editors and API tools.",
    words: ["software development", "developer", "programming", "database", "docker", "web tools"] },
  { id: "network", label: "Network & Security", icon: "shield", blurb: "Password managers, ad blocking, DNS, VPNs, proxies and remote access.",
    words: ["password", "network", "dns", "proxy", "remote", "vpn", "security", "web server", "browser"] },
  { id: "server", label: "Dashboards & Monitoring", icon: "gauge", blurb: "Keep an eye on the server: uptime, analytics, status pages and start pages.",
    words: ["monitoring", "analytics", "dashboard", "self-hosting", "administration"] },
  { id: "web", label: "Websites & Learning", icon: "globe", blurb: "Blogs, websites, link shorteners, maps and online courses.",
    words: ["content management", "cms", "blog", "url shortener", "learning", "course", "maps", "gps", "science", "search engine"] },
  { id: "business", label: "Money & Business", icon: "coin", blurb: "Budgets, invoices, shops, CRM, tickets and planning for a small business.",
    words: ["money", "budget", "finance", "e-commerce", "customer", "crm", "human resources", "resource planning", "ticket", "manufactur", "agriculture"] },
  { id: "games", label: "Games & Making", icon: "game", blurb: "Game servers, retro emulators, 3D printing and modelling.",
    words: ["game", "3d"] },
  { id: "other", label: "Everything else", icon: "dots", blurb: "Everything that doesn't fit a shelf yet.", words: [] },
];

const cache = new Map<string, string>();
/** The genre id for a category (or sub-category text). Whole-word match for short words like "ai". */
export function genreOf(category: string): string {
  const c = category.toLowerCase();
  const hit = cache.get(c);
  if (hit) return hit;
  const g = GENRES.find((g) => g.words.some((w) => (w.length <= 3 ? new RegExp(`\\b${w}\\b`).test(c) : c.includes(w))))?.id ?? "other";
  cache.set(c, g);
  return g;
}
export const getGenre = (id: string) => GENRES.find((g) => g.id === id) ?? null;
