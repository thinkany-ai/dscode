# HTTP Adapter API

The server exposes one REST + SSE surface per workspace. All routes are prefixed `/v1`. Request and
response bodies are JSON; a non-2xx reply is `{ "error": "<code>" }`.

## Overview: orchestrating HTTP calls

Sessions are long-lived, turns are asynchronous, and interactive UI requests arrive over the same
stream they must be answered on. The client drives everything through a small loop of individual
HTTP calls.

```ts
const base = "http://127.0.0.1:8787";

// 1. Create a session against a configured workspace.
const { id: sessionId } = await createSession(base, "main");

// 2. Open the event stream once and keep it open for the session's lifetime.
const events = openEventStream(`${base}/v1/sessions/${sessionId}/events`);

// 3. Start a turn. Everything after this arrives over the stream.
const { id: turnId, status } = await startTurn(base, sessionId, "Add validation to the login form");

events.on("turn", ({ status, output }) => {
  if (status === "completed") render(output ?? "");       // terminal — session is "idle" again
  if (status === "failed" || status === "aborted") handleFailure(status);
});
events.on("assistant_text_delta", ({ delta }) => render(delta));
events.on("tool", ({ phase, name, args }) => renderTool(phase, name, args));
events.on("ui_request", async ({ request }) => {
  // 4. Every request must be answered or the turn never finishes.
  const answer = await showDialog(request);               // confirm | select | input | editor
  await respondToUiRequest(base, sessionId, request.id, answer);
});

// 5. Later: stop the session and release its agent.
await fetch(`${base}/v1/sessions/${sessionId}`, { method: "DELETE" });
```

The request helpers are plain HTTP (`openEventStream` is your own reader — it parses the
`\n\n`-framed SSE described under Events):

```ts
async function createSession(base: string, workspaceId: string) {
  const res = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  return res.json(); // { id, workspaceId, persisted: true, resumed, status: "idle" }
}

async function startTurn(base: string, sessionId: string, message: string) {
  const res = await fetch(`${base}/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return res.json(); // { id, status: "running" }
}

