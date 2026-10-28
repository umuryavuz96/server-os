// Package layout creates the Server OS home folder and its config file.
// It mirrors server/core/config.ts: same folders, same YAML keys, plus `port` and `reach` for the wizard.
package layout

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

// Dirs are the home folder's top-level folders — keep in sync with DIRS in server/core/config.ts.
var Dirs = []string{"config", "agent", "apps", "jobs", "dashboards", "logs", "data"}

// Reach modes (plan §10).
const (
	ReachTailscale = "tailscale"
	ReachLocal     = "local"
	ReachPublic    = "public"
)

const DefaultPort = 3094

// Config is what the wizard asks for and writes into config/server-os.yaml.
type Config struct {
	Name  string
	Reach string // tailscale | local | public
	Auth  string // off | token
	Port  int
	URL   string // public URL (reach=public only)
	Names *Names // optional local names for apps (jellyfin.home)
}

// Names mirrors the server's `names:` block (server/modules/names.ts).
type Names struct {
	Suffix     string
	DNS        string // adguard | wildcard | sslip
	IPs        []string
	Caddyfile  string
	AdGuardURL string
	EnvFile    string // AdGuard credentials (0600), never in the config itself
}

// DefaultAuth: Tailscale already limits who can reach the server, so auth can stay off there;
// anything else gets device tokens.
// DefaultAuth is always "token": the panel asks for the owner account on first visit, and devices connect from there.
func DefaultAuth(reach string) string {
	return "token"
}

// ConfigPath is <home>/config/server-os.yaml (or the older server-dash.yaml when only that exists).
func ConfigPath(home string) string {
	p := filepath.Join(home, "config", "server-os.yaml")
	if old := filepath.Join(home, "config", "server-dash.yaml"); !sys.Exists(p) && sys.Exists(old) {
		return old // pre-rename name
	}
	return p
}

// AdminKeyPath is <home>/data/admin.key — the local key the server and CLI use to open pairing.
func AdminKeyPath(home string) string { return filepath.Join(home, "data", "admin.key") }

// RenderConfig produces the YAML file. Keys match server/core/config.ts (name, auth, logging) + port, reach.
func RenderConfig(c Config) string {
	var b strings.Builder
	b.WriteString("# Server OS configuration\n")
	fmt.Fprintf(&b, "name: %s\n\n", yamlString(c.Name))
	b.WriteString("# off: anyone who can reach the server can use it (fine behind Tailscale).\n")
	b.WriteString("# token: only paired devices (run `server-os pair`).\n")
	fmt.Fprintf(&b, "auth: %s\n\n", c.Auth)
	b.WriteString("# How the apps reach this server: tailscale | local | public\n")
	fmt.Fprintf(&b, "reach: %s\n", c.Reach)
	if c.URL != "" {
		fmt.Fprintf(&b, "url: %s     # public address (your own proxy or tunnel)\n", yamlString(c.URL))
	}
	fmt.Fprintf(&b, "port: %d\n\n", c.Port)
	if c.Names != nil {
		b.WriteString(NamesBlock(c.Names) + "\n")
	}
	b.WriteString("logging:\n")
	b.WriteString("  level: info      # debug | info | warn | error\n")
	b.WriteString("  maxFileMB: 10    # logs/server.jsonl rotates at this size\n")
	return b.String()
}

