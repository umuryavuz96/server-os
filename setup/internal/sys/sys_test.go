package sys

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteIfMissingNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a", "f.txt")
	e := New(false)
	if r, err := e.WriteIfMissing(p, []byte("one"), 0o644); err != nil || r != Written {
		t.Fatalf("first write: %v %v", r, err)
	}
	if r, _ := e.WriteIfMissing(p, []byte("one"), 0o644); r != Unchanged {
		t.Fatalf("same content: got %v", r)
	}
	if r, _ := e.WriteIfMissing(p, []byte("two"), 0o644); r != Kept {
		t.Fatalf("different content: got %v", r)
	}
	if b, _ := os.ReadFile(p); string(b) != "one" {
		t.Fatalf("file was overwritten: %q", b)
	}
}

func TestDryRunTouchesNothing(t *testing.T) {
	dir := t.TempDir()
	var lines []string
	e := New(true).WithLog(func(s string) { lines = append(lines, s) })
	if _, err := e.MkdirAll(filepath.Join(dir, "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := e.WriteIfMissing(filepath.Join(dir, "x", "f"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Run(t.Context(), "false"); err != nil {
		t.Fatal(err)
	}
	if Exists(filepath.Join(dir, "x")) {
		t.Fatal("dry-run created a folder")
	}
	if len(lines) != 3 {
		t.Fatalf("want 3 planned actions, got %v", lines)
	}
}

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"plain":       "plain",
		"/a/b-c_d.ts": "/a/b-c_d.ts",
		"with space":  "'with space'",
		"it's":        `'it'\''s'`,
		"":            "''",
	}
	for in, want := range cases {
		if got := ShellQuote(in); got != want {
			t.Errorf("ShellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}
