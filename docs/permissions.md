# macOS permissions

macOS asks you to approve each program that reaches protected things: other apps' data, devices on your network, external drives, the microphone. A grant belongs to the **program file**, so Server OS lists which program needs which grant, and shows it in the setup wizard and in **System → Permissions** in the panel.

Nothing here grants anything for you. Server OS never writes `TCC.db` and never uses `sudo` or `tccutil`. It tests with a cheap read, then opens the right System Settings pane so you can switch the program on.

## What can be needed

| Permission | Needed when | Program | Why |
|---|---|---|---|
| Full Disk Access | always (optional) | `bun`; with bots also `claude` and `tmux` | The Storage page sizes Mail, Messages, Safari and other protected folders; without it they are skipped and totals are low. Bots read projects anywhere in your home folder. |
| Local Network | `integrations.homeAssistant` or `integrations.adguard` points at a LAN address | `bun` | Without it macOS answers "No route to host" and the integration shows offline. (Server OS checks LAN devices with `curl` for the same reason, but `bun` itself needs the grant for everything else.) |
| Removable & network volumes | `externalDisk` or another configured path is under `/Volumes` | `bun` | Reading apps and data on an external drive or share. |
| Files & Folders | a configured path is inside `~/Desktop`, `~/Documents` or `~/Downloads` | `bun` | The server lists that folder. Easiest fix: keep Server OS data outside those folders. |
| Microphone | `integrations.houseVoice.dir` is set | `tmux` | The desk speaker runs inside tmux, so tmux is the program macOS asks about. |
| Automation | never for the server | the Terminal running the wizard | Only the setup wizard's "open the agent in Terminal" step. Shown for completeness; it cannot be tested without a popup. |

Accessibility and Screen Recording are not used by anything in Server OS and are not listed.

A permission your config does not use shows **Not needed**. **Required** means a missing grant breaks something that is switched on; a missing required permission shows a banner on the Overview.

## Status

| Status | Meaning |
|---|---|
| Granted | The probe worked. |
| Missing | macOS refused (`EPERM`, `No route to host`). |
| Unknown | Cannot be tested without risking a popup, or the test was inconclusive. Check in System Settings. |
| Not needed | Your config does not use it. |

Probes: Full Disk Access opens `TCC.db` (or `~/Library/Safari`) read-only; a refusal is silent. Local Network makes a short TCP connection from `bun` to your Home Assistant or AdGuard host, or the default gateway. Volumes and folders list the configured path. Probes that can make macOS show its **Allow** popup (Local Network, volumes, folders) are *active*: they run only when you press **Re-check** (or choose *Check now* in the wizard), never from the plain list.

## Bun upgrades reset grants

macOS keys the grant on the program's real path. A Bun upgrade (or reinstalling Claude Code) can change the file, and macOS asks again. The panel shows the exact path (`process.execPath`) next to each permission; after an upgrade, open Permissions and Re-check.

## Where to see it

