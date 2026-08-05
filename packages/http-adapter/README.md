# @thinkany/dscode-http-adapter

HTTP adapter that runs the DSCode agent in-process and exposes it over REST + SSE, so you can build
an agent-backed chat-bot app.

The package runs a real DSCode session **in-process** via `createAgentSessionHost` — no separate
worker process, no JSONL protocol. A Fastify server (`createHttpAdapterServer`) maps one HTTP session
to one agent session, streams assistant, tool, status, and interactive UI events over SSE, and
forwards approvals and questions back to the client.

```ts
import { createHttpAdapterServer } from "@thinkany/dscode-http-adapter";

const server = createHttpAdapterServer({
  workspaces: {
    main: "/path/to/workspace",
  },
});

await server.listen({ host: "127.0.0.1", port: 8787 });
```

Each HTTP session owns an isolated agent with its own tools, MCP connections, approvals, and
conversation state. Workspace IDs map to server-controlled paths, so clients never supply a raw
`cwd`. Turns are asynchronous: submit a turn, watch `GET /v1/sessions/:id/events` for progress, and
answer `confirm` / `select` / `input` / `editor` requests as they arrive.

Sessions are persisted to the per-home session store shared with the CLI (`~/.dscode/sessions`) and
can be resumed by ID.

## Runtime arguments

`createHttpAdapterServer({ runtimeArgs })` forwards a fixed allowlist of DSCode CLI flags to every
session — values: `--provider --base-url --transport --harness --permission --sandbox --effort
--model --tools`; booleans: `--network --web --no-tools --no-resume`. Anything else is rejected
with `Unsupported direct session argument`. The agent's working directory is always the workspace
path, never client-controlled.

## Security notes

- No built-in authentication. Bind to localhost or a private network and add your own auth.
- Workspace IDs must resolve to server-controlled paths; never derive `cwd` from client input.
- Credentials and the API key live server-side in the shared `~/.dscode` home.
- One active turn per session is enforced; sessions are isolated (separate conversation state, tools,
  MCP connections, and managed processes).

See `docs/API.md` for the endpoint reference and an end-to-end orchestration walkthrough.
