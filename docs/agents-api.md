# Agents API (web page + iOS app contract)

The Agent network page and the iOS Agents tab read the same endpoints. Everything is read-only. Auth is the usual
Server OS token (Bearer, `?token=` for EventSource, or the panel cookie). Capability flag: `agmsg` in `/api/v1/info`.
New fields are always additive; clients decode every field as optional.

## Network

`GET /api/v1/agmsg/network` → `Snapshot`

`GET /api/v1/agmsg/stream` (SSE)

| event | data | when |
|---|---|---|
| `snapshot` | `Snapshot` | once, first |
| `net` | `Snapshot` without `total`, `messages` = only the new ones | a message arrived or agent state changed (file events, 150 ms coalescing; 30 s resync) |
| `ping` | ms timestamp | every 15 s when quiet |

```ts
Snapshot {
  at: number                                   // ms
  teams: string[]                              // agmsg teams (implementation detail: never show as a picker)
  members: { name, team, types: string[], project: string | null }[]
  messages: Msg[]                              // oldest first
  total: Record<team, number>
  hierarchy: Record<team, { job?, staff?, flat?, root?, parent?: Record<name, name>, role?: Record<name, string>, archived?: true | string[] }>
  director: AgentInfo | null                   // the root of the chart
  agents: Record<"<team>/<name>", AgentInfo>
  clusters: Cluster[]                          // the boxes, already resolved (use these; same rules as the web page)
  temps: TempAgent[]                           // background subagents (also as the "temp" cluster, key "@temp/<id>")
}
TempAgent { key: "@temp/<id>", id, parent: "<team>/<name>" | "@/director", description, agentType, model: string | null,
            startedAt, lastAt, running: boolean, ended: "finished" | "stopped" | null }
Msg { id: number, team, from, to, body, at: number, kind: "stop" | "bug" | "question" | "report" | "status" | null }
AgentInfo {
  team, name, agent?: string,                  // director: team "@", name "Director", agent "root"
  template: string | null, project: string | null, job: string | null, model: string | null,
  startedAt: number | null,
  status: "working" | "idle" | "offline",      // from the live process + its session, never message times
  doing: string | null,                        // the running step, "thinking", or null
  session: string | null, pid: number | null, via: string | null
}
Cluster {
  id: "c:<team>", team, label,                 // label = the job ("Standing staff" for staff)
  kind: "job" | "staff" | "temp",
  done: boolean,                               // archived team: show only under History
  lead: string | null,
  members: { key: "<team>/<name>", name, manager: "@director" | "<name>", archived: boolean, external: boolean }[]
}
```

Rules every client follows:

- The director's agmsg name (`director.agent`, today `root`) is shown as `director.name` ("Director") everywhere,
  including message senders and receivers. It is never a card inside a cluster.
- Hide `cluster.done` clusters and `member.archived` members unless History is on.
- Two agents are **connected** when one is the other's `manager` (the director manages `manager: "@director"`), or both
  are in the same cluster. Draw arrows and animations only for connected pairs; count the rest as "off-chart".
- `external: true` = seen only in messages (a cron, a script), no agmsg registration.

## One agent's session

SSE `GET /api/v1/agmsg/agents/{team}/{name}/chat` (director: `/agents/@/director/chat`, temp agent: `/agents/@temp/{id}/chat`;
a finished temp agent's session may still say `working`: ignore it when `running` is false)

| event | data |
|---|---|
| `reset` | `{ items: FeedItem[], agent: AgentInfo, session: SessionMeta, path: string \| null }` (path null = no live session) |
| `items` | `FeedItem[]`: new or changed items, merge by `id` |
| `meta` | `{ agent, session, path }` when it changes |
| `ping` | every 15 s |

Polling alternative: `GET /api/v1/agmsg/agents/{team}/{name}/snapshot?since=<total>&session=<id>` →
`{ session, total, reset, items, meta: { agent, session } }` (same shape as `/bots/{ch}/snapshot`).

`FeedItem` and `SessionMeta` are the Bots feed types (`server/modules/bots/transcript.ts`): `kind` user | assistant |
step | event, `text`, `tool`, `title`, `detail`, `status` running | ok | error, `ms`, …; `SessionMeta.working` is
`{ since, step }` while a turn runs.

## Message types (`kind`)

From the wording, first match wins: `stop` (STOP, SHELVED, "stop now", "stand down"), `bug` (bug, crash, failed,
error…), `question` (a sentence ending in "?", "please confirm"), `report` (done, shipped, committed, ready…),
`status` (FYI, ack, update, progress…). Chip hues used on the web: question 210, report 152, bug 0, stop 28, status 240.
