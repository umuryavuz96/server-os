// Recipes: one YAML manifest per installable app. The repo ships curated ones in
// recipes/; users add their own in <home>/config/recipes/. A recipe installs with Docker compose or Homebrew.
//
// Compose templates may use placeholders that the installer resolves:
//   {{data}}        the app's data folder (<home>/apps/<id>/data)
//   {{port:3001}}   a free host port, 3001 if it is free (the first one is the app's web port unless web.port says otherwise)
//   {{tz}} {{puid}} {{pgid}}   time zone and the server user's ids
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";

export interface Recipe {
  id: string; name: string; description: string; category: string;
  website?: string; repo?: string; logo?: string;
  platforms?: ("darwin" | "linux")[];
  /** linux: a compose used on Linux instead (e.g. host networking, which Docker Desktop on macOS lacks). */
  docker?: { compose: string; linux?: string };
  brew?: { formula: string; service?: boolean };
  cask?: { token: string };
  /** Where the app's web UI answers. port: a fixed host port (brew) — for compose, the first {{port:N}} by default. */
  web?: { port?: number; path?: string; https?: boolean };
  /** Shown to the owner after install. */
  notes?: string;
  /** First-run setup for the agent, in plain words or commands: create the admin user, close sign-ups, … */
  setup?: string;
}

export const RECIPE_DIRS = () => [join(import.meta.dir, "../../recipes"), join(dir("config"), "recipes")];

export function validateRecipe(r: Partial<Recipe>): string | null {
  if (!r.id || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(r.id)) return "id: lowercase letters, digits and dashes";
  if (!r.name) return "name is required";
  const kinds = [r.docker, r.brew, r.cask].filter(Boolean).length;
  if (kinds !== 1) return "exactly one of docker, brew or cask";
  if (r.docker && typeof r.docker.compose !== "string") return "docker.compose must be a YAML string";
  return null;
}

export function listRecipes(): Recipe[] {
  const out = new Map<string, Recipe>();
  for (const d of RECIPE_DIRS()) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      try {
        const r = Bun.YAML.parse(readFileSync(join(d, f), "utf8")) as Recipe;
        if (!validateRecipe(r) && (!r.platforms || r.platforms.includes(process.platform as "darwin"))) out.set(r.id, { ...r, category: r.category || "Other", description: r.description || "" });
      } catch { /* a broken user recipe never hides the others */ }
    }
  }
  return [...out.values()];
}
export const getRecipe = (id: string) => listRecipes().find((r) => r.id === id) ?? null;
