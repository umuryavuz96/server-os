// Package sys is the wizard's only way to change the machine. Every mutation goes through Env, so
// --dry-run can print each action instead of doing it, and every file write is "create if missing" —
// the wizard repairs, it never overwrites what the user changed.
package sys

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Env carries the run mode and a log sink for the step that is currently running.
type Env struct {
	DryRun bool
	// Log receives one line per action ("mkdir …", "would write …"). Never nil after New.
	Log func(string)
}

func New(dry bool) *Env { return &Env{DryRun: dry, Log: func(string) {}} }

// WithLog returns a copy of the env that logs to fn (used per wizard step).
func (e *Env) WithLog(fn func(string)) *Env {
	c := *e
	c.Log = fn
	return &c
}

func (e *Env) logf(format string, a ...any) { e.Log(fmt.Sprintf(format, a...)) }

// Exists reports whether path exists (any type).
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// MkdirAll creates dir (and parents) if missing. Returns true when it created (or would create) it.
func (e *Env) MkdirAll(dir string, perm fs.FileMode) (bool, error) {
	if st, err := os.Stat(dir); err == nil {
		if !st.IsDir() {
			return false, fmt.Errorf("%s exists and is not a folder", dir)
		}
		return false, nil
	}
	if e.DryRun {
		e.logf("would create folder %s", dir)
		return true, nil
	}
	if err := os.MkdirAll(dir, perm); err != nil {
		return false, err
	}
	e.logf("created %s", dir)
	return true, nil
}

// WriteResult says what WriteIfMissing did.
type WriteResult int

const (
	Written   WriteResult = iota // file did not exist; written (or would be, in dry-run)
	Unchanged                    // file exists with exactly this content
	Kept                         // file exists with different content; left alone (user change)
)

// WriteIfMissing writes data to path only if the file does not exist yet. An existing file is never
// touched; the result says whether it already matches.
func (e *Env) WriteIfMissing(path string, data []byte, perm fs.FileMode) (WriteResult, error) {
	if cur, err := os.ReadFile(path); err == nil {
		if bytes.Equal(cur, data) {
			return Unchanged, nil
		}
		return Kept, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return 0, err
	}
	if e.DryRun {
		e.logf("would write %s (%d bytes)", path, len(data))
		return Written, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return 0, err
	}
	// O_EXCL: if something created the file since we looked, leave it be.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return Kept, nil
		}
		return 0, err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return 0, err
	}
	if err := f.Close(); err != nil {
		return 0, err
	}
	e.logf("wrote %s", path)
	return Written, nil
}

// AppendLineIfMissing adds one line to an existing file (keeping a one-time backup next to it, <path>.bak-server-os)
// unless the file already contains it. A missing file is an error: callers create files with WriteIfMissing.
func (e *Env) AppendLineIfMissing(path, line string) (bool, error) {
	cur, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	for _, l := range strings.Split(string(cur), "\n") {
		if strings.TrimSpace(l) == strings.TrimSpace(line) {
			return false, nil
		}
	}
	if e.DryRun {
		e.logf("would add to %s: %s", path, line)
		return true, nil
	}
	if bak := path + ".bak-server-os"; !Exists(bak) {
		if err := os.WriteFile(bak, cur, 0o644); err != nil {
			return false, err
		}
	}
	sep := ""
	if len(cur) > 0 && !bytes.HasSuffix(cur, []byte("\n")) {
		sep = "\n"
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		return false, err
	}
	defer f.Close()
	if _, err := f.WriteString(sep + line + "\n"); err != nil {
		return false, err
	}
	e.logf("added to %s: %s", path, line)
	return true, nil
}

// Run executes a command that changes the machine (dry-run: only printed). Output is combined.
func (e *Env) Run(ctx context.Context, name string, args ...string) (string, error) {
	line := Quote(append([]string{name}, args...))
	if e.DryRun {
		e.logf("would run: %s", line)
		return "", nil
	}
	e.logf("run: %s", line)
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// RunIn is Run with a working directory.
func (e *Env) RunIn(ctx context.Context, dir, name string, args ...string) (string, error) {
	line := Quote(append([]string{name}, args...))
	if e.DryRun {
		e.logf("would run in %s: %s", dir, line)
		return "", nil
	}
	e.logf("run in %s: %s", dir, line)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// RunAttached executes a command with the terminal attached (installers that print progress or ask
// questions). Dry-run: only printed.
func (e *Env) RunAttached(ctx context.Context, name string, args ...string) error {
	line := Quote(append([]string{name}, args...))
	if e.DryRun {
		e.logf("would run: %s", line)
		return nil
	}
	e.logf("run: %s", line)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// Query runs a read-only command (also in dry-run) with a timeout and returns trimmed stdout.
func Query(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return strings.TrimSpace(string(out)), err
}

// LookPath finds a program on PATH, then in the given fallback locations ("~" expanded).
func LookPath(name string, fallbacks ...string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, f := range fallbacks {
		f = ExpandHome(f)
		if st, err := os.Stat(f); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return f
		}
	}
	return ""
}

// ExpandHome turns a leading "~" into the user's home folder.
func ExpandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

// Quote renders argv as a copy-pasteable POSIX shell line.
func Quote(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		parts[i] = ShellQuote(a)
	}
	return strings.Join(parts, " ")
}

// ShellQuote single-quotes s for sh when it contains anything but safe characters.
func ShellQuote(s string) string {
	if s == "" {
		return "''"
	}
	safe := true
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./:=@%+,", r)) {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
