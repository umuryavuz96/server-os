// server-os-setup: the Server OS setup wizard.
//
//	server-os-setup            interactive wizard
//	server-os-setup --dry-run  print every action instead of doing it
//	server-os-setup --yes      non-interactive, all defaults
//	server-os-setup doctor     run the checks only
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"github.com/umuryavuz96/server-os/setup/internal/names"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"charm.land/huh/v2"

	"github.com/umuryavuz96/server-os/setup/internal/checks"
	"github.com/umuryavuz96/server-os/setup/internal/claude"
	"github.com/umuryavuz96/server-os/setup/internal/layout"
	"github.com/umuryavuz96/server-os/setup/internal/pair"
	"github.com/umuryavuz96/server-os/setup/internal/perms"
	"github.com/umuryavuz96/server-os/setup/internal/service"
	"github.com/umuryavuz96/server-os/setup/internal/sys"
	"github.com/umuryavuz96/server-os/setup/internal/ui"
)

var version = "0.1.0" // set at release: -ldflags "-X main.version=vX.Y.Z"

const totalSteps = 9

type options struct {
	dry, yes, plain bool
	source, home    string
	port            int
	names, namesDNS string // --names home --names-dns wildcard|sslip: local names without questions
}

func main() {
	var o options
	fs := flag.NewFlagSet("server-os-setup", flag.ExitOnError)
	fs.BoolVar(&o.dry, "dry-run", false, "print every action instead of doing it")
	fs.BoolVar(&o.yes, "yes", false, "non-interactive: accept all defaults")
	fs.BoolVar(&o.plain, "plain", false, "plain line output instead of the live progress list")
	fs.StringVar(&o.source, "source", "", "Server OS source checkout (default: found next to this binary or the current folder)")
	fs.StringVar(&o.home, "home", "", "Server OS home folder (default $SERVER_OS_HOME or ~/server-os)")
	fs.IntVar(&o.port, "port", 0, "server port (default 3094, or the one in an existing config)")
	fs.StringVar(&o.names, "names", "", "give apps local names with this ending, e.g. home (sets up Caddy)")
	fs.StringVar(&o.namesDNS, "names-dns", "wildcard", "with --names: wildcard (your router/Pi-hole) or sslip")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Usage: server-os-setup [doctor|version] [flags]\n\n")
		fs.PrintDefaults()
	}
	// Accept the subcommand before or after the flags.
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	_ = fs.Parse(args)
	if cmd == "" && fs.NArg() > 0 {
		cmd = fs.Arg(0)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch cmd {
	case "":
		err = runWizard(ctx, o)
	case "doctor":
		err = doctor(ctx, o)
	case "version":
		fmt.Println("server-os-setup", version)
	case "help":
		fs.Usage()
	default:
		fs.Usage()
		os.Exit(2)
	}
	if errors.Is(err, ui.ErrInterrupted) {
		ui.Out(ui.Dim.Render("\nStopped. Run server-os-setup again any time — it picks up where it left off."))
		os.Exit(130)
	}
	if err != nil {
		ui.Out(ui.FailMk + " " + err.Error())
		os.Exit(1)
	}
}

// defaultHome: --home, then $SERVER_OS_HOME, then ~/server-os.
func defaultHome(o options) string {
	if o.home != "" {
		return abs(sys.ExpandHome(o.home))
	}
	for _, k := range []string{"SERVER_OS_HOME", "SERVER_DASH_HOME"} { // the old name still works
		if h := os.Getenv(k); h != "" {
			return abs(h)
		}
	}
	return sys.ExpandHome("~/server-os")
}

func abs(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return p
}

// findSource locates the checkout holding server/index.ts: --source, next to the binary, or the current folder.
func findSource(flagValue string) (string, error) {
	var cands []string
	if flagValue != "" {
		cands = append(cands, sys.ExpandHome(flagValue))
	} else {
		if exe, err := os.Executable(); err == nil {
			if exe, err = filepath.EvalSymlinks(exe); err == nil {
				d := filepath.Dir(exe)
				cands = append(cands, d, filepath.Dir(d), filepath.Join(d, "..", "libexec"))
			}
		}
		if wd, err := os.Getwd(); err == nil {
			cands = append(cands, wd, filepath.Dir(wd))
		}
	}
	for _, c := range cands {
		if sys.Exists(filepath.Join(c, "server", "index.ts")) {
			return abs(c), nil
		}
	}
	return "", errors.New("could not find the Server OS source (server/index.ts) — pass --source <checkout>")
}

// ---------------------------------------------------------------- doctor

