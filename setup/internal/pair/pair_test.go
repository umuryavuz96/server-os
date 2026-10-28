package pair

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/umuryavuz96/server-os/setup/internal/layout"
)

func TestDeepLink(t *testing.T) {
	got := DeepLink("https://box.tail1.ts.net", "042137")
	u, err := url.Parse(got)
	if err != nil || u.Scheme != "serverdash" || u.Host != "pair" {
		t.Fatalf("bad link %s (%v)", got, err)
	}
	if u.Query().Get("url") != "https://box.tail1.ts.net" || u.Query().Get("code") != "042137" {
		t.Fatalf("query: %v", u.Query())
	}
}

func TestStart(t *testing.T) {
	keyFile := filepath.Join(t.TempDir(), "admin.key")
	os.WriteFile(keyFile, []byte("secret-key\n"), 0o600)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/pair/start" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret-key" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"code":"123456","expires":1760000000000}`))
	}))
	defer srv.Close()

	c, err := Start(context.Background(), srv.URL, keyFile)
	if err != nil || c.Code != "123456" || c.Pretty() != "123 456" {
		t.Fatalf("got %+v %v", c, err)
	}
	os.WriteFile(keyFile, []byte("wrong"), 0o600)
	if _, err := Start(context.Background(), srv.URL, keyFile); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("wrong key should fail with 403, got %v", err)
	}
}

func TestWaitReadyTimesOut(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := WaitReady(ctx, "http://127.0.0.1:1"); err == nil {
		t.Fatal("expected timeout")
	}
}

func TestPanelURL(t *testing.T) {
	cases := []struct {
		c    layout.Config
		ts   string
		want string
	}{
		{layout.Config{Reach: layout.ReachTailscale, Port: 3094}, "box.tail1.ts.net", "https://box.tail1.ts.net"},
		{layout.Config{Reach: layout.ReachTailscale, Port: 3094}, "", "http://127.0.0.1:3094"},
		{layout.Config{Reach: layout.ReachLocal, Port: 8080}, "", "http://box.local:8080"},
		{layout.Config{Reach: layout.ReachPublic, Port: 3094, URL: "https://dash.example.com/"}, "", "https://dash.example.com"},
	}
	for _, c := range cases {
		if got := PanelURL(c.c, c.ts, "box"); got != c.want {
			t.Errorf("%+v: got %s want %s", c.c, got, c.want)
		}
	}
}

func TestQR(t *testing.T) {
	q := QR(DeepLink("https://box.tail1.ts.net", "123456"))
	lines := strings.Split(strings.TrimRight(q, "\n"), "\n")
	if len(lines) < 10 || !strings.ContainsAny(q, "▀▄█") {
		t.Fatalf("QR looks wrong (%d lines):\n%s", len(lines), q)
	}
}