async function respondToUiRequest(base: string, sessionId: string, requestId: string, answer: object) {
  await fetch(`${base}/v1/sessions/${sessionId}/ui-requests/${requestId}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(answer),
  });
}
```

Rules that shape this loop:

- **One active turn per session.** A second `POST /turns` while a turn is running returns
  `409 turn_in_progress`. Different sessions run concurrently.
- **UI requests block the turn.** The agent stops and waits for a response; an unanswered
  `ui_request` leaves the turn `running` indefinitely. Always answer, or `cancelled`.
- **Reconnecting is safe.** Every new `GET /events` connection immediately replays the latest `turn`
  event, the session's retained `ui_event`s (status, widgets, title, working state), and any pending
  `ui_request`s — so a client can reconnect mid-turn and answer outstanding dialogs.
- **A turn ends with a `turn` event**, never with the REST response (the REST response is just the
  `202` acknowledgement).

## Endpoints

| Method | Path | Description | Success |
| --- | --- | --- | --- |
| `GET` | `/health` | Liveness | `200` `{ "status": "ok" }` |
| `GET` | `/v1/sessions` | Most recent session per workspace | `200` `{ "sessions": [...] }` |
| `POST` | `/v1/sessions` | Create or resume a session | `201` descriptor |
| `GET` | `/v1/sessions/:sessionId` | Session status | `200` descriptor |
| `GET` | `/v1/sessions/:sessionId/messages` | Conversation history of an active session | `200` `{ "messages": [...] }` |
| `DELETE` | `/v1/sessions/:sessionId` | Abort, close streams, dispose agent | `204` |
| `GET` | `/v1/sessions/:sessionId/events` | SSE event stream | `200` `text/event-stream` |
| `POST` | `/v1/sessions/:sessionId/turns` | Start a turn | `202` `{ id, status }` |
| `POST` | `/v1/sessions/:sessionId/turns/:turnId/abort` | Abort a running turn | `202` `{ id, status }` |
| `POST` | `/v1/sessions/:sessionId/ui-requests/:requestId/responses` | Answer a UI request | `204` |

### Sessions

`GET /v1/sessions` — one entry per configured workspace, in configuration order:

```json
{
  "sessions": [
    { "workspaceId": "main", "active": true, "session": { "id": "…", "workspaceId": "main", "persisted": true, "status": "idle" } },
    { "workspaceId": "other", "active": false, "session": { "id": "…", "name": "…", "firstMessage": "…", "messageCount": 12, "modified": "2026-08-04T12:00:00.000Z" } }
  ]
}
```

- Active workspaces carry the live session descriptor (`status`: `idle` / `running` /
  `aborting`); a session still disposing counts as active.
- Inactive workspaces carry the most recently modified persisted session — the resume
  target for `POST /v1/sessions { resumeSessionId }` — with `name` omitted when unset,
  or `session: null` when the workspace has no history yet.

`POST /v1/sessions` — body:

```json
{ "workspaceId": "main", "resumeSessionId": "0193f4ca-…" }
```

- `workspaceId` (required): one of the IDs configured on the server; maps to the server-controlled
  path the agent is rooted at.
- `resumeSessionId` (optional): resumes the persisted session with that ID — the new session takes
  that ID (`resumed: true`). Returns `404 persistent_session_not_found` when absent, or
  `409 session_already_active` when already active.
- At most one active session per workspace: creating or resuming while the workspace has an active
  session returns `409 workspace_session_active`.

`201` response and the descriptor returned by `GET /v1/sessions/:sessionId`:

```json
{ "id": "…", "workspaceId": "main", "persisted": true, "resumed": false, "status": "idle" }
```

`status` is `idle`, `running`, or `aborting`. Sessions are always persisted on disk.

Session files are append-only logs and are never rewritten unless the server is created with
`maxSessionFileBytes` (opt-in). When set, a file that exceeds the limit is pruned at turn end:
compacted-out history and dead branches are dropped, leaving exactly the active context — the
live conversation is unaffected.

### Messages

`GET /v1/sessions/:sessionId/messages` returns the active session's conversation
history:

```json
{
  "messages": [
    { "role": "user", "timestamp": 1770206400000, "content": [{ "type": "text", "text": "Fix the login form" }] },
    { "role": "assistant", "timestamp": 1770206401000, "content": [{ "type": "text", "text": "On it." }, { "type": "toolCall", "id": "…", "name": "read", "arguments": { "path": "login.ts" } }] },
    { "role": "toolResult", "timestamp": 1770206402000, "toolCallId": "…", "toolName": "read", "isError": false, "content": [{ "type": "text", "text": "…" }] },
    { "role": "compactionSummary", "timestamp": 1770206403000, "summary": "…" }
  ]
}
```

- Active sessions only — an inactive or unknown session returns
  `404 session_not_found`; resume it first, then fetch its messages.
- The transcript is the session's current context view: after compaction it starts with
  a `compactionSummary` followed by the retained tail.
- Thinking and image content are omitted. While a turn is running, the snapshot may
  include the in-progress assistant message.

### Turns

```json
{ "message": "Add validation to the login form", "clientId": "8c1fa2c4-…" }
```

- `message` (required): the user prompt to run.
- `clientId` (optional): opaque caller identifier, echoed in the `running` event — clients
  use it to suppress their own echo of the submitted message.

`202` acknowledges with `{ "id": "<turnId>", "status": "running" }`. The investigation happens
concurrently; the outcome is delivered only as the terminal `turn` event on the stream.

`POST /v1/sessions/:sessionId/turns/:turnId/abort` is idempotent — repeated aborts share one attempt
— and replies `202 { "id": "<turnId>", "status": "aborting" }`. The turn then ends `aborted`, or
`failed` when the abort itself fails.

## Events (SSE)

Frames are `\n\n`-separated:

```
event: <type>
data: { <HttpAdapterEvent JSON> }
```

Event types:

| type | fields | meaning |
| --- | --- | --- |
| `turn` | `turnId`, `status`, `output?`, `error?`, `message?`, `clientId?` | Lifecycle: `running` (with `message` = submitted text and `clientId` = submitter's id, when provided) / `aborting`, terminal `completed` (with `output` = last assistant text), `failed` (with `error` = failure reason), `aborted` |
| `assistant_text_delta` | `turnId`, `delta` | Incremental assistant output |
| `thinking_start` | `turnId` | Model began thinking (thinking content is not streamed) |
| `thinking_end` | `turnId` | Model finished thinking |
| `compaction_start` | `turnId` | Context summarization began |
| `compaction_end` | `turnId` | Context summarization finished |
| `tool` | `turnId`, `phase`, `toolCallId`, `name`, `args`, plus `partialResult` on `updated`, or `result`/`isError` on `completed` | Tool call lifecycle (`started` / `updated` / `completed`) |
| `ui_request` | `turnId`, `request` | Interactive dialog to answer |
| `ui_event` | `turnId`, `event` | Extension UI state: `status`, `widget`, `title`, `working_*`, `hidden_thinking_label`, `notify`, `editor_text` |
| `extension_error` | `turnId`, `error` (`extensionPath`, `event`, `message`) | Extension handler failure |

`turnId` is `null` for events emitted outside an active turn (for example UI updates at session
startup).

`thinking_start`/`thinking_end` and `compaction_start`/`compaction_end` are activity indicators:
show a progress state between the pair and clear it on any terminal `turn` event — an aborted turn
may never emit the matching `_end`. They are not replayed on reconnect.

The server writes a `: keepalive` comment frame roughly every 30 seconds. Compliant SSE clients
ignore comments; use their absence for staleness detection if needed.

## UI requests and responses

`request` shapes (each carries an `id`):

| method | fields |
| --- | --- |
| `confirm` | `title`, `message` |
| `select` | `title`, `options: string[]` |
| `input` | `title`, `placeholder?` |
| `editor` | `title`, `prefill?` |

Answer with one of:

```json
{ "confirmed": true }
{ "value": "PostgreSQL" }
{ "cancelled": true }
```

- `confirmed` — `confirm` only.
- `value` — `select` (must be one of `options`), `input`, or `editor`.
- `cancelled` — any method; resolves the request to its fallback (`false` for `confirm`, `undefined`
  otherwise).

A mismatched body is rejected with `400 invalid_ui_response`; `confirm` cannot take `value`, and a
`select` value outside `options` is invalid.

## Errors

| status | code | when |
| --- | --- | --- |
| `400` | `invalid_session_request` | Missing, blank, extra, or mistyped session body fields |
| `400` | `invalid_message` | Blank or missing `message` |
| `400` | `invalid_ui_response` | Malformed or wrong-shape UI response |
| `404` | `workspace_not_found` | Unknown `workspaceId` |
| `404` | `persistent_session_not_found` | `resumeSessionId` has no persisted session |
| `404` | `session_not_found` | Unknown session on a session-scoped route |
| `404` | `ui_request_not_found` | Unknown `requestId` (or requested against the wrong session) |
| `404` | `turn_not_found` | Abort of an unknown or already-finished turn |
| `409` | `session_already_active` | Create/resume while the ID is active, activating, or disposing |
| `409` | `workspace_session_active` | Create/resume while the workspace already has an active session |
| `409` | `session_already_exists` | Persisted session with that ID already exists |
| `409` | `turn_in_progress` | Turn submitted while one is running |
| `500` | `session_creation_failed` / `session_disposal_failed` / `turn_abort_failed` / `ui_response_failed` | Internal failure |
| `500` | `session_list_failed` | Persisted session store scan failed on `GET /v1/sessions` |

