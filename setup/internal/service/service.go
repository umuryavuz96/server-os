// Package service renders and installs the Server OS background service: a launchd agent on macOS,
// a systemd user unit on Linux. Canonical templates live in install/{launchd,systemd}/ in the repo;
// templates/ here is a byte-for-byte copy (go:embed cannot reach outside the module) and a test keeps
// the two in sync.
package service

import (
	"bytes"
	"context"
	"embed"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

//go:embed templates/*.tmpl
var templates embed.FS

const (
	Label       = "dev.serveros.server"
	SystemdUnit = "server-os.service"
)

// Params fill the unit templates.
type Params struct {
	Label     string
	Bun       string // absolute path to bun
	SourceDir string // repo checkout holding server/index.ts
	Home      string // SERVER_OS_HOME
	LogDir    string
	Path      string // PATH for the service (bun, claude, brew, docker must be findable)
	Port      int
	Host      string // listen address: 0.0.0.0 to serve the LAN directly, 127.0.0.1 behind a proxy (Tailscale Serve / your own)
}

// Unit is a rendered service file and where it goes.
type Unit struct {
	Kind    string // launchd | systemd
	Path    string
	Content string
}

var funcs = template.FuncMap{
	"xml": func(s string) string {
		var b bytes.Buffer
		_ = xml.EscapeText(&b, []byte(s))
		return b.String()
	},
	// sd: escape systemd specifiers in a bare value.
	"sd": func(s string) string { return strings.ReplaceAll(s, "%", "%%") },
	// sdq: a double-quoted systemd word (spaces allowed), specifiers escaped.
	"sdq": func(s string) string {
		s = strings.ReplaceAll(s, `\`, `\\`)
		s = strings.ReplaceAll(s, `"`, `\"`)
		return `"` + strings.ReplaceAll(s, "%", "%%") + `"`
	},
}

// Render produces the unit for goos ("darwin" or "linux"). userHome is the user's home folder
// (where ~/Library/LaunchAgents or ~/.config/systemd/user live).
func Render(goos, userHome string, p Params) (Unit, error) {
	if p.Label == "" {
		p.Label = Label
	}
	var name, path, kind string
	switch goos {
	case "darwin":
		kind, name = "launchd", "dev.serveros.server.plist.tmpl"
		path = filepath.Join(userHome, "Library", "LaunchAgents", p.Label+".plist")
	case "linux":
		kind, name = "systemd", "server-os.service.tmpl"
		path = filepath.Join(userHome, ".config", "systemd", "user", SystemdUnit)
	default:
		return Unit{}, fmt.Errorf("no service manager for %s", goos)
	}
	src, err := templates.ReadFile("templates/" + name)
	if err != nil {
		return Unit{}, err
	}
	t, err := template.New(name).Funcs(funcs).Option("missingkey=error").Parse(string(src))
	if err != nil {
		return Unit{}, err
	}
	var b bytes.Buffer
	if err := t.Execute(&b, p); err != nil {
		return Unit{}, err
	}
	return Unit{Kind: kind, Path: path, Content: b.String()}, nil
}

// ServicePath builds the PATH the service runs with: the folders of the tools it needs first, then the
// usual system and Homebrew locations. Duplicates and empties are dropped.
func ServicePath(toolPaths ...string) string {
	var dirs []string
	for _, t := range toolPaths {
		if t != "" {
			dirs = append(dirs, filepath.Dir(t))
		}
	}
	dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")
	seen := map[string]bool{}
	out := dirs[:0]
	for _, d := range dirs {
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, ":")
}

// Install writes the unit if it is missing (an existing one is kept, even if it differs) and loads it
// unless it is already loaded. Returns a one-line summary.
func Install(ctx context.Context, e *sys.Env, u Unit) (string, error) {
	var summary string
	// past tense, or "would …" in dry-run
	did := func(verb string) string {
		if e.DryRun {
			return "would be " + verb
		}
		return verb
	}
	switch r, err := e.WriteIfMissing(u.Path, []byte(u.Content), 0o644); {
	case err != nil:
		return "", err
	case r == sys.Written:
		summary = "unit " + did("written")
	case r == sys.Unchanged:
		summary = "unit up to date"
	case r == sys.Kept:
		summary = "kept your edited unit"
		e.Log("kept " + u.Path + " (differs from the template; not overwritten)")
	}

	switch u.Kind {
	case "launchd":
		domain := fmt.Sprintf("gui/%d", os.Getuid())
		label := strings.TrimSuffix(filepath.Base(u.Path), ".plist")
		// Read-only probe, also in dry-run.
		if _, err := sys.Query(5*time.Second, "launchctl", "print", domain+"/"+label); err == nil {
			e.Log(label + " is already loaded")
			return summary + " · already loaded", nil
		}
		if out, err := e.Run(ctx, "launchctl", "bootstrap", domain, u.Path); err != nil {
			return summary, fmt.Errorf("launchctl bootstrap: %v %s", err, out)
		}
		return summary + " · " + did("loaded"), nil
	case "systemd":
		if out, err := e.Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
			return summary, fmt.Errorf("systemctl daemon-reload: %v %s", err, out)
		}
		if out, err := e.Run(ctx, "systemctl", "--user", "enable", "--now", SystemdUnit); err != nil {
			return summary, fmt.Errorf("systemctl enable: %v %s", err, out)
		}
		return summary + " · " + did("enabled"), nil
	}
	return summary, fmt.Errorf("unknown unit kind %q", u.Kind)
}
