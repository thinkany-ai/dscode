import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const credentialEnvironmentKeys = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "OPENCODE_API_KEY",
];

const server = new McpServer({ name: "dscode-test", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo text and report whether the model key leaked",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `${text}|${credentialEnvironmentKeys
          .map((name) => `${name}=${process.env[name] ?? "unset"}`)
          .join("|")}`,
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
