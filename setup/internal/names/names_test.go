package names

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

func TestValidSuffix(t *testing.T) {
	for _, ok := range []string{"home", "lan", "internal", "home.arpa", ".home"} {
		if err := ValidSuffix(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"local", "com", "", "Home Lab", "a..b", "-x"} {
		if ValidSuffix(bad) == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestHost(t *testing.T) {
	if h := Host(Setup{Suffix: "home"}, "jellyfin"); h != "jellyfin.home" {
		t.Fatal(h)
	}
	if h := Host(Setup{DNS: "sslip", IPs: []string{"192.168.1.5"}}, "x"); h != "x.192-168-1-5.sslip.io" {
		t.Fatal(h)
	}
}

func TestAppendLineIfMissing(t *testing.T) {
	d := t.TempDir()
	f := filepath.Join(d, "Caddyfile")
	os.WriteFile(f, []byte("http://a.home {\n\treverse_proxy localhost:1\n}"), 0o644)
	e := sys.New(false)
	if added, err := e.AppendLineIfMissing(f, "import /x/*.caddy"); err != nil || !added {
		t.Fatal(added, err)
	}
	if added, _ := e.AppendLineIfMissing(f, "import /x/*.caddy"); added {
		t.Fatal("added twice")
	}
	b, _ := os.ReadFile(f)
	if !strings.HasSuffix(string(b), "}\nimport /x/*.caddy\n") {
		t.Fatalf("%q", b)
	}
	if _, err := os.Stat(f + ".bak-server-os"); err != nil {
		t.Fatal("no backup")
	}
}

func TestSiteBlock(t *testing.T) {
	if !strings.Contains(SiteBlock("dash.home", 3094), "http://dash.home {\n\treverse_proxy localhost:3094\n}") {
		t.Fatal("bad block")
	}
}