func doctor(ctx context.Context, o options) error {
	home := defaultHome(o)
	ui.Out(ui.Banner(false))
	m := checks.Inspect(home)
	rs := m.Results()
	ui.Out(ui.Strong.Render("Machine"))
	ui.Out(ui.CheckTable(rs))

	ui.Out(ui.Strong.Render("Server OS"))
	var extra []checks.Result
	cfg, hasCfg := layout.ReadConfig(home)
	if hasCfg {
		extra = append(extra, checks.Result{Name: "Config", Status: checks.OK, Detail: layout.ConfigPath(home)})
	} else {
		extra = append(extra, checks.Result{Name: "Config", Status: checks.Warn, Detail: "not found in " + home, Fix: "Run server-os-setup to create it."})
	}
	port := cfg.Port
	if port == 0 {
		port = layout.DefaultPort
	}
	switch st, name := checks.ProbePort(port); st {
	case checks.PortServerOS:
		extra = append(extra, checks.Result{Name: "Server", Status: checks.OK, Detail: fmt.Sprintf("%q answering on 127.0.0.1:%d", name, port)})
	case checks.PortTaken:
		extra = append(extra, checks.Result{Name: "Server", Status: checks.Warn, Detail: fmt.Sprintf("port %d is used by another program", port)})
	default:
		extra = append(extra, checks.Result{Name: "Server", Status: checks.Warn, Detail: fmt.Sprintf("nothing on 127.0.0.1:%d", port), Fix: "Run server-os-setup to install the service."})
	}
	if u, err := service.Render(m.OS, sys.ExpandHome("~"), service.Params{}); err == nil {
		if sys.Exists(u.Path) {
			extra = append(extra, checks.Result{Name: "Service", Status: checks.OK, Detail: u.Path})
		} else {
			extra = append(extra, checks.Result{Name: "Service", Status: checks.Warn, Detail: "no " + u.Kind + " unit at " + u.Path})
		}
	}
	login := checks.Result{Name: "Claude login", Status: checks.Warn, Detail: "skipped — Claude Code not installed"}
	if m.ClaudePath != "" {
		ui.Out(ui.Dim.Render("  checking Claude login (one short headless turn)…"))
		if l := claude.VerifyLogin(ctx, m.ClaudePath, 60*time.Second); l.OK {
			login = checks.Result{Name: "Claude login", Status: checks.OK, Detail: "logged in · replied " + strconv.Quote(l.Detail)}
		} else {
			login = checks.Result{Name: "Claude login", Status: checks.Fail, Detail: l.Detail, Fix: claude.LoginHint}
		}
	}
	extra = append(extra, login)
	for i := range extra {
		extra[i].Required = true // a failed Claude login fails doctor; the others only warn
	}
	ui.Out(ui.CheckTable(extra))

	if miss := checks.RequiredMissing(append(rs, extra...)); len(miss) > 0 {
		return fmt.Errorf("%d required check(s) failed", len(miss))
	}
	ui.Out(ui.OKMark + " All required checks passed.")
	return nil
}

// ---------------------------------------------------------------- wizard

type wizard struct {
	o        options
	env      *sys.Env
	m        checks.Machine
	home     string
	cfg      layout.Config
	source   string
	code     pair.Code
	setupURL string
	// local names
	namesUser, namesPass string
	panelName            string
	pairErr              string
	running              bool
}

func (w *wizard) interactive() bool { return !w.o.yes }

func (w *wizard) step(n int, title string, stopOnFail bool, run func(e *sys.Env, log func(string)) ui.Result) ui.Step {
	return ui.Step{Num: n, Total: totalSteps, Title: title, StopOnFail: stopOnFail, Run: func(log func(string)) ui.Result {
		return run(w.env.WithLog(log), log)
	}}
}

func runWizard(ctx context.Context, o options) error {
	if !o.yes && !ui.IsTTY() {
		return errors.New("no interactive terminal — run with --yes for the defaults (add --dry-run to preview)")
	}
	w := &wizard{o: o, env: sys.New(o.dry), home: defaultHome(o)}
	ui.Out(ui.Banner(o.dry))

	if err := w.checkMachine(); err != nil {
		return err
	}
	if err := w.setupClaude(ctx); err != nil {
		return err
	}
	if err := w.essentials(); err != nil {
		return err
	}
	if err := w.install(ctx); err != nil {
		return err
	}
	w.permissions(ctx)
	w.showPanel()
	return w.handover(ctx)
}

// Step 1.
func (w *wizard) checkMachine() error {
	res, err := ui.RunSteps([]ui.Step{w.step(1, "Check the machine", true, func(_ *sys.Env, _ func(string)) ui.Result {
		w.m = checks.Inspect(w.home)
		rs := w.m.Results()
		if len(checks.RequiredMissing(rs)) > 0 {
			return ui.Result{Status: ui.Warned, Detail: "something required is missing"}
		}
		return ui.Result{Status: ui.Done, Detail: fmt.Sprintf("%s · %s free", w.m.Arch, checks.FormatBytes(w.m.FreeBytes))}
	})}, w.o.plain)
	if err != nil {
		return err
	}
	_ = res
	rs := w.m.Results()
	ui.Out(ui.CheckTable(rs))
	if rs[0].Status == checks.Fail {
		return errors.New(rs[0].Fix)
	}

	if w.m.BunPath == "" {
		ok := true
		if w.interactive() {
			if ok, err = ui.Confirm("Bun is required. Install it now?", "Runs: curl -fsSL https://bun.sh/install | bash", true); err != nil {
				return err
			}
		}
		if !ok {
			return errors.New("Bun is required — install it from https://bun.sh and run the wizard again")
		}
		w.env.Log = func(s string) { ui.Out(ui.Dim.Render("  " + s)) }
		if err := w.env.RunAttached(context.Background(), "bash", "-c", "curl -fsSL https://bun.sh/install | bash"); err != nil {
			return fmt.Errorf("installing Bun: %w", err)
		}
		w.m.BunPath, w.m.BunVersion = checks.FindBun()
		if w.m.BunPath == "" && !w.o.dry {
			return errors.New("Bun still not found after installing — open a new terminal and run the wizard again")
		}
	}
	return nil
}

