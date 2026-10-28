# Security policy

Server OS can start and stop containers, run scheduled commands and hand work to an AI agent on your machine, so security reports matter.

## Supported versions

Server OS is an early preview. Only the latest release (and `main`) gets fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
**Security → Report a vulnerability** on <https://github.com/umuryavuz96/server-os>.

Include what you found, how to reproduce it, and the version or commit. You will get a first answer within a week. Fixes are released first; the report is made public after that, with credit if you want it.

## Good to know

- With `auth: off` anyone who can reach the port can use the panel. Keep it on loopback, a tailnet or behind your own proxy, or set `auth: token`.
- Secrets (tokens, passwords) belong in environment variables or `~/.env`, never in `config/server-os.yaml`.
- The Docker socket gives full control of the host; leave it out of the container if you want a read-only panel.
