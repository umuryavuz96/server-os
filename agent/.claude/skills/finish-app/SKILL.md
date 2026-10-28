---
name: finish-app
description: Make a freshly installed app ready to use — first-run setup (admin account, setup wizard, sign-ups), a working address, and the ready card the owner sees. Use after every install, for "set up X", "finish X", or when the installer hands an app over.
---

# Finish an app

The goal: the owner opens one link, logs in, and uses the app. No setup wizard left, no open sign-ups.

0. **Keep the owner in the loop.** They watch a checklist live. First call `plan_steps` with the steps this app
   really needs (adjust the default list: drop what doesn't apply, add e.g. "Add the media folders"). Then, for
   each step, `check_step` it `doing` when you start and `done` with a short note when finished (`skipped` /
   `failed` with the reason). Notes are one plain line: "admin umur created", "sign-ups closed". Never a password.
1. **Look.**
   - `list_apps` / `app_logs`: is it running and healthy? Fix a crash first (bad env var, port, volume).
   - Read `../apps/<id>/compose.yaml`, `setup.md` (the recipe's notes, if any) and the app's own docs
     (website / repo README, "first run" or "initial setup" pages; `WebFetch` them).
2. **Decide what first-run needs.** Typical:
   - An **admin account**: make the password with `new_secret` (name `admin_password`), the user name from the
     owner's name. Create it the way the docs say, in this order of preference:
     the app's CLI in the container (`docker exec …`), its setup/REST API (`curl`), an env var + restart.
   - A **setup wizard** in the browser: do its steps through the same API the wizard calls, when the docs or
     the wizard's network calls show one. If it can only be clicked through, leave it as a step for the owner.
   - **Open sign-ups**: close them once the admin exists (env var or setting), then restart the app.
   - **Folders** the app needs (media, documents): use folders under `{{data}}`; tell the owner how to add more.
   - **HTTPS**: some apps refuse plain http (password managers, WebAuthn). Say so in the steps.
3. **Change config safely.** Edit `../apps/<id>/compose.yaml` (env vars), then
   `docker compose -p sd-<id> -f ../apps/<id>/compose.yaml up -d`. Never touch other apps.
4. **Check it works.** `curl` the login or API with the new account where you can (expect 200/302, not the wizard).
5. **Report.** `report_ready` once:
   - `url`: the app's `href` from `list_apps` (its address), not 127.0.0.1.
   - `username` and `secret` (the `new_secret` name) when you made an account.
   - `summary`: one or two plain sentences of what is set up.
   - `steps`: what only a person can do, short and concrete ("Install the Bitwarden app and log in with …").
     Empty when nothing is left.
   - If setup failed part-way, still report: say what works and what is left.

## Rules
- Never print passwords in your answer or in logs; refer to the secret by name.
- Background runs can't ask questions: pick safe defaults (sign-ups closed, telemetry off, local-only) and say which.
- Don't restart or change anything outside this app's folder.
