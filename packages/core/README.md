# @thinkany/dscode-core

Reusable DSCode agent runtime for graphical clients, IDE integrations, and other headless hosts.

The package owns the same provider routing, tools, permissions, sessions, Skills, MCP, hooks,
checkpoints, and RPC behavior used by the `@thinkany/dscode` terminal client. DeepSeek remains the
default; Codex, OpenAI, Anthropic, OpenRouter, Z.AI, Kimi, MiniMax, and xAI are supported by the same
runtime.

```ts
import { createDSCodeRpcClient } from "@thinkany/dscode-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => console.log(event));
await client.prompt("Explain this repository");
```

Select another supported provider without changing the host integration:

```ts
const client = createDSCodeRpcClient({
  cwd: "/path/to/project",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
});
```

Configuration and sessions use the same `~/.dscode` home as the terminal client. Applications can
use the exported credential and settings functions to build their own login interface without
showing a terminal prompt.

Storage follows the same split used by the Codex desktop architecture: JSONL transcripts remain
the durable source of truth, while `state.sqlite` indexes thread metadata and pin/archive state.
Transcripts are date-partitioned under `sessions/YYYY/MM/DD`; flat hard links preserve compatibility
with the current terminal resume implementation. Credentials use an injectable `CredentialStore`
with `auto`, `keyring`, and owner-only `file` modes. The default `auto` mode uses the OS keyring in
desktop/interactive processes and falls back safely for headless processes.

For graphical authentication, use `saveProviderApiKey()` for API-key providers or pass UI callbacks
to `authenticateProvider()` for provider OAuth and API-key flows. No terminal rendering is required.
