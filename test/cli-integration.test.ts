import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentFixtureFile, writeAgentFixture } from "../packages/core/src/fixture.js";

describe("DSCode Pi integration", () => {
  let server: http.Server | undefined;
  let traceDir: string | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    if (traceDir) await fs.rm(traceDir, { recursive: true, force: true });
    traceDir = undefined;
  });

  it("runs a JSONL turn through the DeepSeek Responses adapter", async () => {
    traceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-cli-trace-"));
    const fixturePath = path.join(traceDir, "recorded.json");
    let payload: Record<string, any> | undefined;
    server = http.createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      payload = JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, any>;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      const message = {
        id: "msg_dscode_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "mock response",
            annotations: [],
            logprobs: [],
          },
        ],
      };
      sendEvent(response, {
        type: "response.created",
        response: { id: "resp_dscode_test", status: "in_progress", output: [] },
      });
      sendEvent(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      });
      sendEvent(response, {
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: "mock response",
        logprobs: [],
      });
      sendEvent(response, {
        type: "response.output_item.done",
        output_index: 0,
        item: message,
      });
      sendEvent(response, {
        type: "response.completed",
        response: {
          id: "resp_dscode_test",
          status: "completed",
          output: [message],
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 13,
          },
        },
      });
      response.end();
    });
    const address = await listen(server);
    const execution = await spawnCapture(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "src/cli.ts",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-approve",
        "--record-fixture",
        fixturePath,
        "reply once",
      ],
      {
        ...process.env,
        DSCODE_PROVIDER: "deepseek",
        DSCODE_MODEL: "deepseek-v4-flash",
        DEEPSEEK_API_KEY: "test-only-key",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        DSCODE_TRACE_DIR: traceDir,
      },
    );

    expect(execution.exitCode, execution.stderr).toBe(0);
    expect(execution.stdout).toContain("mock response");
    expect(payload?.model).toBe("deepseek-v4-flash");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("include");
    expect(payload?.reasoning).toEqual({ effort: "max" });
    expect(payload?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "update_plan" }),
        expect.objectContaining({ type: "custom", name: "apply_patch" }),
      ]),
    );
    const traceFiles = (await fs.readdir(traceDir)).filter((file) => file.endsWith(".jsonl"));
    expect(traceFiles).toHaveLength(1);
    const trace = await fs.readFile(path.join(traceDir, traceFiles[0]!), "utf8");
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run_start", "model_request", "provider_response", "model_response", "run_end"]),
    );
    expect(await readAgentFixtureFile(fixturePath)).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [{ content: [{ type: "text", text: "mock response" }], stopReason: "stop" }],
    });
    expect((await fs.stat(fixturePath)).mode & 0o777).toBe(0o600);
  }, 15_000);

  it("returns a non-zero CI exit code on provider failure", async () => {
    traceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-cli-error-trace-"));
    server = http.createServer(async (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid test key" } }));
    });
    const address = await listen(server);
    const execution = await spawnCapture(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "src/cli.ts",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-approve",
        "this request must fail",
      ],
      {
        ...process.env,
        DSCODE_PROVIDER: "deepseek",
        DSCODE_MODEL: "deepseek-v4-flash",
        DEEPSEEK_API_KEY: "invalid-test-key",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        DSCODE_TRACE_DIR: traceDir,
      },
    );

    expect(execution.exitCode).not.toBe(0);
    expect(`${execution.stdout}\n${execution.stderr}`).toContain("invalid test key");
    const traceFiles = (await fs.readdir(traceDir)).filter((file) => file.endsWith(".jsonl"));
    expect(traceFiles).toHaveLength(1);
    const traceLines = (await fs.readFile(path.join(traceDir, traceFiles[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; status?: string });
    expect(traceLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error" }),
        expect.objectContaining({ type: "run_end", status: "failed" }),
      ]),
    );
  }, 15_000);

  it("executes a deterministic fixture through the real agent runtime", async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-execute-fixture-"));
    const fixturePath = path.join(fixtureDir, "case.json");
    await writeAgentFixture(fixturePath, {
      schemaVersion: 1,
      kind: "dscode-agent-fixture",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [
        { content: [{ type: "text", text: "fixture response" }], stopReason: "stop" },
      ],
      assertions: { finalStatus: "completed", modelResponses: 1 },
    });
    const execution = await spawnCapture(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "src/cli.ts",
        "replay",
        "--execute",
        fixturePath,
        "--prompt",
        "reply once",
        "--json",
      ],
      {
        ...process.env,
        DSCODE_TRACE: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    );
    await fs.rm(fixtureDir, { recursive: true, force: true });

    expect(execution.exitCode, execution.stderr).toBe(0);
    const result = JSON.parse(execution.stdout) as {
      passed: boolean;
      modelRequests: number;
      modelResponses: number;
      violations: string[];
    };
    expect(result).toMatchObject({
      passed: true,
      modelRequests: 1,
      modelResponses: 1,
      violations: [],
    });
  }, 15_000);

  it("replays fixture tool calls through the real tool loop", async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-tool-fixture-"));
    const fixturePath = path.join(fixtureDir, "case.json");
    await writeAgentFixture(fixturePath, {
      schemaVersion: 1,
      kind: "dscode-agent-fixture",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [
        {
          content: [
            {
              type: "toolCall",
              id: "call-fixture-1",
              name: "exec_command",
              arguments: { cmd: "printf fixture-tool" },
            },
          ],
          stopReason: "toolUse",
        },
        { content: [{ type: "text", text: "tool completed" }], stopReason: "stop" },
      ],
      assertions: {
        finalStatus: "completed",
        toolNames: ["exec_command"],
        modelResponses: 2,
      },
    });
    const execution = await spawnCapture(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "src/cli.ts",
        "replay",
        "--execute",
        fixturePath,
        "--prompt",
        "run the fixture tool",
        "--json",
      ],
      {
        ...process.env,
        DSCODE_TRACE: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    );
    await fs.rm(fixtureDir, { recursive: true, force: true });

    expect(execution.exitCode, execution.stderr).toBe(0);
    const result = JSON.parse(execution.stdout) as {
      passed: boolean;
      modelResponses: number;
      violations: string[];
    };
    expect(result).toMatchObject({
      passed: true,
      modelResponses: 2,
      violations: [],
    });
  }, 15_000);

  it("allows an explicitly expected fixture error", async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-error-fixture-"));
    const fixturePath = path.join(fixtureDir, "case.json");
    await writeAgentFixture(fixturePath, {
      schemaVersion: 1,
      kind: "dscode-agent-fixture",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responses: [
        { content: [], stopReason: "error", errorMessage: "fixture rate limit" },
        { content: [], stopReason: "error", errorMessage: "fixture rate limit" },
        { content: [], stopReason: "error", errorMessage: "fixture rate limit" },
        { content: [], stopReason: "error", errorMessage: "fixture rate limit" },
      ],
      evaluation: { requireSuccessfulRun: false, failOnErrors: false },
      assertions: { finalStatus: "failed", modelResponses: 4 },
    });
    const execution = await spawnCapture(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "src/cli.ts",
        "replay",
        "--execute",
        fixturePath,
        "--prompt",
        "exercise the error path",
        "--json",
      ],
      {
        ...process.env,
        DSCODE_TRACE: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    );
    await fs.rm(fixtureDir, { recursive: true, force: true });

    expect(execution.exitCode, `${execution.stderr}\n${execution.stdout}`).toBe(0);
    const result = JSON.parse(execution.stdout) as {
      passed: boolean;
      modelResponses: number;
      violations: string[];
    };
    expect(result).toMatchObject({
      passed: true,
      modelResponses: 4,
      violations: [],
    });
  }, 30_000);
});

function sendEvent(response: http.ServerResponse, event: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve mock server address"));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

function spawnCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
