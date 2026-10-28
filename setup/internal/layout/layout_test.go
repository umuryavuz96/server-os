package layout

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

var cfg = Config{Name: "box", Reach: ReachLocal, Auth: "token", Port: 3094}

func TestApplyCreatesLayout(t *testing.T) {
	home := filepath.Join(t.TempDir(), "server-os")
	made, err := Apply(sys.New(false), home, cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range Dirs {
		if st, err := os.Stat(filepath.Join(home, d)); err != nil || !st.IsDir() {
			t.Errorf("missing folder %s", d)
		}
	}
	if st, _ := os.Stat(filepath.Join(home, "data")); st.Mode().Perm() != 0o700 {
		t.Errorf("data/ should be 0700, is %v", st.Mode().Perm())
	}
	key, err := os.ReadFile(AdminKeyPath(home))
	if err != nil || len(strings.TrimSpace(string(key))) != 43 {
		t.Fatalf("admin key: %q %v", key, err)
	}
	if st, _ := os.Stat(AdminKeyPath(home)); st.Mode().Perm() != 0o600 {
		t.Errorf("admin.key should be 0600, is %v", st.Mode().Perm())
	}
	if len(made) != len(Dirs)+2 {
		t.Errorf("made = %v", made)
	}
}

func TestApplyIsIdempotentAndKeepsUserEdits(t *testing.T) {
	home := t.TempDir()
	e := sys.New(false)
	if _, err := Apply(e, home, cfg); err != nil {
		t.Fatal(err)
	}
	edited := "name: mine\nauth: off\n# my notes\n"
	if err := os.WriteFile(ConfigPath(home), []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	key1, _ := os.ReadFile(AdminKeyPath(home))

	made, err := Apply(e, home, Config{Name: "other", Reach: ReachPublic, Auth: "token", Port: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(made) != 0 {
		t.Fatalf("second run created %v", made)
	}
	if b, _ := os.ReadFile(ConfigPath(home)); string(b) != edited {
		t.Fatalf("config overwritten: %q", b)
	}
	if key2, _ := os.ReadFile(AdminKeyPath(home)); string(key1) != string(key2) {
		t.Fatal("admin key rotated on re-run")
	}
}

func TestApplyRepairsMissingFolder(t *testing.T) {
	home := t.TempDir()
	e := sys.New(false)
	Apply(e, home, cfg)
	os.RemoveAll(filepath.Join(home, "jobs"))
	made, _ := Apply(e, home, cfg)
	if len(made) != 1 || made[0] != "jobs/" {
		t.Fatalf("repair made %v", made)
	}
}

func TestApplyDryRunWritesNothing(t *testing.T) {
	home := filepath.Join(t.TempDir(), "sd")
	made, err := Apply(sys.New(true), home, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if sys.Exists(home) {
		t.Fatal("dry-run created the home folder")
	}
	if len(made) != len(Dirs)+2 {
		t.Fatalf("dry-run should report the full plan, got %v", made)
	}
}

func TestRenderConfigRoundTrip(t *testing.T) {
	c := Config{Name: "My Server", Reach: ReachPublic, Auth: "token", Port: 8080, URL: "https://dash.example.com"}
	y := RenderConfig(c)
	for _, want := range []string{`name: "My Server"`, "auth: token", "reach: public", "port: 8080", "url: https://dash.example.com", "logging:", "  level: info", "  maxFileMB: 10"} {
		if !strings.Contains(y, want) {
			t.Errorf("config missing %q:\n%s", want, y)
		}
	}
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, "config"), 0o755)
	os.WriteFile(ConfigPath(home), []byte(y), 0o644)
	got, ok := ReadConfig(home)
	if !ok || got != c {
		t.Fatalf("round trip: got %+v want %+v", got, c)
	}
}

func TestRenderConfigQuotesKeywords(t *testing.T) {
	for _, name := range []string{"yes", "off", "123", "a: b", "#x"} {
		y := RenderConfig(Config{Name: name, Reach: ReachLocal, Auth: "token", Port: 1})
		if !strings.Contains(y, "name: \"") {
			t.Errorf("name %q should be quoted:\n%s", name, y)
		}
	}
	if y := RenderConfig(Config{Name: "home-server", Reach: ReachTailscale, Auth: "off", Port: 3094}); !strings.Contains(y, "name: home-server\n") {
		t.Errorf("plain hostname should not be quoted:\n%s", y)
	}
}

func TestReadConfigServerTemplate(t *testing.T) {
	// The template server/core/config.ts writes (no port/reach yet) must read back cleanly.
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, "config"), 0o755)
	os.WriteFile(ConfigPath(home), []byte("# Server OS configuration\nname: box\n\nauth: off\n\nlogging:\n  level: info      # x\n  maxFileMB: 10\n"), 0o644)
	got, ok := ReadConfig(home)
	if !ok || got.Name != "box" || got.Auth != "off" || got.Port != 0 || got.Reach != "" {
		t.Fatalf("got %+v", got)
	}
	if _, ok := ReadConfig(filepath.Join(home, "nope")); ok {
		t.Fatal("missing file reported ok")
	}
}

func TestDefaultAuth(t *testing.T) {
	// Every reach mode starts with the owner account on: Tailscale only narrows who can reach the panel.
	if DefaultAuth(ReachTailscale) != "token" || DefaultAuth(ReachLocal) != "token" || DefaultAuth(ReachPublic) != "token" {
		t.Fatal("auth defaults wrong")
	}
}

func TestCopyKit(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(src, ".claude", "skills"), 0o755)
	os.WriteFile(filepath.Join(src, "CLAUDE.md"), []byte("template"), 0o644)
	os.WriteFile(filepath.Join(src, ".claude", "skills", "a.md"), []byte("skill"), 0o644)
	os.WriteFile(filepath.Join(dst, "CLAUDE.md"), []byte("user edited"), 0o644)

	copied, err := CopyKit(sys.New(false), src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if len(copied) != 1 || copied[0] != filepath.Join(".claude", "skills", "a.md") {
		t.Fatalf("copied %v", copied)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "CLAUDE.md")); string(b) != "user edited" {
		t.Fatal("kit copy overwrote the user's CLAUDE.md")
	}
	if c, err := CopyKit(sys.New(false), filepath.Join(src, "missing"), dst); err != nil || c != nil {
		t.Fatalf("missing kit: %v %v", c, err)
	}
}
