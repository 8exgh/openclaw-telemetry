#!/usr/bin/env node
/* openclaw-telemetry — call-home reporter for OpenClaw AI workers.
 *
 * First run asks where home is and for the access key, then keeps a
 * background job that POSTs one imprint every 10 minutes:
 *
 *   $ openclaw-telemetry
 *   Telemetry URL [https://8examples.com/openclaw/telemetry]:
 *   Access key (oct_...): ********
 *   Claw name (e.g. openclaw1): openclaw1
 *   started: reporting every 10 minutes (pid 12345)
 *
 * The claw itself can enrich each imprint by writing
 * ~/.openclaw-telemetry/status.json with any of:
 *   { "status": "ok"|"warn"|"error", "model": "...", "tokens": {...},
 *     "errors": [...], "note": "...", "extra": {...} }
 *
 * Zero-prompt installs: set OPENCLAW_TELEMETRY_TOKEN and
 * OPENCLAW_TELEMETRY_CLAW (or CLAW_USERNAME) in the environment and every
 * command works without a config file; OPENCLAW_TELEMETRY_URL overrides
 * the default home. Environment beats the config file key by key.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.1";
const DIR = path.join(os.homedir(), ".openclaw-telemetry");
const CONFIG = path.join(DIR, "config.json");
const STATUS = path.join(DIR, "status.json");
const PIDFILE = path.join(DIR, "pid");
const LOG = path.join(DIR, "log");
const DEFAULT_URL = "https://8examples.com/openclaw/telemetry";
const INTERVAL_MS = 10 * 60 * 1000;
const SELF = fileURLToPath(import.meta.url);

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function log(line) {
  ensureDir();
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.appendFileSync(LOG, entry);
    const { size } = fs.statSync(LOG);
    if (size > 512 * 1024) {
      const tail = fs.readFileSync(LOG, "utf8").slice(-128 * 1024);
      fs.writeFileSync(LOG, tail);
    }
  } catch {
    /* logging must never kill the loop */
  }
}

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (answer) => {
      resolve(answer.trim() || fallback || "");
    });
  });
}

function normalizeUrl(input) {
  let url = input.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  return url.replace(/\/+$/, "");
}

/* Environment beats the config file, key by key. Returns null when no
   complete configuration exists either way. */
function loadConfig() {
  const file = readJson(CONFIG) ?? {};
  const url = process.env.OPENCLAW_TELEMETRY_URL || file.url || DEFAULT_URL;
  const token = process.env.OPENCLAW_TELEMETRY_TOKEN || file.token;
  const claw = process.env.OPENCLAW_TELEMETRY_CLAW || process.env.CLAW_USERNAME || file.claw;
  if (!token || !claw) return null;
  return { url: normalizeUrl(url), token, claw };
}

async function setup() {
  const existing = readJson(CONFIG) ?? {};
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const url = normalizeUrl(await ask(rl, "Telemetry URL", existing.url || DEFAULT_URL));
  const token = await ask(rl, "Access key (oct_...)", existing.token);
  const claw = await ask(rl, "Claw name (e.g. openclaw1)", existing.claw);
  rl.close();
  if (!token || !claw) {
    console.error("An access key and a claw name are required. Ask your 8Examples admin for a key.");
    process.exit(1);
  }
  ensureDir();
  fs.writeFileSync(CONFIG, JSON.stringify({ url, token, claw }, null, 2), { mode: 0o600 });
  console.log(`saved ${CONFIG}`);
  return { url, token, claw };
}

