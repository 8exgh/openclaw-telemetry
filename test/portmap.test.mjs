import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("bin/openclaw-telemetry.mjs");

/* Async exec: a sync exec would block this process's event loop — which the
   in-process test HTTP server needs in order to answer the child. */
function runCheck(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, "portmap-check"], { encoding: "utf8", env: { ...process.env, ...env } }, (error, stdout) => {
      resolve({ status: error?.code ?? 0, stdout });
    });
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

test("portmap ok when the hostname answers anything but 404", async () => {
  const srv = await listen((_req, res) => {
    res.statusCode = 401; // e.g. the claw gateway asking for auth
    res.end("unauthorized");
  });
  try {
    const { stdout } = await runCheck({ OPENCLAW_TELEMETRY_PORTMAP: `http://127.0.0.1:${srv.port}` });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.status, 401);
  } finally {
    srv.close();
  }
});

test("portmap fails on 404: the catch-all answer of an unmapped hostname", async () => {
  const srv = await listen((_req, res) => {
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    const child = await runCheck({ OPENCLAW_TELEMETRY_PORTMAP: `http://127.0.0.1:${srv.port}` });
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.match(result.error, /not mapped/);
    assert.equal(child.status, 1);
  } finally {
    srv.close();
  }
});

test("portmap fails when nothing is listening", async () => {
  const child = await runCheck({ OPENCLAW_TELEMETRY_PORTMAP: "http://127.0.0.1:9" });
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("portmap is disabled with OPENCLAW_TELEMETRY_PORTMAP=off", async () => {
  const { stdout } = await runCheck({ OPENCLAW_TELEMETRY_PORTMAP: "off" });
  assert.equal(JSON.parse(stdout), null);
});
