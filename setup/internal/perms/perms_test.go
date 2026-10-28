package perms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestClient(t *testing.T) {
	var opened string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "no", 403)
			return
		}
		switch {
		case r.URL.Path == "/api/v1/permissions":
			w.Write([]byte(`{"permissions":[{"id":"a","needed":true,"status":"missing"},{"id":"b","needed":false,"status":"not-needed"},{"id":"c","needed":true,"status":"granted"}]}`))
		case r.URL.Path == "/api/v1/permissions/a/check" && r.Method == "POST":
			w.Write([]byte(`{"permissions":[],"permission":{"id":"a","needed":true,"status":"granted"}}`))
		case r.URL.Path == "/api/v1/permissions/a/open" && r.Method == "POST":
			opened = "a"
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	key := filepath.Join(t.TempDir(), "admin.key")
	os.WriteFile(key, []byte("k\n"), 0o600)
	c := New(srv.URL, key)
	ctx := context.Background()

	l, err := c.List(ctx)
	if err != nil || len(l) != 2 || l[0].ID != "a" || l[1].ID != "c" {
		t.Fatalf("list: %v %v", l, err)
	}
	if it, err := c.Check(ctx, "a"); err != nil || it.Status != "granted" {
		t.Fatalf("check: %v %v", it, err)
	}
	if err := c.Open(ctx, "a"); err != nil || opened != "a" {
		t.Fatalf("open: %v", err)
	}
	if _, err := New(srv.URL, filepath.Join(t.TempDir(), "none")).List(ctx); err == nil {
		t.Fatal("want key error")
	}
	if Mark("granted") != "✅" || Mark("missing") != "⚠️" {
		t.Fatal("marks")
	}
}