// Step 2.
func (w *wizard) setupClaude(ctx context.Context) error {
	log := func(s string) { ui.Out(ui.Dim.Render("  " + s)) }
	w.env.Log = log
	if w.m.ClaudePath == "" {
		ok := true
		var err error
		argv := claude.InstallCommand()
		if w.interactive() {
			if ok, err = ui.Confirm("Install Claude Code?", "The root agent runs on Claude Code with your Claude subscription.\nRuns: "+sys.Quote(argv), true); err != nil {
				return err
			}
		}
		if ok {
			if err := w.env.RunAttached(ctx, argv[0], argv[1:]...); err != nil {
				ui.Out(ui.WarnMk + " Claude Code install failed: " + err.Error())
			}
			w.m.ClaudePath, w.m.ClaudeVer = checks.FindClaude()
		}
		if w.m.ClaudePath == "" {
			if w.o.dry {
				ui.Out(ui.Dim.Render("  (dry-run) would then verify the login with one headless turn"))
				return nil
			}
			ui.Out(ui.WarnMk + " Continuing without Claude Code — install it later: " + claude.InstallScript)
			return nil
		}
	}

	if w.o.dry {
		res, err := ui.RunSteps([]ui.Step{w.step(2, "Claude Code", false, func(e *sys.Env, log func(string)) ui.Result {
			log("would run: " + sys.Quote([]string{w.m.ClaudePath, "-p", "reply OK", "--output-format", "json"}) + " (60s timeout)")
			return ui.Result{Status: ui.Done, Detail: w.m.ClaudeVer + " · login check skipped in dry-run"}
		})}, w.o.plain)
		_ = res
		return err
	}

	for {
		res, err := ui.RunSteps([]ui.Step{w.step(2, "Claude Code — checking your login", false, func(_ *sys.Env, _ func(string)) ui.Result {
			l := claude.VerifyLogin(ctx, w.m.ClaudePath, 60*time.Second)
			if l.OK {
				return ui.Result{Status: ui.Done, Detail: "logged in · " + w.m.ClaudeVer}
			}
			return ui.Result{Status: ui.Failed, Detail: l.Detail}
		})}, w.o.plain)
		if err != nil {
			return err
		}
		if res[0].Status == ui.Done {
			return nil
		}
		ui.Out("  " + ui.Hint.Render(claude.LoginHint))
		if !w.interactive() {
			ui.Out(ui.WarnMk + " Continuing — the agent needs a logged-in Claude Code before the hand-over.")
			return nil
		}
		choice, err := ui.Choose("Claude Code is not logged in", "Log in in another terminal, then check again.",
			huh.NewOption("I've logged in — check again", "again"),
			huh.NewOption("Skip for now", "skip"))
		if err != nil {
			return err
		}
		if choice == "skip" {
			return nil
		}
	}
}

