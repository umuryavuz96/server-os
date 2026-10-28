package claude

import (
	"strings"
	"testing"
)

func TestParseHeadless(t *testing.T) {
	ok := `{"type":"result","subtype":"success","is_error":false,"duration_ms":2100,"result":"OK","session_id":"x","total_cost_usd":0}`
	if l := ParseHeadless([]byte(ok)); !l.OK || l.Detail != "OK" {
		t.Fatalf("success: %+v", l)
	}
	notLoggedIn := `{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}`
	if l := ParseHeadless([]byte(notLoggedIn)); l.OK || !strings.Contains(l.Detail, "/login") {
		t.Fatalf("logged out: %+v", l)
	}
	maxTurns := `{"type":"result","subtype":"error_max_turns","is_error":false,"result":""}`
	if l := ParseHeadless([]byte(maxTurns)); l.OK || l.Detail != "error_max_turns" {
		t.Fatalf("error subtype: %+v", l)
	}
	if l := ParseHeadless([]byte("Error: something")); l.OK || l.Detail != "" {
		t.Fatalf("non-JSON: %+v", l)
	}
}

func TestWithoutAPIKey(t *testing.T) {
	env := withoutAPIKey([]string{"HOME=/h", "ANTHROPIC_API_KEY=sk-x", "PATH=/bin", "ANTHROPIC_AUTH_TOKEN=y"})
	if strings.Join(env, ",") != "HOME=/h,PATH=/bin" {
		t.Fatalf("got %v", env)
	}
}

func TestAppleScript(t *testing.T) {
	args := OsascriptArgs(`/Users/me/my "dash"/agent`)
	s := strings.Join(args, "\n")
	want := `tell application "Terminal" to do script "cd '/Users/me/my \"dash\"/agent' && claude"`
	if len(args) != 4 || args[1] != want {
		t.Fatalf("got:\n%s\nwant line: %s", s, want)
	}
	if HandoverCommand("/srv/agent") != "cd /srv/agent && claude" {
		t.Fatal(HandoverCommand("/srv/agent"))
	}
}
