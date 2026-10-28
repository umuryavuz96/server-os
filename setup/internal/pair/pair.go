// Package pair opens a pairing window on the running server and renders the code + QR for the apps
//.
package pair

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/mdp/qrterminal/v3"

	"github.com/umuryavuz96/server-os/setup/internal/layout"
)

// Code is an open pairing window.
type Code struct {
	Code    string `json:"code"`
	Expires int64  `json:"expires"` // unix ms
}

// Pretty renders "123456" as "123 456".
func (c Code) Pretty() string {
	if len(c.Code) == 6 {
		return c.Code[:3] + " " + c.Code[3:]
	}
	return c.Code
}

// Start calls POST /api/v1/pair/start with the admin key as Bearer.
func Start(ctx context.Context, baseURL, adminKeyFile string) (Code, error) {
	key, err := os.ReadFile(adminKeyFile)
	if err != nil {
		return Code{}, fmt.Errorf("admin key: %w", err)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(baseURL, "/")+"/api/v1/pair/start", bytes.NewReader([]byte("{}")))
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(key)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return Code{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return Code{}, fmt.Errorf("pair/start: %s %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var c Code
	if err := json.Unmarshal(body, &c); err != nil || c.Code == "" {
		return Code{}, fmt.Errorf("pair/start: unexpected answer %q", body)
	}
	return c, nil
}

// WaitReady polls GET /api/v1/info until the server answers or the context ends.
func WaitReady(ctx context.Context, baseURL string) error {
	cl := http.Client{Timeout: 2 * time.Second}
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(baseURL, "/")+"/api/v1/info", nil)
		if resp, err := cl.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("server did not answer at %s", baseURL)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// DeepLink (scheme kept from the app's original name) is what the QR code encodes: serverdash://pair?url=<panel url>&code=<code>.
func DeepLink(panelURL, code string) string {
	q := url.Values{}
	q.Set("url", panelURL)
	q.Set("code", code)
	return "serverdash://pair?" + q.Encode()
}

// QR renders text as a terminal QR code (half blocks, so it fits on screen).
func QR(text string) string {
	var b bytes.Buffer
	qrterminal.GenerateWithConfig(text, qrterminal.Config{
		Level:          qrterminal.M,
		Writer:         &b,
		HalfBlocks:     true,
		BlackChar:      qrterminal.BLACK_BLACK,
		WhiteBlackChar: qrterminal.WHITE_BLACK,
		WhiteChar:      qrterminal.WHITE_WHITE,
		BlackWhiteChar: qrterminal.BLACK_WHITE,
		QuietZone:      2,
	})
	return b.String()
}

// PanelURL is the address the apps and the browser use, by reach mode.
// The server itself listens on 127.0.0.1:<port>; Tailscale Serve or the user's proxy exposes it.
func PanelURL(c layout.Config, tailnetName, hostname string) string {
	switch c.Reach {
	case layout.ReachTailscale:
		if tailnetName != "" {
			return "https://" + tailnetName
		}
	case layout.ReachPublic:
		if c.URL != "" {
			return strings.TrimSuffix(c.URL, "/")
		}
	case layout.ReachLocal:
		if hostname != "" {
			return fmt.Sprintf("http://%s.local:%d", hostname, c.Port)
		}
	}
	return LocalURL(c.Port)
}

// LocalURL is the loopback address the wizard itself talks to.
func LocalURL(port int) string { return fmt.Sprintf("http://127.0.0.1:%d", port) }

// ReachHint says what is still needed for the panel URL to work from other devices.
func ReachHint(c layout.Config) string {
	switch c.Reach {
	case layout.ReachTailscale:
		return fmt.Sprintf("Expose it on your tailnet: tailscale serve --bg %d", c.Port)
	case layout.ReachPublic:
		return fmt.Sprintf("Point your proxy or tunnel at http://127.0.0.1:%d", c.Port)
	default:
		return fmt.Sprintf("The server listens on 127.0.0.1:%d — put a reverse proxy in front for other devices on your network", c.Port)
	}
}
