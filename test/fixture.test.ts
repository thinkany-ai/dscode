import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_FIXTURE_KIND,
  AGENT_FIXTURE_SCHEMA_VERSION,
  AgentFixtureReplay,
  readAgentFixtureFile,
  writeAgentFixture,
  type AgentFixture,
} from "../packages/core/src/fixture.js";
import type { Model } from "@earendil-works/pi-ai";

describe("agent fixtures", () => {
  it("round-trips a fixture with tool calls and streams deterministic responses", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-fixture-"));
    const fixturePath = path.join(directory, "case.json");
    const fixture: AgentFixture = {
      schemaVersion: AGENT_FIXTURE_SCHEMA_VERSION,
      kind: AGENT_FIXTURE_KIND,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [
        {
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "exec_command",
              arguments: { cmd: "printf fixture" },
            },
          ],
          stopReason: "toolUse",
        },
        { content: [{ type: "text", text: "fixture complete" }], stopReason: "stop" },
      ],
      assertions: { finalStatus: "completed", toolNames: ["exec_command"], modelResponses: 2 },
    };
    await writeAgentFixture(fixturePath, fixture);
    const loaded = await readAgentFixtureFile(fixturePath);
    expect(loaded).toEqual(fixture);

    const replay = new AgentFixtureReplay(loaded);
    const model = {
      api: "dscode-fixture",
      provider: "deepseek",
      id: "deepseek-v4-flash",
    } as Model<"dscode-fixture">;
    const first = replay.stream(model, { messages: [] });
    const firstEvents = [];
    for await (const event of first) firstEvents.push(event);
    expect(firstEvents.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(await first.result()).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", name: "exec_command" }],
    });
    expect(replay.consumedResponses()).toBe(1);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("turns an error fixture response into an assistant error event", async () => {
    const fixture: AgentFixture = {
      schemaVersion: AGENT_FIXTURE_SCHEMA_VERSION,
      kind: AGENT_FIXTURE_KIND,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [
        {
          content: [],
          stopReason: "error",
          errorMessage: "fixture rate limit",
        },
      ],
    };
    const replay = new AgentFixtureReplay(fixture);
    const model = {
      api: "dscode-fixture",
      provider: "deepseek",
      id: "deepseek-v4-flash",
    } as Model<"dscode-fixture">;
    const stream = replay.stream(model, { messages: [] });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: "fixture rate limit" });
  });

  it("injects response delays and aborted responses", async () => {
    const fixture: AgentFixture = {
      schemaVersion: AGENT_FIXTURE_SCHEMA_VERSION,
      kind: AGENT_FIXTURE_KIND,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [
        { content: [], stopReason: "aborted", delayMs: 1, errorMessage: "fixture cancelled" },
      ],
    };
    const replay = new AgentFixtureReplay(fixture);
    const model = {
      api: "dscode-fixture",
      provider: "deepseek",
      id: "deepseek-v4-flash",
    } as Model<"dscode-fixture">;
    const started = Date.now();
    const stream = replay.stream(model, { messages: [] });
    expect(await stream.result()).toMatchObject({
      stopReason: "aborted",
      errorMessage: "fixture cancelled",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1);
  });
});