// Step 3.
func (w *wizard) essentials() error {
	reachDefault := layout.ReachLocal
	if w.m.TailnetName != "" {
		reachDefault = layout.ReachTailscale
	}
	if w.interactive() {
		if err := ui.RunForm(huh.NewGroup(
			huh.NewNote().Title("3/9  Essentials").Description("A few questions — every answer can be changed later in config/server-os.yaml."),
			huh.NewInput().Title("Home folder").Description("Config, apps, jobs, logs and data live here.").Value(&w.home).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return errors.New("pick a folder")
					}
					return nil
				}),
		)); err != nil {
			return err
		}
		w.home = abs(sys.ExpandHome(strings.TrimSpace(w.home)))
	}

	// Existing config (a re-run) supplies the defaults.
	cur, existing := layout.ReadConfig(w.home)
	c := layout.Config{Name: w.m.Hostname, Reach: reachDefault, Port: layout.DefaultPort}
	if cur.Name != "" {
		c.Name = cur.Name
	}
	if cur.Reach != "" {
		c.Reach = cur.Reach
	}
	if cur.Port != 0 {
		c.Port = cur.Port
	}
	if w.o.port != 0 {
		c.Port = w.o.port
	}
	c.URL = cur.URL
	c.Auth = layout.DefaultAuth(c.Reach)
	if cur.Auth != "" {
		c.Auth = cur.Auth
	}
	if existing {
		ui.Out(ui.Dim.Render("  Found " + layout.ConfigPath(w.home) + " — using its values as defaults; the file itself is kept as is."))
	}

	if w.interactive() {
		tsNote := "Recommended — reach it from anywhere on your tailnet."
		if w.m.TailnetName == "" {
			tsNote = "Recommended, but Tailscale isn't set up on this machine yet."
		}
		portStr := strconv.Itoa(c.Port)
		authTouched := cur.Auth != ""
		if err := ui.RunForm(
			huh.NewGroup(
				huh.NewInput().Title("Server name").Description("Shown in the panel and the apps.").Value(&c.Name).
					Validate(func(s string) error {
						if strings.TrimSpace(s) == "" {
							return errors.New("give it a name")
						}
						return nil
					}),
				huh.NewSelect[string]().Title("How will you reach it?").Options(
					huh.NewOption("Tailscale — "+tsNote, layout.ReachTailscale),
					huh.NewOption("Local network only", layout.ReachLocal),
					huh.NewOption("Public, behind my own proxy or tunnel", layout.ReachPublic),
				).Value(&c.Reach),
			),
			huh.NewGroup(
				huh.NewInput().Title("Public URL").Description("The https address your proxy or tunnel serves.").Placeholder("https://dash.example.com").Value(&c.URL).
					Validate(func(s string) error {
						if !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "http://") {
							return errors.New("start with https://")
						}
						return nil
					}),
			).WithHideFunc(func() bool { return c.Reach != layout.ReachPublic }),
		); err != nil {
			return err
		}
		if !authTouched {
			c.Auth = layout.DefaultAuth(c.Reach)
		}
		if err := ui.RunForm(huh.NewGroup(
			huh.NewSelect[string]().Title("Who may use the server?").Options(
				huh.NewOption("Paired devices only (token)", "token"),
				huh.NewOption("Anyone who can reach it (off)", "off"),
			).Value(&c.Auth).Description(authDescription(c.Reach)),
			huh.NewInput().Title("Port").Description("The server listens on 127.0.0.1 at this port.").Value(&portStr).
				Validate(func(s string) error {
					p, err := strconv.Atoi(s)
					if err != nil || p < 1 || p > 65535 {
						return errors.New("a port between 1 and 65535")
					}
					if st, _ := checks.ProbePort(p); st == checks.PortTaken {
						return fmt.Errorf("port %d is used by another program", p)
					}
					return nil
				}),
		)); err != nil {
			return err
		}
		c.Port, _ = strconv.Atoi(portStr)
	}
	if c.Reach != layout.ReachPublic {
		c.URL = ""
	}
	w.cfg = c

	if w.interactive() {
		if err := w.askNames(); err != nil {
			return err
		}
	} else if w.o.names != "" {
		if err := names.ValidSuffix(w.o.names); err != nil {
			return fmt.Errorf("--names: %w", err)
		}
		n := layout.Names{Suffix: strings.TrimPrefix(w.o.names, "."), DNS: w.o.namesDNS, Caddyfile: names.DefaultCaddyfile(w.m.BrewPath)}
		for _, ip := range []string{names.LANIP(), names.TailscaleIP()} {
			if ip != "" {
				n.IPs = append(n.IPs, ip)
			}
		}
		w.cfg.Names = &n
	}
	ui.Outf("%s %s %s", ui.OKMark, ui.Dim.Render("3/9")+" "+ui.Strong.Render("Essentials"),
		ui.Dim.Render(fmt.Sprintf("%s · %s · auth %s · port %d · %s", c.Name, c.Reach, c.Auth, c.Port, w.home)))
	return nil
}

func authDescription(reach string) string {
	if reach == layout.ReachTailscale {
		return "Tailscale already limits who can reach it, so off is fine; token is stricter."
	}
	return "Recommended: token — devices pair with a 6-digit code or QR."
}

// askNames: the optional local names — Caddy + a name ending of your choice, used by every app installed later.
func (w *wizard) askNames() error {
	use := w.cfg.Names != nil || sys.LookPath("caddy", "/opt/homebrew/bin/caddy", "/usr/local/bin/caddy", "/usr/bin/caddy") != ""
	if err := ui.RunForm(huh.NewGroup(huh.NewConfirm().Title("Give apps easy names?").
		Description("Like jellyfin.home instead of 192.168.1.5:8096. Installs Caddy (a small reverse proxy) if needed; every app you install later gets a name too.").
		Affirmative("Yes, set it up").Negative("No, ports are fine").Value(&use))); err != nil {
		return err
	}
	if !use {
		w.cfg.Names = nil
		return nil
	}
	n := layout.Names{Suffix: "home", DNS: "wildcard", AdGuardURL: "http://127.0.0.1:3080"}
	if w.cfg.Names != nil {
		n = *w.cfg.Names
	}
	adguard := names.AdGuardRunning(n.AdGuardURL)
	if adguard {
		n.DNS = "adguard"
	}
	opts := []huh.Option[string]{}
	if adguard {
		opts = append(opts, huh.NewOption("AdGuard Home on this server — I add each name for you", "adguard"))
	}
	opts = append(opts,
		huh.NewOption("My router / Pi-hole sends every name ending in it to this server (wildcard)", "wildcard"),
		huh.NewOption("No DNS changes: use sslip.io names (work anywhere, but longer)", "sslip"))
	var user, pass string
	if err := ui.RunForm(
		huh.NewGroup(
			huh.NewInput().Title("Name ending").Description("Suggestions: "+strings.Join(names.Suggestions, ", ")+". Not .local — that one belongs to Bonjour.").
				Value(&n.Suffix).Validate(names.ValidSuffix),
			huh.NewSelect[string]().Title("How do devices find these names?").Options(opts...).Value(&n.DNS),
		),
		huh.NewGroup(
			huh.NewInput().Title("AdGuard Home user").Value(&user),
			huh.NewInput().Title("AdGuard Home password").EchoMode(huh.EchoModePassword).Value(&pass),
		).WithHideFunc(func() bool { return n.DNS != "adguard" }),
	); err != nil {
		return err
	}
	n.Suffix = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(n.Suffix)), ".")
	// Filled in now so step 4 writes a complete names block into a new config.
	if n.Caddyfile == "" {
		n.Caddyfile = names.DefaultCaddyfile(w.m.BrewPath)
	}
	if len(n.IPs) == 0 {
		for _, ip := range []string{names.LANIP(), names.TailscaleIP()} {
			if ip != "" {
				n.IPs = append(n.IPs, ip)
			}
		}
	}
	if n.DNS == "adguard" {
		n.EnvFile = filepath.Join(w.home, "data", "names.env")
	}
	w.namesUser, w.namesPass = user, pass
	w.cfg.Names = &n
	return nil
}

