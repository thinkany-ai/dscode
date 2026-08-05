import { describe, expect, it } from "vitest";
import { formatInstallSuccess } from "../scripts/install-message.mjs";

describe("installation success message", () => {
  it("uses the shared provider-neutral message", () => {
    expect(formatInstallSuccess("1.2.3")).toBe(`
DSCode v1.2.3 installed successfully.

Get started:
  cd your-project
  dscode

The first launch will guide you through model provider setup.
Run dscode --help to see all commands.

`);
  });
});
