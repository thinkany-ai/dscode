import { describe, expect, it } from "vitest";
import { parseStructuredPlan } from "./plan";

describe("parseStructuredPlan", () => {
  const plan = {
    explanation: "Build and verify the game",
    plan: [
      { step: "Create the page", status: "in_progress" },
      { step: "Test gameplay", status: "pending" },
    ],
  };

  it("parses update_plan arguments", () => {
    expect(parseStructuredPlan(plan)).toEqual({
      explanation: "Build and verify the game",
      steps: plan.plan,
    });
  });

  it("parses the JSON used by approval requests", () => {
    expect(parseStructuredPlan(JSON.stringify(plan))?.steps).toEqual(plan.plan);
  });

  it("rejects unrelated or malformed input", () => {
    expect(parseStructuredPlan("not json")).toBeUndefined();
    expect(parseStructuredPlan({ plan: [{ step: "Missing status" }] })).toBeUndefined();
  });
});
