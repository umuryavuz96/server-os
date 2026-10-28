package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindSource(t *testing.T) {
	repo := t.TempDir()
	os.MkdirAll(filepath.Join(repo, "server"), 0o755)
	os.WriteFile(filepath.Join(repo, "server", "index.ts"), nil, 0o644)
	if got, err := findSource(repo); err != nil || got != repo {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := findSource(t.TempDir()); err == nil {
		t.Fatal("a folder without server/index.ts was accepted")
	}
}

func TestDefaultHome(t *testing.T) {
	t.Setenv("SERVER_OS_HOME", "/srv/sd")
	if got := defaultHome(options{}); got != "/srv/sd" {
		t.Fatal(got)
	}
	if got := defaultHome(options{home: "/x/y"}); got != "/x/y" {
		t.Fatal(got)
	}
}
