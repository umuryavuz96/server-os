// Package perms talks to the running server's /api/v1/permissions: the server owns the inventory of macOS privacy
// permissions or Linux access needs (what, why, status, deep link or fix commands), so the wizard and the web panel never disagree.
package perms

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type Process struct {
	Role string `json:"role"`
	Path string `json:"path"`
}

// Item is one permission as the server reports it.
type Item struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Why       string    `json:"why"`
	Features  []string  `json:"features"`
	Required  bool      `json:"required"`
	Needed    bool      `json:"needed"`
	Status    string    `json:"status"` // granted | missing | unknown | not-needed
	Detail    string    `json:"detail"`
	Active    bool      `json:"active"` // checking may make macOS show its allow popup
	Processes []Process `json:"processes"`
	Fix       []string  `json:"fix"` // Linux: commands to copy (no Settings pane to open)
}

type reply struct {
	Permissions []Item `json:"permissions"`
	Permission  *Item  `json:"permission"`
}

// Client calls the server with the local admin key.
type Client struct {
	Base    string
	KeyFile string
	HTTP    *http.Client
}

func New(base, keyFile string) *Client {
	return &Client{Base: strings.TrimSuffix(base, "/"), KeyFile: keyFile, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, out any) error {
	key, err := os.ReadFile(c.KeyFile)
	if err != nil { // the server writes its admin key the first time it sees any token
		if r, e := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/api/v1/info", nil); e == nil {
			r.Header.Set("Authorization", "Bearer wizard")
			if resp, e := c.HTTP.Do(r); e == nil {
				resp.Body.Close()
			}
		}
		if key, err = os.ReadFile(c.KeyFile); err != nil {
			return fmt.Errorf("admin key: %w", err)
		}
	}
	var body io.Reader
	if method == http.MethodPost {
		body = bytes.NewReader([]byte("{}"))
	}
	req, _ := http.NewRequestWithContext(ctx, method, c.Base+"/api/v1"+path, body)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(key)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s %s: %s %s", method, path, resp.Status, strings.TrimSpace(string(b)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(b, out)
}

// List returns the permissions this install uses (status "not-needed" ones are dropped).
func (c *Client) List(ctx context.Context) ([]Item, error) {
	var r reply
	if err := c.do(ctx, http.MethodGet, "/permissions", &r); err != nil {
		return nil, err
	}
	return Needed(r.Permissions), nil
}

// Check re-tests one permission. For an active one macOS may show its popup now.
func (c *Client) Check(ctx context.Context, id string) (Item, error) {
	var r reply
	if err := c.do(ctx, http.MethodPost, "/permissions/"+id+"/check", &r); err != nil {
		return Item{}, err
	}
	if r.Permission == nil {
		return Item{}, fmt.Errorf("no answer for %s", id)
	}
	return *r.Permission, nil
}

// Open opens the matching System Settings pane on this Mac.
func (c *Client) Open(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/permissions/"+id+"/open", nil)
}

// Needed keeps what this config uses.
func Needed(all []Item) []Item {
	var out []Item
	for _, p := range all {
		if p.Needed && p.Status != "not-needed" {
			out = append(out, p)
		}
	}
	return out
}

// Mark is the one-character status: ✅ granted, ⚠️ anything else.
func Mark(status string) string {
	if status == "granted" {
		return "✅"
	}
	return "⚠️"
}