// Step 6.
func (w *wizard) setupNames(ctx context.Context, e *sys.Env, log func(string)) ui.Result {
	n := w.cfg.Names
	if n == nil {
		return ui.Result{Status: ui.Skipped, Detail: "apps keep their ports (turn on later: run the setup again)"}
	}
	setup := names.Setup{Suffix: n.Suffix, DNS: n.DNS, IPs: n.IPs, Caddyfile: n.Caddyfile, AdGuardURL: n.AdGuardURL, AdGuardUser: w.namesUser, AdGuardPass: w.namesPass}
	url, err := names.Apply(ctx, e, w.home, w.cfg.Port, setup, w.m.BrewPath, log)
	if err != nil {
		return ui.Result{Status: ui.Warned, Detail: err.Error()}
	}
	// A config from an earlier run keeps the user's edits: add the names block only if it has none.
	if cur, err := os.ReadFile(layout.ConfigPath(w.home)); err == nil && !strings.Contains(string(cur), "\nnames:") {
		if _, err := e.AppendLineIfMissing(layout.ConfigPath(w.home), "\n"+strings.TrimRight(layout.NamesBlock(n), "\n")); err != nil {
			log("couldn't add names to the config: " + err.Error())
		}
	}
	w.panelName = url
	hint := ""
	if n.DNS == "wildcard" {
		hint = fmt.Sprintf(" · point *.%s at %s in your router or Pi-hole", n.Suffix, strings.Join(n.IPs, " / "))
	}
	return ui.Result{Status: ui.Done, Detail: url + hint}
}

// Steps 4–6.
func (w *wizard) install(ctx context.Context) error {
	steps := []ui.Step{
		w.step(4, "Lay out the disk", true, func(e *sys.Env, log func(string)) ui.Result {
			made, err := layout.Apply(e, w.home, w.cfg)
			if err != nil {
				return ui.Result{Status: ui.Failed, Detail: err.Error()}
			}
			if len(made) == 0 {
				return ui.Result{Status: ui.Done, Detail: "already in place · " + w.home}
			}
			verb := "created"
			if w.o.dry {
				verb = "would create"
			}
			return ui.Result{Status: ui.Done, Detail: fmt.Sprintf("%s %d item(s) in %s", verb, len(made), w.home)}
		}),
		w.step(5, "Install the server", true, func(e *sys.Env, log func(string)) ui.Result { return w.installService(ctx, e, log) }),
		w.step(6, "Local names", false, func(e *sys.Env, log func(string)) ui.Result { return w.setupNames(ctx, e, log) }),
		w.step(7, "Open the panel", false, func(e *sys.Env, log func(string)) ui.Result { return w.startPairing(ctx, log) }),
	}
	res, err := ui.RunSteps(steps, w.o.plain)
	if err != nil {
		return err
	}
	for _, r := range res[:2] {
		if r.Status == ui.Failed {
			return errors.New("setup stopped — fix the problem above and run server-os-setup again")
		}
	}
	return nil
}

