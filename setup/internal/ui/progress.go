package ui

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// Status of a step in the progress list.
type Status int

const (
	Pending Status = iota
	Running
	Done
	Warned
	Failed
	Skipped
)

// Result is what a step reports when it finishes.
type Result struct {
	Status Status
	Detail string
}

// Step is one line of the progress list. Run gets a log function for sub-lines (actions, dry-run plans).
type Step struct {
	Num, Total int
	Title      string
	Run        func(log func(string)) Result
	StopOnFail bool // a failure skips the steps after it
}

// ErrInterrupted is returned when the user presses ctrl+c.
var ErrInterrupted = errors.New("interrupted")

// RunSteps runs steps in order and shows them as a live list (spinner → checkmark). Without a TTY, or
// when plain is set, it prints plain lines instead.
func RunSteps(steps []Step, plain bool) ([]Result, error) {
	if plain || !IsTTY() {
		return runPlain(steps), nil
	}
	m := newModel(steps)
	final, err := tea.NewProgram(m).Run()
	if err != nil {
		return nil, err
	}
	fm := final.(*model)
	if fm.interrupted {
		return fm.results(), ErrInterrupted
	}
	return fm.results(), nil
}

func runPlain(steps []Step) []Result {
	out := make([]Result, len(steps))
	stop := false
	for i, s := range steps {
		if stop {
			out[i] = Result{Status: Skipped, Detail: "skipped"}
			Outf("%s %s %s", SkipMk, label(s), Dim.Render("skipped"))
			continue
		}
		Outf("%s %s", Red.Render("›"), label(s))
		r := s.Run(func(line string) { Outf("    %s", Dim.Render(line)) })
		out[i] = r
		Outf("  %s %s", mark(r.Status, ""), Dim.Render(r.Detail))
		if r.Status == Failed && s.StopOnFail {
			stop = true
		}
	}
	return out
}

func label(s Step) string {
	n := ""
	if s.Total > 0 {
		n = Dim.Render(fmt.Sprintf("%d/%d ", s.Num, s.Total))
	}
	return n + Strong.Render(s.Title)
}

func mark(st Status, spin string) string {
	switch st {
	case Running:
		return spin
	case Done:
		return OKMark
	case Warned:
		return WarnMk
	case Failed:
		return FailMk
	case Skipped:
		return SkipMk
	}
	return PendMk
}

type stepState struct {
	Step
	res  Result
	logs []string
}

type model struct {
	mu          *sync.Mutex
	steps       []*stepState
	cur         int
	spin        spinner.Model
	interrupted bool
	quitting    bool
}

type stepDone struct {
	i   int
	res Result
}

func newModel(steps []Step) *model {
	m := &model{mu: &sync.Mutex{}}
	for _, s := range steps {
		m.steps = append(m.steps, &stepState{Step: s})
	}
	m.spin = spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(lipgloss.NewStyle().Foreground(Accent)))
	return m
}

func (m *model) results() []Result {
	out := make([]Result, len(m.steps))
	for i, s := range m.steps {
		out[i] = s.res
	}
	return out
}

func (m *model) start(i int) tea.Cmd {
	s := m.steps[i]
	s.res.Status = Running
	return func() tea.Msg {
		r := s.Run(func(line string) {
			m.mu.Lock()
			s.logs = append(s.logs, line)
			m.mu.Unlock()
		})
		return stepDone{i, r}
	}
}

func (m *model) Init() tea.Cmd {
	if len(m.steps) == 0 {
		return tea.Quit
	}
	return tea.Batch(m.spin.Tick, m.start(0))
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.interrupted, m.quitting = true, true
			return m, tea.Quit
		}
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd
	case stepDone:
		m.mu.Lock()
		m.steps[msg.i].res = msg.res
		m.mu.Unlock()
		stop := msg.res.Status == Failed && m.steps[msg.i].StopOnFail
		next := msg.i + 1
		if stop {
			for _, s := range m.steps[next:] {
				s.res = Result{Status: Skipped, Detail: "skipped"}
			}
			next = len(m.steps)
		}
		if next >= len(m.steps) {
			m.quitting = true
			return m, tea.Quit
		}
		m.cur = next
		return m, m.start(next)
	}
	return m, nil
}

const maxLiveLogs = 6

func (m *model) View() tea.View {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b strings.Builder
	for _, s := range m.steps {
		line := fmt.Sprintf("%s %s", mark(s.res.Status, m.spin.View()), label(s.Step))
		if s.res.Detail != "" {
			line += "  " + Dim.Render(s.res.Detail)
		}
		b.WriteString(line + "\n")
		logs := s.logs
		if s.res.Status == Running && len(logs) > maxLiveLogs {
			logs = logs[len(logs)-maxLiveLogs:]
		}
		if s.res.Status != Pending && s.res.Status != Skipped {
			for _, l := range logs {
				b.WriteString("    " + Dim.Render(l) + "\n")
			}
		}
	}
	if m.quitting {
		b.WriteString("\n")
	}
	return tea.NewView(b.String())
}
