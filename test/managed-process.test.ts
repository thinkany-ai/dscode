import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.js";

describe("ManagedProcessRegistry", () => {
  it("yields and reconnects to a background process", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(
        backgroundCommand(),
        {
          cwd: os.tmpdir(),
          sandbox: { mode: "danger-full-access", network: false },
          yieldTimeMs: 0,
          timeoutMs: 5_000,
        },
      );
      expect(started.running).toBe(true);
      const completed = await registry.interact(started.processId, { yieldTimeMs: 2_000 });
      expect(completed.running).toBe(false);
      expect(completed.exitCode).toBe(0);
      expect(completed.output).toContain("done");
    } finally {
      registry.dispose();
    }
  });

  it.runIf(process.platform === "win32")("terminates the Windows process tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-process-tree-"));
    const childScript = path.join(root, "child.cjs");
    const parentScript = path.join(root, "parent.cjs");
    const marker = path.join(root, "survived.txt");
    await fs.writeFile(
      childScript,
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 1_000);`,
    );
    await fs.writeFile(
      parentScript,
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" }); process.stdout.write("ready"); setTimeout(() => {}, 3_000);`,
    );

    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start(powerShellNodeCommand(parentScript), {
        cwd: root,
        sandbox: { mode: "danger-full-access", network: false },
        yieldTimeMs: 250,
        timeoutMs: 5_000,
      });
      expect(started.running).toBe(true);
      expect(started.output).toContain("ready");

      const stopped = await registry.interact(started.processId, {
        yieldTimeMs: 2_000,
        terminate: true,
      });
      expect(stopped.running).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      registry.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function backgroundCommand(): string {
  const script = "setTimeout(() => process.stdout.write(`done`), 100)";
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' '-e' '${script.replaceAll("'", "''")}'`;
  }
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
}

function powerShellNodeCommand(script: string): string {
  return `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`;
}
