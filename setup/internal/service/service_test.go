package service

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var params = Params{
	Bun:       "/Users/me/.bun/bin/bun",
	SourceDir: "/Users/me/src/server os",
	Home:      "/Users/me/server-os & co",
	LogDir:    "/Users/me/server-os & co/logs",
	Path:      "/Users/me/.bun/bin:/usr/bin",
	Port:      3094,
}

func TestRenderLaunchd(t *testing.T) {
	u, err := Render("darwin", "/Users/me", params)
	if err != nil {
		t.Fatal(err)
	}
	if u.Kind != "launchd" || u.Path != "/Users/me/Library/LaunchAgents/dev.serveros.server.plist" {
		t.Fatalf("unit = %+v", u)
	}
	// Must be well-formed XML with the escaped values.
	d := xml.NewDecoder(strings.NewReader(u.Content))
	d.Strict = false
	for {
		if _, err := d.Token(); err != nil {
			if err.Error() == "EOF" {
				break
			}
			t.Fatalf("plist is not valid XML: %v\n%s", err, u.Content)
		}
	}
	for _, want := range []string{
		"<string>dev.serveros.server</string>",
		"<string>/Users/me/.bun/bin/bun</string>",
		"<string>server/index.ts</string>",
		"<string>/Users/me/src/server os</string>",
		"<string>/Users/me/server-os &amp; co</string>",
		"<key>PORT</key>\n    <string>3094</string>",
		"/Users/me/server-os &amp; co/logs/service.err.log",
		"<key>KeepAlive</key>",
	} {
		if !strings.Contains(u.Content, want) {
			t.Errorf("plist missing %q", want)
		}
	}
}

func TestRenderSystemd(t *testing.T) {
	p := params
	p.Home = "/home/me/100% dash"
	u, err := Render("linux", "/home/me", p)
	if err != nil {
		t.Fatal(err)
	}
	if u.Kind != "systemd" || u.Path != "/home/me/.config/systemd/user/server-os.service" {
		t.Fatalf("unit = %+v", u)
	}
	for _, want := range []string{
		`ExecStart="/Users/me/.bun/bin/bun" run server/index.ts`,
		`WorkingDirectory=/Users/me/src/server os`,
		`Environment="SERVER_OS_HOME=/home/me/100%% dash"`,
		"Environment=PORT=3094",
		"Restart=always",
		"WantedBy=default.target",
	} {
		if !strings.Contains(u.Content, want) {
			t.Errorf("unit missing %q:\n%s", want, u.Content)
		}
	}
}

func TestRenderUnknownOS(t *testing.T) {
	if _, err := Render("windows", "C:/", params); err == nil {
		t.Fatal("windows should be rejected")
	}
}

func TestTemplatesMatchInstallFolder(t *testing.T) {
	pairs := map[string]string{
		"templates/dev.serveros.server.plist.tmpl": "../../../install/launchd/dev.serveros.server.plist.tmpl",
		"templates/server-os.service.tmpl":         "../../../install/systemd/server-os.service.tmpl",
	}
	for embedded, canonical := range pairs {
		want, err := os.ReadFile(filepath.FromSlash(canonical))
		if err != nil {
			t.Skipf("repo install/ folder not found (%v)", err)
		}
		got, _ := templates.ReadFile(embedded)
		if string(got) != string(want) {
			t.Errorf("%s is out of sync with %s — copy install/ over setup/internal/service/templates/", embedded, canonical)
		}
	}
}

func TestServicePath(t *testing.T) {
	got := ServicePath("/u/.bun/bin/bun", "/u/.local/bin/claude", "", "/opt/homebrew/bin/brew")
	want := "/u/.bun/bin:/u/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	if got != want {
		t.Fatalf("got %s", got)
	}
}