func (w *wizard) installService(ctx context.Context, e *sys.Env, log func(string)) ui.Result {
	src, err := findSource(w.o.source)
	if err != nil {
		return ui.Result{Status: ui.Failed, Detail: err.Error()}
	}
	w.source = src
	bun := w.m.BunPath
	if bun == "" {
		bun = sys.ExpandHome("~/.bun/bin/bun") // dry-run before Bun is installed
	}
	// A fresh checkout has no dependencies and no built panel yet; release archives ship web/dist already.
	if !sys.Exists(filepath.Join(src, "node_modules")) {
		if out, err := e.RunIn(ctx, src, bun, "install", "--frozen-lockfile"); err != nil {
			return ui.Result{Status: ui.Failed, Detail: "bun install failed: " + lastLine(out)}
		}
	}
	if !sys.Exists(filepath.Join(src, "web", "dist", "index.html")) {
		if out, err := e.RunIn(ctx, src, bun, "run", "build"); err != nil {
			return ui.Result{Status: ui.Failed, Detail: "building the web panel failed: " + lastLine(out)}
		}
	}
	u, err := service.Render(w.m.OS, sys.ExpandHome("~"), service.Params{
		Bun: bun, SourceDir: src, Home: w.home, LogDir: filepath.Join(w.home, "logs"), Port: w.cfg.Port, Host: listenHost(w.cfg.Reach),
		Path: service.ServicePath(bun, w.m.ClaudePath, w.m.BrewPath, w.m.DockerPath),
	})
	if err != nil {
		return ui.Result{Status: ui.Failed, Detail: err.Error()}
	}
	log(fmt.Sprintf("source %s · %s unit %s", src, u.Kind, u.Path))
	if w.o.dry { // preview the values that go into the unit
		for _, l := range strings.Split(u.Content, "\n") {
			t := strings.TrimSpace(l)
			if (u.Kind == "launchd" && strings.HasPrefix(t, "<string>")) || (u.Kind == "systemd" && strings.Contains(t, "=") && !strings.HasPrefix(t, "#")) {
				log("  │ " + t)
			}
		}
	}

	state, name := checks.ProbePort(w.cfg.Port)
	if state == checks.PortTaken {
		return ui.Result{Status: ui.Failed, Detail: fmt.Sprintf("port %d is used by another program — pick another port", w.cfg.Port)}
	}
	// A Server OS on the port that this unit didn't start (a manual run, another install): loading ours
	// would only crash-loop on the busy port.
	if state == checks.PortServerOS && !sys.Exists(u.Path) {
		return ui.Result{Status: ui.Failed, Detail: fmt.Sprintf("another Server OS (%q) already runs on port %d outside this service — stop it or pick another port", name, w.cfg.Port)}
	}
	summary, err := service.Install(ctx, e, u)
	if err != nil {
		return ui.Result{Status: ui.Failed, Detail: err.Error()}
	}
	base := pair.LocalURL(w.cfg.Port)
	if state == checks.PortServerOS {
		w.running = true
		log(fmt.Sprintf("a Server OS (%q) already answers on %s", name, base))
		return ui.Result{Status: ui.Done, Detail: summary + " · running at " + base}
	}
	if w.o.dry {
		log("would wait for " + base + "/api/v1/info")
		return ui.Result{Status: ui.Done, Detail: summary}
	}
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := pair.WaitReady(wctx, base); err != nil {
		return ui.Result{Status: ui.Warned, Detail: summary + " · not answering yet — see " + filepath.Join(w.home, "logs", "service.err.log")}
	}
	w.running = true
	return ui.Result{Status: ui.Done, Detail: summary + " · running at " + base}
}

// startPairing prepares the hand-over to the web panel: the server writes a one-time setup token while it has no
// owner; the panel opened with ?setup=<token> lets that browser create the owner account. Phones and other devices
// are connected from the panel afterwards (Connect a device).
func (w *wizard) startPairing(ctx context.Context, log func(string)) ui.Result {
	panel := pair.PanelURL(w.cfg, w.m.TailnetName, w.m.Hostname)
	log("panel: " + panel)
	if w.o.dry {
		log("would read " + filepath.Join(w.home, "data", "setup.token") + " and open " + panel + "/?setup=…")
		w.setupURL = panel + "/?setup=<token>"
		return ui.Result{Status: ui.Done, Detail: panel}
	}
	if !w.running {
		w.pairErr = "server not running"
		return ui.Result{Status: ui.Warned, Detail: "server not answering — open " + pair.LocalURL(w.cfg.Port) + " on this machine once it runs"}
	}
	tok, err := os.ReadFile(filepath.Join(w.home, "data", "setup.token"))
	if err != nil { // no token: the server already has an owner — just sign in
		w.setupURL = panel
		return ui.Result{Status: ui.Done, Detail: "already set up · sign in at " + panel}
	}
	w.setupURL = panel + "/?setup=" + strings.TrimSpace(string(tok))
	if !w.o.yes {
		_, _ = sys.New(false).Run(ctx, openCmd(), pair.LocalURL(w.cfg.Port)) // on this machine the panel trusts the browser
	}
	return ui.Result{Status: ui.Done, Detail: "create your account in the panel"}
}

