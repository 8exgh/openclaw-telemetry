import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("bin/openclaw-telemetry.mjs");

test("discovers Chromium in PLAYWRIGHT_BROWSERS_PATH when it is not on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telemetry-"));
  const browser = path.join(root, "chromium-1228", "chrome-linux64", "chrome");
  fs.mkdirSync(path.dirname(browser), { recursive: true });
  fs.writeFileSync(browser, "#!/bin/sh\nprintf '<html><body>ok</body></html>'\n", { mode: 0o755 });

  try {
    const output = execFileSync(process.execPath, [cli, "browser-check"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        PLAYWRIGHT_BROWSERS_PATH: root,
        OPENCLAW_BROWSER_EXECUTABLE_PATH: "",
      },
    });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.bin, "chrome");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prefers OPENCLAW_BROWSER_EXECUTABLE_PATH", () => {
  const child = spawnSync(process.execPath, [cli, "browser-check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "",
      PLAYWRIGHT_BROWSERS_PATH: "",
      OPENCLAW_BROWSER_EXECUTABLE_PATH: "/bin/echo",
    },
  });
  const result = JSON.parse(child.stdout);
  assert.equal(result.bin, "echo");
  assert.notEqual(result.error, "no browser binary found (set OPENCLAW_TELEMETRY_BROWSER)");
});