- **Setup wizard** (step 8, macOS only): lists the permissions from the running server, offers *Check now*, *Open System Settings* or *Skip* for each, and shows ✅ / ⚠️. Skipped ones are never touched.
- **Panel → System → Permissions**: status chip, why, which program, **Open settings**, **Re-check**.
- **Mac screen** (optional): **Fix on the Mac screen** on each permission, see [Remote screen](#remote-screen-fixing-a-permission-from-another-device).
- **API**: `GET /api/v1/permissions`, `POST /api/v1/permissions/{id}/check`, `POST /api/v1/permissions/{id}/open` (admin: the local admin key or a paired device; it runs `open` on the server's Mac). See `spec/openapi.yaml`.

## Remote screen (fixing a permission from another device)

macOS only accepts a privacy switch from a person at the Mac: no script, API or `sudo` can turn one on. If the web panel is the only thing you can reach, turn on the remote screen and click the switch through the browser.

```yaml
integrations:
  screen: { enabled: true }   # host 127.0.0.1, port 5900, idleMinutes 5, maxMinutes 30
```

Then **Permissions → Fix on the Mac screen** opens the right System Settings pane on the Mac, shows the Mac's screen, and re-checks that permission when you close it. **System → Mac screen** opens the screen on its own.

How it works: the browser runs [noVNC](https://github.com/novnc/noVNC) (1.7.0) and opens a WebSocket to `/api/v1/screen/ws` on the panel's own address. The server opens a TCP connection to macOS Screen Sharing on `127.0.0.1:5900` and copies bytes both ways. Nothing new listens on the network; port 5900 is never exposed by Server OS. It goes through the same Caddy and Tailscale Serve paths as the panel (both pass WebSocket upgrades by default).

### Signing in

macOS Screen Sharing offers Apple's own login (RFB security type 30, "ARD": Diffie-Hellman key exchange, then the username and password encrypted with AES-128), plus Apple-only types (33, 35, 36) that noVNC does not speak. noVNC supports type 30, so you sign in with a **user account of the Mac** that is allowed in System Settings → General → Sharing → Screen Sharing. The key exchange and encryption happen in your browser; Server OS only pipes the encrypted bytes and never logs, stores or sees the username or password. The panel clears the password field as soon as it is sent.

Browsers hide WebCrypto on plain `http://` addresses (`http://homepage.home` is not a "secure context"), and noVNC's type-30 login needs AES from WebCrypto. On such pages the panel fills in that one function with a small built-in AES-128 (`web/src/screen/aes.ts`, tested against WebCrypto); on `https://` and `localhost` the browser's own WebCrypto is used.

No "VNC password" fallback is needed: noVNC 1.7.0 speaks type 30. (macOS's "VNC viewers may control screen with password" option adds classic VNC auth, type 2, but macOS lists type 30 first and noVNC takes the first type it supports, so the panel would still use the account login.)

### Speed: picture modes and the stats overlay

The viewer toolbar has **Performance / Balanced / Quality** (remembered in the browser, Balanced by default; switching applies at once, no reconnect) and a **Stats** toggle that prints fps, KB/s, KB per frame, rects/s, decode load, the encodings Apple actually sends and the framebuffer size. Screenshot that line when comparing.

- noVNC always offers one fixed list of encodings and the server picks. A mode trims that list on its way out (`web/src/screen/modes.ts`): Performance keeps Tight (lossy JPEG) > ZRLE > Hextile > Raw with quality 2 / compression 9; Quality keeps only lossless CopyRect, ZRLE and Raw with quality 9 / compression 0; Balanced is noVNC's own list. The quality and compression levels only matter if Apple's server uses Tight, which the overlay shows.
- noVNC cannot switch to 16-bit colour (its decoders assume 24-bit), and Apple does not honour SetDesktopSize, so colour depth and size are not levers.
- The server pipe is not the limit: `bun server/bench/screen-pipe.ts` pushes raw 2560x1440 frames through it at over 2 GB/s. Set `integrations.screen.debug: true` (or `SERVER_OS_SCREEN_DEBUG=1`) to log bytes/s, messages/s and the encodings noVNC asks for every 2 s; counts only, never picture or login data.
- The server sets TCP_NODELAY on the Screen Sharing socket and pauses reading from it while the browser's WebSocket is backed up.

### Security

- **Off by default.** Only `integrations.screen.enabled: true` turns it on, and only towards a loopback host. Any other host turns it off: it is never a relay to other machines.
- **Owner only.** The WebSocket needs the local admin key or a paired device / signed-in browser (the HttpOnly `SameSite=Strict` cookie). Anonymous callers get 401 or 403, and so does the agent (`X-Actor: agent`). With `auth: off` too: sign in or pair the browser first.
- **Same origin.** A browser's `Origin` must be the panel's own host (`Host` or the proxy's `X-Forwarded-Host`), so another site cannot open it with your cookie.
- **One session at a time.** A second viewer gets 409; the panel offers **Take over**, which ends the first session (close code 4003).
- **Short sessions.** A session closes after `idleMinutes` (default 5) without keyboard or pointer input (noVNC's own screen-update requests do not count) and after `maxMinutes` (default 30) in any case.
- **Audited.** `screen.open` and `screen.close` go to the audit log with who, from which address, why it closed, how long, and byte counts. Refused opens are logged as failed with the reason (busy, origin).
- **Plain http.** The login is encrypted by Apple's scheme, but the picture and keystrokes after login are not (Screen Sharing sends them in the clear to VNC clients). On the home network or tailnet that is the same exposure as any other http page; use the tailnet's https address when you can.

### If Screen Sharing is off

The panel says so (port 5900 not listening). Turn it on once:

- **At the Mac:** System Settings → General → Sharing → Screen Sharing.
- **Over SSH:**
  ```sh
  sudo launchctl enable system/com.apple.screensharing
  sudo launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist
  ```
  On macOS 27.0.1 the daemon is still `com.apple.screensharing` at that path (checked with `launchctl print`, which needs no sudo). The commands could not be tried on a Mac where Screen Sharing was already on, so treat them as the expected way, not a tested one. If the SSH way does not take, use the switch at the Mac.

The setup wizard checks the port at the end of the permissions step and offers to open the Sharing settings. It never changes sharing settings itself.

Not covered: code signing and a stable helper app, which would make grants survive upgrades.

## Linux

Linux has no privacy popups, so the Permissions page (and wizard step 8) lists what Server OS needs from the system instead. Each check only reads and never uses sudo; the fix is a command you copy and run yourself.

| Entry | Why | Check | Fix |
|---|---|---|---|
| Docker access | Apps, installing Docker apps | read/write on the Docker socket (`/var/run/docker.sock`, a rootless `$XDG_RUNTIME_DIR/docker.sock`, or `DOCKER_HOST`) | `sudo usermod -aG docker $USER`, then log in again |
| Folder & disk access | Storage scan, folders in the config, disks under `/mnt` and `/media` | listing each folder / mount from `/proc/mounts` | `sudo setfacl -R -m u:$USER:rX <path>` |
| Run after logout | Server OS and bots are `systemctl --user` services | `loginctl show-user` → `Linger` | `sudo loginctl enable-linger $USER` |
| Firewall | Only when `HOST` is not loopback | `ufw` / `firewalld` active (rules need root, so not read) | `sudo ufw allow <port>/tcp` or `firewall-cmd` |
| SELinux | Only when enforcing: bind mounts into containers | `/sys/fs/selinux/enforce` | look for denials; add `:z` to the volume |

Not listed because the code does not need them: journal access (Logs reads Server OS's own log files), sudo (only the macOS storage cleanup uses it) and AppArmor (denials need root to read).

### Server screen on Linux

The same remote screen works on Linux through any VNC server on loopback. With no `port` set, Server OS uses the first listener in 5900-5910; set `integrations.screen.port` to pin one. The panel's **Server screen** page detects your distro (apt, dnf, pacman) and desktop and, when nothing runs, shows the exact commands to copy. It never installs or starts anything.

| Desktop | Use | Notes |
|---|---|---|
| X11 | `x11vnc -display :0 -localhost -rfbauth ~/.vnc/passwd -forever -shared` | VNC password (type 2) |
| Wayland (sway, Hyprland, ...) | `wayvnc 127.0.0.1 5900` | no auth on loopback (type 1) or password |
| KDE Plasma | krfb with an unattended-access password | |
| Headless | `vncserver :1 -localhost yes` (TigerVNC), port 5901 | virtual desktop, needs a desktop installed |
| GNOME | `grdctl vnc enable` | its VNC uses encrypted VeNCrypt, which noVNC only partly supports; prefer x11vnc if the viewer reports a security failure |

The viewer asks only for a password when the server wants no username (VNC auth), or both for username/password types. Bind the VNC server to localhost: the panel warns if one listens on every interface.
