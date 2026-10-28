import { describe, expect, test } from "bun:test";
import { matches, tokens } from "./logins";

describe("which ~/.env passwords belong to an app", () => {
  test("first word of the variable against the app's words", () => {
    expect(matches("JELLYFIN_ADMIN_PASSWORD", tokens("Jellyfin"))).toBe(true);
    expect(matches("QBIT_PASSWORD", tokens("qBittorrent"))).toBe(true);
    expect(matches("ADGUARD_PASSWORD", tokens("AdGuard Home", ["adguard"]))).toBe(true);
  });
  test("an app of short words matches its words run together", () => {
    expect(tokens("Ege Log")).toContain("egelog");
    expect(matches("EGE_LOG_PASSWORD", tokens("Ege Log"))).toBe(true);
  });
  test("other apps' passwords don't match", () => {
    expect(matches("JELLYFIN_ADMIN_PASSWORD", tokens("Ege Log"))).toBe(false);
    expect(matches("SUDO_PASSWORD", tokens("Uptime Kuma"))).toBe(false);
    expect(matches("M2_PASSWORD", tokens("Minecraft Server"))).toBe(false);
  });
});
