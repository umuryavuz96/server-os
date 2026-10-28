package checks

import "testing"

func TestVersionParsers(t *testing.T) {
	cases := []struct {
		name string
		fn   func(string) string
		in   string
		want string
	}{
		{"brew", ParseBrewVersion, "Homebrew 4.4.2\nHomebrew/homebrew-core (git revision 1)", "4.4.2"},
		{"brew-dev", ParseBrewVersion, "Homebrew 4.4.2-52-g1a2b3c4\n", "4.4.2-52-g1a2b3c4"},
		{"docker", ParseDockerVersion, "Docker version 27.3.1, build ce12230", "27.3.1"},
		{"bun", ParseBunVersion, "1.3.1\n", "1.3.1"},
		{"claude", ParseClaudeVersion, "2.0.14 (Claude Code)", "2.0.14"},
		{"tailscale", ParseTailscaleVersion, "1.76.1\n  tailscale commit: abc\n  go version: go1.23", "1.76.1"},
		{"empty", ParseBunVersion, "", ""},
		{"garbage", ParseDockerVersion, "command not found", ""},
	}
	for _, c := range cases {
		if got := c.fn(c.in); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestParseTailscaleDNSName(t *testing.T) {
	running := `{"BackendState":"Running","Self":{"DNSName":"home.tail1234.ts.net.","HostName":"home"}}`
	if got := ParseTailscaleDNSName([]byte(running)); got != "home.tail1234.ts.net" {
		t.Fatalf("running: got %q", got)
	}
	stopped := `{"BackendState":"NeedsLogin","Self":{"DNSName":""}}`
	if got := ParseTailscaleDNSName([]byte(stopped)); got != "" {
		t.Fatalf("logged out: got %q", got)
	}
	if got := ParseTailscaleDNSName([]byte("not json")); got != "" {
		t.Fatalf("garbage: got %q", got)
	}
}

func TestParseInfo(t *testing.T) {
	if name, ok := ParseInfo([]byte(`{"name":"box","version":"0.1.0","api":"v1"}`)); !ok || name != "box" {
		t.Fatalf("got %q %v", name, ok)
	}
	if _, ok := ParseInfo([]byte(`{"status":"ok"}`)); ok {
		t.Fatal("foreign JSON recognised as Server OS")
	}
}

func TestResults(t *testing.T) {
	m := Machine{OS: "darwin", Arch: "arm64", FreeBytes: 100 << 30, BunPath: "/b/bun", BunVersion: "1.3.1", TailscaleBin: "/t", TailscaleVer: "1.76.1"}
	rs := m.Results()
	missing := RequiredMissing(rs)
	if len(missing) != 1 || missing[0].Name != "Claude Code" {
		t.Fatalf("want only Claude Code missing, got %+v", missing)
	}
	for _, r := range rs {
		if r.Name == "Tailscale" && r.Status != Warn {
			t.Fatalf("logged-out tailscale should warn: %+v", r)
		}
		if r.Name == "Docker" && r.Status != Warn {
			t.Fatalf("missing docker is optional: %+v", r)
		}
	}
	m.OS = "windows"
	if RequiredMissing(m.Results())[0].Name != "Operating system" {
		t.Fatal("windows should fail the OS check")
	}
}

func TestFormatBytes(t *testing.T) {
	if got := FormatBytes(5 << 30); got != "5.0 GB" {
		t.Fatal(got)
	}
	if got := FormatBytes(512 << 20); got != "512 MB" {
		t.Fatal(got)
	}
}
