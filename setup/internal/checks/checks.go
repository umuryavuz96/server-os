// Package checks inspects the machine (step 1 and `doctor`). Everything here is read-only.
package checks

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

type Status int

const (
	OK   Status = iota
	Warn        // optional thing missing, or worth a look
	Fail        // required thing missing
)

// Result is one line of the machine check.
type Result struct {
	Name     string
	Status   Status
	Detail   string // what we found
	Fix      string // what to do about it (empty when OK)
	Required bool
}

// Machine is everything later steps need to know about this computer.
type Machine struct {
	OS, Arch     string
	FreeBytes    uint64
	BrewPath     string
	BrewVersion  string
	DockerPath   string
	DockerVer    string
	TailscaleBin string
	TailscaleVer string
	TailnetName  string // MagicDNS name of this machine, e.g. home.tailnet.ts.net ("" when not logged in)
	BunPath      string
	BunVersion   string
	ClaudePath   string
	ClaudeVer    string
	Hostname     string
}

// MinFreeBytes is the free space below which the disk check warns.
const MinFreeBytes = 5 << 30

const qt = 5 * time.Second

// Inspect gathers facts about the machine. home is the folder whose disk is measured.
func Inspect(home string) Machine {
	m := Machine{OS: runtime.GOOS, Arch: runtime.GOARCH}
	m.Hostname, _ = os.Hostname()
	m.Hostname = strings.TrimSuffix(m.Hostname, ".local")
	m.FreeBytes = FreeBytes(existingParent(home))

	if m.BrewPath = sys.LookPath("brew", "/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"); m.BrewPath != "" {
		out, _ := sys.Query(15*time.Second, m.BrewPath, "--version")
		m.BrewVersion = ParseBrewVersion(out)
	}
	if m.DockerPath = sys.LookPath("docker", "/usr/local/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"); m.DockerPath != "" {
		out, _ := sys.Query(qt, m.DockerPath, "--version")
		m.DockerVer = ParseDockerVersion(out)
	}
	if m.TailscaleBin = sys.LookPath("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale"); m.TailscaleBin != "" {
		out, _ := sys.Query(qt, m.TailscaleBin, "version")
		m.TailscaleVer = ParseTailscaleVersion(out)
		if st, err := sys.Query(qt, m.TailscaleBin, "status", "--json"); err == nil {
			m.TailnetName = ParseTailscaleDNSName([]byte(st))
		}
	}
	m.BunPath, m.BunVersion = FindBun()
	m.ClaudePath, m.ClaudeVer = FindClaude()
	return m
}

// FindBun locates bun (PATH or the installer's ~/.bun/bin) and its version.
func FindBun() (path, version string) {
	if path = sys.LookPath("bun", "~/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"); path != "" {
		out, _ := sys.Query(qt, path, "--version")
		version = ParseBunVersion(out)
	}
	return
}

// FindClaude locates the Claude Code CLI (PATH or the native installer's locations) and its version.
func FindClaude() (path, version string) {
	if path = sys.LookPath("claude", "~/.local/bin/claude", "~/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"); path != "" {
		out, _ := sys.Query(10*time.Second, path, "--version")
		version = ParseClaudeVersion(out)
	}
	return
}

// Results turns the facts into the check list shown by the wizard and `doctor`.
func (m Machine) Results() []Result {
	var r []Result
	osName := map[string]string{"darwin": "macOS", "linux": "Linux"}[m.OS]
	if osName == "" {
		r = append(r, Result{Name: "Operating system", Status: Fail, Required: true, Detail: m.OS + "/" + m.Arch, Fix: "Server OS runs on macOS and Linux."})
	} else {
		r = append(r, Result{Name: "Operating system", Status: OK, Required: true, Detail: osName + " · " + m.Arch})
	}

	disk := Result{Name: "Free disk", Status: OK, Required: true, Detail: FormatBytes(m.FreeBytes) + " free"}
	if m.FreeBytes < MinFreeBytes {
		disk.Status, disk.Fix = Warn, "Less than "+FormatBytes(MinFreeBytes)+" free — apps and logs need room."
	}
	r = append(r, disk)

	r = append(r, tool("Bun", true, m.BunPath, m.BunVersion, "The wizard can install it: curl -fsSL https://bun.sh/install | bash"))
	r = append(r, tool("Claude Code", true, m.ClaudePath, m.ClaudeVer, "The wizard can install it: curl -fsSL https://claude.ai/install.sh | bash"))

	brewFix := "Optional. Recipes use it to install apps — see https://brew.sh"
	r = append(r, tool("Homebrew", false, m.BrewPath, m.BrewVersion, brewFix))
	r = append(r, tool("Docker", false, m.DockerPath, m.DockerVer, "Optional. Needed for Docker-based apps (Docker Desktop, OrbStack or docker-ce)."))

	ts := tool("Tailscale", false, m.TailscaleBin, m.TailscaleVer, "Optional, recommended: reach the panel from anywhere — https://tailscale.com/download")
	if m.TailscaleBin != "" {
		if m.TailnetName != "" {
			ts.Detail += " · " + m.TailnetName
		} else {
			ts.Status, ts.Detail, ts.Fix = Warn, ts.Detail+" · not logged in", "Run `tailscale up` to join your tailnet."
		}
	}
	r = append(r, ts)
	return r
}

