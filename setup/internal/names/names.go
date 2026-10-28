// Package names sets up the optional "local names" for apps (jellyfin.home): Caddy as the reverse proxy, one
// snippet per app in <home>/data/caddy/, the main Caddyfile importing that folder, and DNS from AdGuard Home
// rewrites, a wildcard the owner points at this server once, or sslip.io names that need no DNS at all.
// The server's names module (server/modules/names.ts) adds and removes app names after this.
package names

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

// Setup is what the wizard asked.
type Setup struct {
	Suffix                   string   // "home" → jellyfin.home
	DNS                      string   // adguard | wildcard | sslip
	IPs                      []string // LAN first, then the Tailscale address
	Caddyfile                string
	AdGuardURL               string
	AdGuardUser, AdGuardPass string
}

var suffixRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){0,2}$`)

// ValidSuffix accepts names like home, lan, internal, home.arpa. Never local (Bonjour) or a public suffix people own.
func ValidSuffix(s string) error {
	s = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), ".")
	switch {
	case !suffixRe.MatchString(s):
		return errors.New("letters, digits and dashes, like home or lan")
	case s == "local":
		return errors.New(".local belongs to Bonjour on Macs and iPhones — pick home or lan")
	case s == "com" || s == "net" || s == "org" || s == "io" || s == "dev" || s == "app":
		return errors.New("that's a public ending — names there belong to other people")
	}
	return nil
}

// Suggestions offered in the form, best first.
var Suggestions = []string{"home", "lan", "internal", "home.arpa"}

// Host is the name an app gets.
func Host(s Setup, id string) string {
	if s.DNS == "sslip" {
		ip := "127.0.0.1"
		if len(s.IPs) > 0 {
			ip = s.IPs[0]
		}
		return id + "." + strings.ReplaceAll(ip, ".", "-") + ".sslip.io"
	}
	return id + "." + strings.TrimPrefix(s.Suffix, ".")
}

// SnippetDir holds one Caddy site per app; the main Caddyfile imports it.
func SnippetDir(home string) string { return filepath.Join(home, "data", "caddy") }

// ImportLine is what the main Caddyfile needs.
func ImportLine(home string) string { return "import " + filepath.Join(SnippetDir(home), "*.caddy") }

// SiteBlock is one app's Caddy site (plain http on a private network; Tailscale Serve or a proxy adds https).
func SiteBlock(host string, port int) string {
	return fmt.Sprintf("# Server OS name — written by server-os-setup\nhttp://%s {\n\treverse_proxy localhost:%d\n}\n", host, port)
}

// DefaultCaddyfile is where Caddy's own service reads its config on this platform.
func DefaultCaddyfile(brewPath string) string {
	if runtime.GOOS == "darwin" {
		if strings.HasPrefix(brewPath, "/usr/local") {
			return "/usr/local/etc/Caddyfile"
		}
		return "/opt/homebrew/etc/Caddyfile"
	}
	return "/etc/caddy/Caddyfile"
}

// LANIP is the first private IPv4 address of an interface that is up.
func LANIP() string {
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && ipn.IP.IsPrivate() {
				return ipn.IP.String()
			}
		}
	}
	return ""
}

// TailscaleIP is this machine's tailnet IPv4 address ("" without Tailscale).
func TailscaleIP() string {
	out, err := sys.Query(5*time.Second, "tailscale", "ip", "-4")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.Split(out, "\n")[0])
}

// AdGuardRunning: something answers AdGuard Home's admin API on this machine.
func AdGuardRunning(url string) bool {
	c := http.Client{Timeout: 2 * time.Second}
	r, err := c.Get(strings.TrimSuffix(url, "/") + "/control/status")
	if err != nil {
		return false
	}
	r.Body.Close()
	return r.StatusCode == 401 || r.StatusCode == 200 || r.StatusCode == 403
}

// Apply makes names work: Caddy installed and running, the import line in the Caddyfile, the snippet folder, the
// panel's own name (dash.<suffix>), AdGuard credentials kept for the server (0600) and its rewrites.
func Apply(ctx context.Context, e *sys.Env, home string, panelPort int, s Setup, brewPath string, log func(string)) (string, error) {
	caddy := sys.LookPath("caddy", "/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy")
	if caddy == "" {
		switch {
		case brewPath != "":
			if out, err := e.Run(ctx, brewPath, "install", "caddy"); err != nil {
				return "", fmt.Errorf("brew install caddy failed: %s", lastLine(out))
			}
			caddy = "caddy"
		case runtime.GOOS == "linux":
			return "", errors.New("install Caddy first (https://caddyserver.com/docs/install), then run the setup again")
		default:
			return "", errors.New("install Homebrew or Caddy first, then run the setup again")
		}
	}
	if _, err := e.WriteIfMissing(s.Caddyfile, []byte("# Caddy — Server OS adds one file per app in the folder imported below.\n"), 0o644); err != nil {
		return "", err
	}
	if _, err := e.AppendLineIfMissing(s.Caddyfile, ImportLine(home)); err != nil && !e.DryRun {
		return "", fmt.Errorf("can't edit %s: %w", s.Caddyfile, err)
	}
	if _, err := e.MkdirAll(SnippetDir(home), 0o755); err != nil {
		return "", err
	}
	panel := Host(s, "dash")
	if _, err := e.WriteIfMissing(filepath.Join(SnippetDir(home), "dash.caddy"), []byte(SiteBlock(panel, panelPort)), 0o644); err != nil {
		return "", err
	}
	if s.DNS == "adguard" {
		env := fmt.Sprintf("ADGUARD_USER=%s\nADGUARD_PASSWORD=%s\n", s.AdGuardUser, s.AdGuardPass)
		if _, err := e.WriteIfMissing(filepath.Join(home, "data", "names.env"), []byte(env), 0o600); err != nil {
			return "", err
		}
		for _, ip := range s.IPs {
			if err := adguardRewrite(e, s, panel, ip); err != nil {
				log("AdGuard: " + err.Error())
			}
		}
	}
	// Caddy's own service, so names survive a reboot — unless a Caddy already runs (its admin API answers).
	if caddyRunning() {
		log("Caddy is already running — reloading it")
	} else if runtime.GOOS == "darwin" && brewPath != "" {
		_, _ = e.Run(ctx, brewPath, "services", "start", "caddy")
	} else if runtime.GOOS == "linux" {
		if os.Geteuid() == 0 {
			_, _ = e.Run(ctx, "systemctl", "enable", "--now", "caddy")
		} else {
			log("start Caddy's service once: sudo systemctl enable --now caddy")
		}
	}
	if out, err := e.Run(ctx, caddy, "validate", "--config", s.Caddyfile, "--adapter", "caddyfile"); err != nil {
		return "", fmt.Errorf("Caddy doesn't accept the config: %s", lastLine(out))
	}
	if out, err := e.Run(ctx, caddy, "reload", "--config", s.Caddyfile, "--adapter", "caddyfile"); err != nil {
		log("Caddy reload: " + lastLine(out) + " (it picks the names up when its service starts)")
	}
	return "http://" + panel, nil
}

func caddyRunning() bool {
	r, err := (&http.Client{Timeout: 2 * time.Second}).Get("http://localhost:2019/config/")
	if err != nil {
		return false
	}
	r.Body.Close()
	return true
}

func adguardRewrite(e *sys.Env, s Setup, host, ip string) error {
	if e.DryRun {
		e.Log(fmt.Sprintf("would add AdGuard rewrite %s → %s", host, ip))
		return nil
	}
	body, _ := json.Marshal(map[string]string{"domain": host, "answer": ip})
	req, _ := http.NewRequest("POST", strings.TrimSuffix(s.AdGuardURL, "/")+"/control/rewrite/add", bytes.NewReader(body))
	req.SetBasicAuth(s.AdGuardUser, s.AdGuardPass)
	req.Header.Set("Content-Type", "application/json")
	r, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode >= 300 {
		return fmt.Errorf("rewrite %s → %s: HTTP %d", host, ip, r.StatusCode)
	}
	return nil
}

func lastLine(s string) string {
	l := strings.Split(strings.TrimSpace(s), "\n")
	return l[len(l)-1]
}
