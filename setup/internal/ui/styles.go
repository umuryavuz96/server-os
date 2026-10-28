// Package ui is the wizard's look: Lip Gloss styles (red accent on dark), a Huh theme, and a Bubble Tea
// progress list of steps with spinners and checkmarks. Without a terminal it falls back to plain lines.
package ui

import (
	"fmt"
	"io"
	"os"
	"strings"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/term"

	"github.com/umuryavuz96/server-os/setup/internal/checks"
)

var (
	Accent = lipgloss.Color("#FF453A")
	Green  = lipgloss.Color("#32D74B")
	Amber  = lipgloss.Color("#FFD60A")
	Text   = lipgloss.Color("#F2F2F7")
	Muted  = lipgloss.Color("#8E8E93")
	Faint  = lipgloss.Color("#48484A")
)

var (
	Title  = lipgloss.NewStyle().Foreground(Text).Bold(true)
	Dim    = lipgloss.NewStyle().Foreground(Muted)
	Hint   = lipgloss.NewStyle().Foreground(Muted).Italic(true)
	Strong = lipgloss.NewStyle().Foreground(Text).Bold(true)
	Red    = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	OKMark = lipgloss.NewStyle().Foreground(Green).Render("✓")
	WarnMk = lipgloss.NewStyle().Foreground(Amber).Render("!")
	FailMk = lipgloss.NewStyle().Foreground(Accent).Render("✗")
	SkipMk = lipgloss.NewStyle().Foreground(Faint).Render("–")
	PendMk = lipgloss.NewStyle().Foreground(Faint).Render("○")
	Box    = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(Accent).Padding(1, 3)
	Code   = lipgloss.NewStyle().Foreground(Text).Background(lipgloss.Color("#2C2C2E")).Padding(0, 1)
)

// IsTTY reports whether stdout is an interactive terminal.
func IsTTY() bool { return term.IsTerminal(os.Stdout.Fd()) && term.IsTerminal(os.Stdin.Fd()) }

// Out prints styled text, downsampling colours to what the terminal supports (none when piped).
func Out(a ...any) { lipgloss.Println(a...) }

// Outf is Out with a format string.
func Outf(format string, a ...any) { lipgloss.Println(fmt.Sprintf(format, a...)) }

// Banner is the wizard's header.
func Banner(dry bool) string {
	logo := Red.Render("▍") + Title.Render(" Server OS ") + Dim.Render("setup")
	if dry {
		logo += "  " + lipgloss.NewStyle().Foreground(Amber).Bold(true).Render("DRY RUN — nothing will be changed")
	}
	return "\n" + logo + "\n" + Dim.Render("  A home server you run with an AI agent.") + "\n"
}

// Theme is the Huh form theme: Charm's base with our accent.
func Theme() huh.Theme {
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		t := huh.ThemeCharm(isDark)
		t.Focused.Base = t.Focused.Base.BorderForeground(Accent)
		t.Focused.Card = t.Focused.Base
		t.Focused.Title = t.Focused.Title.Foreground(Accent)
		t.Focused.NoteTitle = t.Focused.NoteTitle.Foreground(Accent)
		t.Focused.SelectSelector = t.Focused.SelectSelector.Foreground(Accent)
		t.Focused.NextIndicator = t.Focused.NextIndicator.Foreground(Accent)
		t.Focused.PrevIndicator = t.Focused.PrevIndicator.Foreground(Accent)
		t.Focused.MultiSelectSelector = t.Focused.MultiSelectSelector.Foreground(Accent)
		t.Focused.SelectedOption = t.Focused.SelectedOption.Foreground(Text)
		t.Focused.FocusedButton = t.Focused.FocusedButton.Background(Accent).Foreground(lipgloss.Color("#FFFFFF"))
		t.Focused.Next = t.Focused.FocusedButton
		t.Focused.TextInput.Prompt = t.Focused.TextInput.Prompt.Foreground(Accent)
		t.Focused.TextInput.Cursor = t.Focused.TextInput.Cursor.Foreground(Accent)
		t.Blurred = t.Focused
		t.Blurred.Base = t.Focused.Base.BorderStyle(lipgloss.HiddenBorder())
		t.Blurred.Card = t.Blurred.Base
		t.Blurred.NextIndicator = lipgloss.NewStyle()
		t.Blurred.PrevIndicator = lipgloss.NewStyle()
		t.Group.Title = t.Focused.Title
		t.Group.Description = t.Focused.Description
		return t
	})
}

// CheckTable renders the machine check as aligned lines.
func CheckTable(rs []checks.Result) string {
	w := 0
	for _, r := range rs {
		w = max(w, len(r.Name))
	}
	var b strings.Builder
	for _, r := range rs {
		mark := map[checks.Status]string{checks.OK: OKMark, checks.Warn: WarnMk, checks.Fail: FailMk}[r.Status]
		req := ""
		if !r.Required {
			req = Dim.Render(" (optional)")
		}
		fmt.Fprintf(&b, "  %s %s  %s%s\n", mark, Strong.Render(pad(r.Name, w)), Dim.Render(r.Detail), req)
		if r.Fix != "" {
			fmt.Fprintf(&b, "    %s  %s\n", strings.Repeat(" ", w), Hint.Render(r.Fix))
		}
	}
	return b.String()
}

func pad(s string, w int) string { return s + strings.Repeat(" ", max(0, w-len(s))) }

// Writer is where plain output goes (tests swap it).
var Writer io.Writer = os.Stdout