func openCmd() string {
	if runtime.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

// panelAddresses is where people open the panel from their devices: its name (local names), the tailnet name, and
// the LAN address when the server serves the network directly. Never localhost — that only means "this machine".
func (w *wizard) panelAddresses() []string {
	var out []string
	if w.panelName != "" {
		out = append(out, w.panelName)
	}
	if p := pair.PanelURL(w.cfg, w.m.TailnetName, w.m.Hostname); !strings.Contains(p, "127.0.0.1") && !strings.Contains(p, "localhost") {
		out = append(out, p)
	}
	if ip := names.LANIP(); ip != "" && w.cfg.Reach == layout.ReachLocal {
		out = append(out, fmt.Sprintf("http://%s:%d", ip, w.cfg.Port))
	}
	seen := map[string]bool{}
	uniq := out[:0]
	for _, a := range out {
		if !seen[a] {
			seen[a] = true
			uniq = append(uniq, a)
		}
	}
	return uniq
}

func (w *wizard) showPanel() {
	addrs := w.panelAddresses()
	var b strings.Builder
	b.WriteString(ui.Dim.Render("Open Server OS on any of your devices") + "\n")
	for i, a := range addrs {
		if i == 0 {
			b.WriteString(ui.Red.Render(a) + "\n")
		} else {
			b.WriteString(a + "\n")
		}
	}
	if len(addrs) == 0 {
		b.WriteString(ui.Hint.Render(pair.ReachHint(w.cfg)) + "\n")
	}
	fmt.Fprintf(&b, "\n%s  %s\n", ui.Dim.Render("Config"), layout.ConfigPath(w.home))
	fmt.Fprintf(&b, "%s    %s\n", ui.Dim.Render("Logs"), filepath.Join(w.home, "logs"))
	ui.Out(ui.Box.Render(b.String()))

	if w.setupURL == "" {
		ui.Out(ui.WarnMk + " The server isn't answering yet (" + w.pairErr + "). Run the setup again in a minute.")
		return
	}
	first := w.setupURL
	if len(addrs) > 0 {
		first = addrs[0]
	}
	ui.Out("\n" + ui.Strong.Render("Next: open "+first+" on your laptop or phone and create your account."))
	ui.Out(ui.Dim.Render("Then connect the iPhone/iPad app from the panel (Connect a device). Scan to open the panel on your phone:"))
	ui.Out(pair.QR(first))
}

// Step 9.
func (w *wizard) handover(ctx context.Context) error {
	agentDir := filepath.Join(w.home, "agent")
	steps := []ui.Step{w.step(9, "Hand over to the agent", false, func(e *sys.Env, log func(string)) ui.Result {
		kit := filepath.Join(w.source, "agent")
		if w.source == "" || !sys.Exists(kit) {
			log("agent kit not in this checkout yet (" + kit + ") — skipped")
		} else {
			copied, err := layout.CopyKit(e, kit, agentDir)
			if err != nil {
				return ui.Result{Status: ui.Failed, Detail: err.Error()}
			}
			log(fmt.Sprintf("agent kit: %d new file(s), existing files kept", len(copied)))
		}
		return ui.Result{Status: ui.Done, Detail: agentDir}
	})}
	if _, err := ui.RunSteps(steps, w.o.plain); err != nil {
		return err
	}

	if w.interactive() {
		ok, err := ui.Confirm("Open the agent now?", "Starts `claude` in "+agentDir+" in a new terminal window.", true)
		if err != nil || !ok {
			ui.Out("\nWhen you're ready: " + ui.Code.Render(claude.HandoverCommand(agentDir)))
			return err
		}
	}
	w.env.Log = func(s string) { ui.Out(ui.Dim.Render("  " + s)) }
	opened, err := claude.OpenTerminal(ctx, w.env, agentDir)
	switch {
	case err != nil:
		ui.Out(ui.WarnMk + " Couldn't open a terminal: " + err.Error())
		fallthrough
	case !opened:
		ui.Out("\nStart the agent: " + ui.Code.Render(claude.HandoverCommand(agentDir)))
	case !w.o.dry:
		ui.Out("\n" + ui.OKMark + " The agent is starting in a new Terminal window. Say hi.")
	}
	ui.Out(ui.Dim.Render("\nRun server-os-setup again any time to repair the setup; it never overwrites your changes."))
	return nil
}

// listenHost: on the local network the server answers the LAN itself; with Tailscale or a public proxy it
// stays on loopback and the proxy (tailscale serve / your own) is the only way in.
func listenHost(reach string) string {
	if reach == layout.ReachLocal {
		return "0.0.0.0"
	}
	return "127.0.0.1"
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// Step 8 (macOS only): the privacy permissions Server OS uses. The list comes from the running server, which owns the
// inventory. Each one is tested only when the user picks "Check now" — that is when macOS may show its allow popup,
// while they are at the Mac. Skipped ones are never touched.
func (w *wizard) permissions(ctx context.Context) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return
	}
	if runtime.GOOS == "linux" {
		w.linuxAccess(ctx)
		return
	}
	head := ui.Dim.Render("8/9") + " " + ui.Strong.Render("macOS permissions")
	if w.o.dry {
		ui.Outf("%s %s %s", ui.OKMark, head, ui.Dim.Render("would list the permissions from the server and offer to open System Settings"))
		return
	}
	if !w.running {
		ui.Outf("%s %s %s", ui.WarnMk, head, ui.Dim.Render("server not running — see Permissions in the panel later"))
		return
	}
	pc := perms.New(pair.LocalURL(w.cfg.Port), filepath.Join(w.home, "data", "admin.key"))
	list, err := pc.List(ctx)
	if err != nil {
		ui.Outf("%s %s %s", ui.WarnMk, head, ui.Dim.Render("could not read them ("+err.Error()+") — see Permissions in the panel"))
		return
	}
	ui.Out("\n" + head)
	ui.Out(ui.Dim.Render("  macOS asks before a program reaches protected things. Allow them now, while you are here, so nothing pops up later."))
	if !w.interactive() {
		for _, p := range list {
			ui.Outf("  %s %s %s", perms.Mark(p.Status), p.Title, ui.Dim.Render("— "+p.Detail))
		}
		ui.Out(ui.Dim.Render("  Fix any ⚠️ in the panel: Permissions."))
		return
	}
	for _, p := range list {
		w.askPermission(ctx, pc, p)
	}
	w.screenSharing()
}

