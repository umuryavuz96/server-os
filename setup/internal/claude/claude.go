// Package claude handles Claude Code: install it if missing and check that the user is logged in with
// their subscription. The wizard never sees, asks for or stores an API key — login is done by the user
// in their own terminal (`claude`, then /login).
package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/umuryavuz96/server-os/setup/internal/sys"
)

// InstallScript is Anthropic's native installer.
const InstallScript = "curl -fsSL https://claude.ai/install.sh | bash"

// NPMInstall is the npm alternative.
var NPMInstall = []string{"npm", "install", "-g", "@anthropic-ai/claude-code"}

// LoginHint tells the user how to log in themselves.
const LoginHint = "Open a terminal, run `claude` and log in with your Claude account (type /login if it doesn't ask)."

// InstallCommand picks how to install Claude Code: the native installer, or npm when curl is missing.
func InstallCommand() []string {
	if _, err := exec.LookPath("curl"); err == nil || sys.LookPath("npm") == "" {
		return []string{"bash", "-c", InstallScript}
	}
	return NPMInstall
}

// Login is the outcome of the headless check.
type Login struct {
	OK     bool
	Detail string // reply text, or why it failed
}

// VerifyLogin runs one headless turn (`claude -p "reply OK" --output-format json`) with a timeout.
// ANTHROPIC_API_KEY is removed from its environment, so this checks the subscription login and not a key
// that happens to be set in the shell.
func VerifyLogin(ctx context.Context, claudePath string, timeout time.Duration) Login {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, claudePath, "-p", "reply OK", "--output-format", "json")
	cmd.Env = withoutAPIKey(os.Environ())
	cmd.Stdin = nil
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return Login{Detail: fmt.Sprintf("no answer within %s", timeout)}
	}
	l := ParseHeadless(out.Bytes())
	if !l.OK && l.Detail == "" {
		msg := strings.TrimSpace(errb.String())
		if msg == "" && err != nil {
			msg = err.Error()
		}
		l.Detail = firstLine(msg)
	}
	return l
}

// ParseHeadless reads the JSON result of `claude -p --output-format json`.
func ParseHeadless(b []byte) Login {
	var r struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		IsError bool   `json:"is_error"`
		Result  string `json:"result"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(b), &r); err != nil || r.Type != "result" {
		return Login{}
	}
	if r.IsError || (r.Subtype != "" && r.Subtype != "success") {
		d := firstLine(r.Result)
		if d == "" {
			d = r.Subtype
		}
		return Login{Detail: d}
	}
	return Login{OK: true, Detail: firstLine(r.Result)}
}

func withoutAPIKey(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, "ANTHROPIC_API_KEY=") || strings.HasPrefix(kv, "ANTHROPIC_AUTH_TOKEN=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 160 {
		s = s[:157] + "…"
	}
	return s
}

// HandoverCommand is the shell line that starts the root agent.
func HandoverCommand(agentDir string) string {
	return "cd " + sys.ShellQuote(agentDir) + " && claude"
}

// OsascriptArgs returns the osascript arguments that open a new Terminal window running the agent.
func OsascriptArgs(agentDir string) []string {
	cmd := HandoverCommand(agentDir)
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(cmd)
	return []string{
		"-e", `tell application "Terminal" to do script "` + esc + `"`,
		"-e", `tell application "Terminal" to activate`,
	}
}

// OpenTerminal starts the agent in a new terminal window (macOS). On other systems it returns false
// and the caller prints HandoverCommand for the user.
func OpenTerminal(ctx context.Context, e *sys.Env, agentDir string) (bool, error) {
	if runtime.GOOS != "darwin" {
		return false, nil
	}
	if _, err := e.Run(ctx, "osascript", OsascriptArgs(agentDir)...); err != nil {
		return false, err
	}
	return true, nil
}