var plainYAML = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:-]*$`)

func yamlString(s string) string {
	if plainYAML.MatchString(s) && !isYAMLKeyword(s) {
		return s
	}
	return strconv.Quote(s) // a Go-quoted string is a valid YAML double-quoted scalar for printable text
}

func isYAMLKeyword(s string) bool {
	switch strings.ToLower(s) {
	case "true", "false", "yes", "no", "on", "off", "null", "~":
		return true
	}
	_, err := strconv.ParseFloat(s, 64)
	return err == nil
}

// ReadConfig reads the top-level scalar keys back from an existing config, so a re-run offers the
// user's current values as defaults. Missing keys stay zero. ok=false when there is no file.
func ReadConfig(home string) (Config, bool) {
	f, err := os.Open(ConfigPath(home))
	if err != nil {
		return Config{}, false
	}
	defer f.Close()
	var c Config
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' {
			continue // only top-level keys
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = scalar(v)
		switch strings.TrimSpace(k) {
		case "name":
			c.Name = v
		case "auth":
			c.Auth = v
		case "reach":
			c.Reach = v
		case "url":
			c.URL = v
		case "port":
			c.Port, _ = strconv.Atoi(v)
		}
	}
	return c, true
}

func scalar(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, `"`) {
		if s, err := strconv.Unquote(v[:closingQuote(v)+1]); err == nil {
			return s
		}
	}
	if strings.HasPrefix(v, "'") {
		if end := strings.Index(v[1:], "'"); end >= 0 {
			return v[1 : end+1]
		}
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

func closingQuote(v string) int {
	for i := 1; i < len(v); i++ {
		if v[i] == '\\' {
			i++
			continue
		}
		if v[i] == '"' {
			return i
		}
	}
	return len(v) - 1
}

// Apply lays out <home>: the folders, the config file and the admin key. Idempotent — existing files are
// kept as they are. Returns one human line per thing it created (or would create in dry-run).
func Apply(e *sys.Env, home string, c Config) ([]string, error) {
	var made []string
	if _, err := e.MkdirAll(home, 0o755); err != nil {
		return made, err
	}
	for _, d := range Dirs {
		perm := fs.FileMode(0o755)
		if d == "data" {
			perm = 0o700 // devices, tokens, admin key
		}
		p := filepath.Join(home, d)
		created, err := e.MkdirAll(p, perm)
		if err != nil {
			return made, err
		}
		if created {
			made = append(made, d+"/")
		}
	}

	switch r, err := e.WriteIfMissing(ConfigPath(home), []byte(RenderConfig(c)), 0o644); {
	case err != nil:
		return made, err
	case r == sys.Written:
		made = append(made, "config/server-os.yaml")
	case r == sys.Kept:
		e.Log("kept your config/server-os.yaml (not overwritten)")
	}

	key, err := NewAdminKey()
	if err != nil {
		return made, err
	}
	if r, err := e.WriteIfMissing(AdminKeyPath(home), []byte(key+"\n"), 0o600); err != nil {
		return made, err
	} else if r == sys.Written {
		made = append(made, "data/admin.key")
	}
	return made, nil
}

// NewAdminKey makes a key in the same format as server/core/devices.ts: 32 random bytes, base64url, no padding.
func NewAdminKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// CopyKit copies the agent kit from src into dst, file by file, skipping any file that already exists
// in dst (the user or the agent may have edited it). Returns the files it copied. A missing src is not
// an error — it returns (nil, nil).
func CopyKit(e *sys.Env, src, dst string) ([]string, error) {
	if st, err := os.Stat(src); err != nil || !st.IsDir() {
		return nil, nil
	}
	var copied []string
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			_, err := e.MkdirAll(filepath.Join(dst, rel), 0o755)
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		info, _ := d.Info()
		r, err := e.WriteIfMissing(filepath.Join(dst, rel), data, info.Mode().Perm())
		if err != nil {
			return err
		}
		if r == sys.Written {
			copied = append(copied, rel)
		}
		return nil
	})
	return copied, err
}

// NamesBlock is the config's `names:` section.
func NamesBlock(n *Names) string {
	var b strings.Builder
	b.WriteString("# Local names for apps: every app the panel installs gets http://<app>." + n.Suffix + "\n")
	b.WriteString("names:\n")
	fmt.Fprintf(&b, "  suffix: %s\n", yamlString(n.Suffix))
	fmt.Fprintf(&b, "  dns: %s          # adguard | wildcard | sslip\n", n.DNS)
	fmt.Fprintf(&b, "  caddyfile: %s\n", yamlString(n.Caddyfile))
	ips := make([]string, len(n.IPs))
	for i, ip := range n.IPs {
		ips[i] = yamlString(ip)
	}
	fmt.Fprintf(&b, "  ips: [%s]\n", strings.Join(ips, ", "))
	if n.DNS == "adguard" {
		fmt.Fprintf(&b, "  adguard: { url: %s, envFile: %s }\n", yamlString(n.AdGuardURL), yamlString(n.EnvFile))
	}
	return b.String()
}