// Step 8 on Linux: there are no privacy popups, only access the features need (Docker group, readable disks, lingering,
// firewall). The server probes them (read-only, no sudo); this prints what is missing with commands to copy. The
// wizard never runs sudo or changes the system itself.
func (w *wizard) linuxAccess(ctx context.Context) {
	head := ui.Dim.Render("8/9") + " " + ui.Strong.Render("Linux access")
	if w.o.dry {
		ui.Outf("%s %s %s", ui.OKMark, head, ui.Dim.Render("would check Docker, folder, lingering and firewall access and print fix commands"))
		return
	}
	if !w.running {
		ui.Outf("%s %s %s", ui.WarnMk, head, ui.Dim.Render("server not running — see Permissions in the panel later"))
		return
	}
	pc := perms.New(pair.LocalURL(w.cfg.Port), filepath.Join(w.home, "data", "admin.key"))
	list, err := pc.List(ctx)
	if err != nil {
		ui.Outf("%s %s %s", ui.WarnMk, head, ui.Dim.Render("could not read them ("+err.Error()+") — see Permissions in the panel"))
		return
	}
	ui.Out("\n" + head)
	for _, p := range list {
		ui.Outf("  %s %s %s", perms.Mark(p.Status), p.Title, ui.Dim.Render("— "+p.Detail))
		if p.Status != "granted" {
			for _, c := range p.Fix {
				ui.Outf("      %s", c)
			}
		}
	}
	ui.Out(ui.Dim.Render("  Run the commands yourself where you want the fix; Permissions in the panel shows them again with copy buttons."))
	w.vncServer()
}

// Optional: is a VNC server on loopback (5900-5910)? The panel's "Server screen" needs one; the panel lists the commands
// for this distro and desktop when none runs. Only checked here.
func (w *wizard) vncServer() {
	for port := 5900; port <= 5910; port++ {
		if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond); err == nil {
			c.Close()
			ui.Outf("\n%s %s %s", ui.OKMark, ui.Strong.Render("VNC server"), ui.Dim.Render(fmt.Sprintf("found on port %d — set integrations.screen.enabled: true in the config to use the panel's Server screen", port)))
			return
		}
	}
	ui.Outf("\n%s %s %s", ui.WarnMk, ui.Strong.Render("VNC server"), ui.Dim.Render("(optional) none running — open System → Server screen in the panel for the commands to start x11vnc, wayvnc or TigerVNC"))
}

// Screen Sharing powers the panel's "Mac screen" (integrations.screen): from any browser you can then click a
// System Settings switch that macOS only accepts from a person at the Mac. Only checked and explained here; the wizard
// never runs sudo or changes sharing settings itself.
func (w *wizard) screenSharing() {
	c, err := net.DialTimeout("tcp", "127.0.0.1:5900", time.Second)
	if err == nil {
		c.Close()
		ui.Outf("\n%s %s %s", ui.OKMark, ui.Strong.Render("Screen Sharing"), ui.Dim.Render("is on — set integrations.screen.enabled: true in the config to use the panel's Mac screen"))
		return
	}
	ui.Outf("\n%s %s %s", ui.WarnMk, ui.Strong.Render("Screen Sharing"), ui.Dim.Render("(optional) is off"))
	ui.Out(ui.Dim.Render("  With it on, the panel's Mac screen lets you fix permissions from any browser. Turn it on in System Settings → General → Sharing,\n" +
		"  or over SSH: sudo launchctl enable system/com.apple.screensharing && sudo launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist"))
	if !w.interactive() {
		return
	}
	if ok, err := ui.Confirm("Open the Sharing settings now?", "You switch Screen Sharing on there yourself.", false); err == nil && ok {
		_ = exec.Command("/usr/bin/open", "x-apple.systempreferences:com.apple.Sharing-Settings.extension").Run()
	}
}

func (w *wizard) askPermission(ctx context.Context, pc *perms.Client, p perms.Item) {
	for p.Status != "granted" {
		kind := "optional"
		if p.Required {
			kind = "needed"
		}
		prog := ""
		if len(p.Processes) > 0 {
			prog = "\nProgram: " + p.Processes[0].Path
		}
		ui.Outf("\n%s %s %s", perms.Mark(p.Status), ui.Strong.Render(p.Title), ui.Dim.Render("("+kind+")"))
		check := "Check now"
		if p.Active {
			check = "Check now — macOS may show an Allow popup"
		}
		act, err := ui.Choose(p.Title, p.Why+prog+"\n"+p.Detail,
			huh.NewOption(check, "check"),
			huh.NewOption("Open System Settings", "open"),
			huh.NewOption("Skip for now", "skip"))
		if err != nil || act == "skip" {
			ui.Out(ui.Dim.Render("  skipped — you can fix it later in the panel: Permissions"))
			return
		}
		if act == "open" {
			if err := pc.Open(ctx, p.ID); err != nil {
				ui.Out(ui.WarnMk + " Couldn't open System Settings: " + err.Error())
			} else {
				ui.Out(ui.Dim.Render("  Switch the program on there, then choose Check now."))
			}
			continue
		}
		if np, err := pc.Check(ctx, p.ID); err != nil {
			ui.Out(ui.WarnMk + " " + err.Error())
		} else {
			p = np
		}
	}
	ui.Outf("%s %s %s", perms.Mark(p.Status), p.Title, ui.Dim.Render(p.Detail))
}