func tool(name string, required bool, path, version, fix string) Result {
	if path == "" {
		st := Warn
		if required {
			st = Fail
		}
		return Result{Name: name, Status: st, Required: required, Detail: "not found", Fix: fix}
	}
	d := version
	if d == "" {
		d = "found"
	}
	return Result{Name: name, Status: OK, Required: required, Detail: d + " · " + path}
}

// RequiredMissing lists failed required checks.
func RequiredMissing(rs []Result) []Result {
	var out []Result
	for _, r := range rs {
		if r.Required && r.Status == Fail {
			out = append(out, r)
		}
	}
	return out
}

var semver = regexp.MustCompile(`\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.\-]+)?`)

// ParseBrewVersion: "Homebrew 4.4.2\n…" → "4.4.2".
func ParseBrewVersion(out string) string { return firstSemver(firstLine(out)) }

// ParseDockerVersion: "Docker version 27.3.1, build ce12230" → "27.3.1".
func ParseDockerVersion(out string) string { return firstSemver(firstLine(out)) }

// ParseBunVersion: "1.3.1" → "1.3.1".
func ParseBunVersion(out string) string { return firstSemver(firstLine(out)) }

// ParseClaudeVersion: "2.0.14 (Claude Code)" → "2.0.14".
func ParseClaudeVersion(out string) string { return firstSemver(firstLine(out)) }

// ParseTailscaleVersion: "1.76.1\n  tailscale commit: …" → "1.76.1".
func ParseTailscaleVersion(out string) string { return firstSemver(firstLine(out)) }

// ParseTailscaleDNSName pulls this machine's MagicDNS name out of `tailscale status --json`
// (trailing dot removed). Empty when logged out or the JSON is unexpected.
func ParseTailscaleDNSName(b []byte) string {
	var st struct {
		BackendState string
		Self         *struct{ DNSName string }
	}
	if json.Unmarshal(b, &st) != nil || st.Self == nil {
		return ""
	}
	if st.BackendState != "" && st.BackendState != "Running" {
		return ""
	}
	return strings.TrimSuffix(st.Self.DNSName, ".")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func firstSemver(s string) string { return semver.FindString(s) }

// FormatBytes renders a byte count in GB/MB with one decimal.
func FormatBytes(b uint64) string {
	switch {
	case b >= 1<<40:
		return fmt.Sprintf("%.1f TB", float64(b)/(1<<40))
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/(1<<30))
	default:
		return fmt.Sprintf("%.0f MB", float64(b)/(1<<20))
	}
}

// FreeBytes is the space available to this user on the disk holding path (0 on error).
func FreeBytes(path string) uint64 {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0
	}
	return uint64(st.Bavail) * uint64(st.Bsize) //nolint:unconvert // Bsize is uint32 on darwin, int64 on linux
}

func existingParent(p string) string {
	for p != "" && p != "/" {
		if sys.Exists(p) {
			return p
		}
		p = parentDir(p)
	}
	return "/"
}

func parentDir(p string) string {
	p = strings.TrimSuffix(p, "/")
	if i := strings.LastIndexByte(p, '/'); i > 0 {
		return p[:i]
	}
	return "/"
}

// PortState says who is on a TCP port on this machine.
type PortState int

const (
	PortFree       PortState = iota
	PortServerOS           // a Server OS already answers there
	PortTaken                // something else listens there
)

// ProbePort checks 127.0.0.1:port and, if something listens, whether it is Server OS (GET /api/v1/info).
// Returns the server name when it is Server OS.
func ProbePort(port int) (PortState, string) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	c, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		return PortFree, ""
	}
	c.Close()
	cl := http.Client{Timeout: 2 * time.Second}
	resp, err := cl.Get("http://" + addr + "/api/v1/info")
	if err != nil {
		return PortTaken, ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if name, ok := ParseInfo(b); ok {
		return PortServerOS, name
	}
	return PortTaken, ""
}

// ParseInfo recognises a Server OS /api/v1/info body and returns its name.
func ParseInfo(b []byte) (string, bool) {
	var info struct {
		Name string `json:"name"`
		API  string `json:"api"`
	}
	if json.Unmarshal(b, &info) != nil || info.API != "v1" {
		return "", false
	}
	return info.Name, true
}
