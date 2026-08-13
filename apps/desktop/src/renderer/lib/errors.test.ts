import { describe, expect, it } from "vitest";
import { isAgentSessionClosedError } from "./errors";

describe("isAgentSessionClosedError", () => {
  it("recognizes the direct AgentHost cancellation", () => {
    expect(isAgentSessionClosedError(new Error("Agent session closed"))).toBe(true);
  });

  it("recognizes the cancellation after Electron wraps it", () => {
    expect(isAgentSessionClosedError(
      "Error invoking remote method 'agent:command': Error: Agent session closed",
    )).toBe(true);
  });

  it("keeps real Agent failures visible", () => {
    expect(isAgentSessionClosedError(new Error("Agent stopped (code 1)"))).toBe(false);
  });
});
