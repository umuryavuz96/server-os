# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```sh
bun install
bun run start                 # server (uses ~/server-os; set SERVER_OS_HOME=/tmp/sd for a throwaway home)
bun run dev:web               # panel with hot reload, proxies the API
```

## Before you open a PR

```sh
bun run typecheck && bun test server && bun run build
cd setup && go vet ./... && go test ./...
npx @redocly/cli@1 lint spec/openapi.yaml     # if you touched the API
```

## Conventions

- **The API is the contract.** Change `spec/openapi.yaml` in the same PR as the route. New endpoints go under `/api/v1` and answer errors as `application/problem+json` (RFC 9457).
- **Every change to the machine is audited.** Call `audit(actor, action, target, result, trace)` and keep the request's trace.
- **Live state is pushed, not polled.** Collectors write slices with `setSlice` / `setMapEntry`; clients get only what changed.
- **Charts use server range queries:** fixed-step buckets with `null` gaps. The client draws them and never re-buckets.
- **Optional integrations stay optional.** A fresh home folder must boot with no errors and show no empty panels.
- **Commit messages:** [Conventional Commits](https://www.conventionalcommits.org) (`feat(scheduler): …`, `fix(web): …`).

## Recipes

See [docs/recipes.md](docs/recipes.md). A recipe PR should say which platforms you tested it on.
