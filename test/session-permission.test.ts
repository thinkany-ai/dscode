import { describe, expect, it } from "vitest";
import {
  permissionFromSessionEntry,
  restoreSessionPermission,
} from "../packages/core/src/session-permission.js";

const entry = (permission: string) => ({
  type: "custom",
  customType: "dscode-permission",
  data: { permission },
});

describe("session permission", () => {
  it("restores the latest valid permission from the session", () => {
    expect(restoreSessionPermission([entry("ask"), entry("full")], "auto")).toEqual({
      permission: "full",
      permissionBeforePlan: "full",
    });
  });

  it("keeps the previous non-plan permission when reopening plan mode", () => {
    expect(restoreSessionPermission([entry("ask"), entry("plan")], "auto")).toEqual({
      permission: "plan",
      permissionBeforePlan: "ask",
    });
  });

  it("ignores malformed and unrelated entries", () => {
    expect(permissionFromSessionEntry(entry("invalid"))).toBeUndefined();
    expect(restoreSessionPermission([
      { type: "custom", customType: "other", data: { permission: "full" } },
      entry("invalid"),
    ], "ask")).toEqual({ permission: "ask", permissionBeforePlan: "ask" });
  });
});