function imprint(config, lastError) {
  const clawStatus = readJson(STATUS) ?? {};
  const errors = Array.isArray(clawStatus.errors) ? [...clawStatus.errors] : [];
  if (lastError) errors.push(`telemetry: previous send failed: ${lastError}`);
  return {
    claw: config.claw,
    at: new Date().toISOString(),
    status: clawStatus.status ?? (errors.length > 0 ? "warn" : "ok"),
    ...(clawStatus.model ? { model: clawStatus.model } : {}),
    ...(clawStatus.tokens ? { tokens: clawStatus.tokens } : {}),
    ...(errors.length > 0 ? { errors: errors.slice(0, 20) } : {}),
    ...(clawStatus.note ? { note: clawStatus.note } : {}),
    host: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      memFreeMB: Math.round(os.freemem() / 1048576),
      memTotalMB: Math.round(os.totalmem() / 1048576),
    },
    ...(clawStatus.extra ? { extra: clawStatus.extra } : {}),
    agent: { name: "openclaw-telemetry", version: VERSION },
  };
}

async function send(config, lastError) {
  const body = JSON.stringify({ claws: [imprint(config, lastError)] });
  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
}

async function runLoop() {
  const config = loadConfig();
  if (!config) {
    console.error("Not configured. Run: openclaw-telemetry (or set OPENCLAW_TELEMETRY_TOKEN and OPENCLAW_TELEMETRY_CLAW)");
    process.exit(1);
  }
  ensureDir();
  fs.writeFileSync(PIDFILE, String(process.pid));
  log(`run: pid ${process.pid}, reporting ${config.claw} -> ${config.url} every 10m`);
  let lastError = null;
  const tick = async () => {
    try {
      await send(config, lastError);
      log(`sent imprint for ${config.claw}`);
      lastError = null;
    } catch (err) {
      lastError = err.message ?? String(err);
      log(`send failed: ${lastError}`);
    }
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
}

function runningPid() {
  const pid = Number(fs.readFileSync(PIDFILE, "utf8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function start() {
  try {
    const pid = runningPid();
    if (pid) {
      console.log(`already running (pid ${pid})`);
      return;
    }
  } catch {
    /* no pidfile yet */
  }
  ensureDir();
  const out = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [SELF, "run"], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log(`started: reporting every 10 minutes (pid ${child.pid})`);
  console.log(`log: ${LOG}`);
}

function stop() {
  try {
    const pid = runningPid();
    if (!pid) {
      console.log("not running");
      return;
    }
    process.kill(pid);
    fs.rmSync(PIDFILE, { force: true });
    console.log(`stopped (pid ${pid})`);
  } catch {
    console.log("not running");
  }
}

function status() {
  const config = loadConfig();
  let pid = null;
  try {
    pid = runningPid();
  } catch {
    /* not running */
  }
  console.log(pid ? `running (pid ${pid})` : "not running");
  if (config) console.log(`claw ${config.claw} -> ${config.url}`);
  try {
    const tail = fs.readFileSync(LOG, "utf8").trim().split("\n").slice(-5);
    console.log("recent:");
    for (const line of tail) console.log("  " + line);
  } catch {
    /* no log yet */
  }
}

const cmd = process.argv[2] ?? "";
switch (cmd) {
  case "run":
    runLoop();
    break;
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "once": {
    const config = loadConfig();
    if (!config) {
      console.error("Not configured. Run: openclaw-telemetry (or set OPENCLAW_TELEMETRY_TOKEN and OPENCLAW_TELEMETRY_CLAW)");
      process.exit(1);
    }
    send(config, null)
      .then(() => console.log("sent"))
      .catch((err) => {
        console.error("send failed:", err.message);
        process.exit(1);
      });
    break;
  }
  case "setup":
    setup();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(
      [
        "openclaw-telemetry — call-home reporter for OpenClaw AI workers",
        "",
        "  openclaw-telemetry          set up if needed, then start the background job",
        "  openclaw-telemetry once     send a single imprint now",
        "  openclaw-telemetry status   show the daemon and its recent sends",
        "  openclaw-telemetry stop     stop the background job",
        "  openclaw-telemetry setup    re-run configuration",
        "",
        `config: ${CONFIG}`,
        `claw-writable status file: ${STATUS}`,
      ].join("\n")
    );
    break;
  default: {
    (async () => {
      if (!loadConfig()) await setup();
      start();
    })();
  }
}
