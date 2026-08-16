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
 * Each imprint also exercises the web browser: headless-load a page that
 * should always work (default https://example.com/) and verify HTML comes
 * back. Failures are appended to `errors`; the result rides along as a
 * `browser` field. OPENCLAW_TELEMETRY_BROWSER picks the binary ("off"
 * disables the check); OPENCLAW_TELEMETRY_BROWSER_URL overrides the page.
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

const VERSION = "0.3.0";
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

const BROWSER_CHECK_URL = process.env.OPENCLAW_TELEMETRY_BROWSER_URL || "https://example.com/";
const BROWSER_CHECK_TIMEOUT_MS = 30 * 1000;
const BROWSER_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "brave-browser",
  "microsoft-edge",
];

function findBrowser() {
  const chosen = process.env.OPENCLAW_TELEMETRY_BROWSER;
  if (chosen) return chosen;
  // Managed OpenClaw containers deliberately keep Chromium outside PATH.
  // Prefer the same executable/wrapper the OpenClaw browser plugin uses.
  const openClawBrowser = process.env.OPENCLAW_BROWSER_EXECUTABLE_PATH;
  if (openClawBrowser) {
    try {
      fs.accessSync(openClawBrowser, fs.constants.X_OK);
      return openClawBrowser;
    } catch {
      /* fall through to Playwright's shared browser cache */
    }
  }
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of BROWSER_CANDIDATES) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  const playwrightRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    "/opt/ms-playwright",
  ].filter(Boolean);
  const relativeExecutables = [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    ["chrome-headless-shell-linux", "chrome-headless-shell"],
  ];
  for (const root of [...new Set(playwrightRoots)]) {
    let revisions;
    try {
      revisions = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const revision of revisions) {
      if (!/^chromium/.test(revision.name)) continue;
      for (const parts of relativeExecutables) {
        const candidate = path.join(root, revision.name, ...parts);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

/* Headless-load a page that should always work and verify HTML comes back.
   Resolves to { ok, bin, url, ms, error? }, or null when disabled. Never
   rejects. */
function checkBrowser() {
  return new Promise((resolve) => {
    if (/^(off|none|0|false)$/i.test(process.env.OPENCLAW_TELEMETRY_BROWSER ?? "")) {
      return resolve(null);
    }
    const bin = findBrowser();
    if (!bin) {
      return resolve({
        ok: false,
        url: BROWSER_CHECK_URL,
        error: "no browser binary found (set OPENCLAW_TELEMETRY_BROWSER)",
      });
    }
    const name = path.basename(bin);
    const started = Date.now();
    /* --no-sandbox matches how OpenClaw containers launch the browser. */
    const child = spawn(
      bin,
      ["--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", BROWSER_CHECK_URL],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let errOut = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        bin: name,
        url: BROWSER_CHECK_URL,
        ms: Date.now() - started,
        error: `page load timed out after ${BROWSER_CHECK_TIMEOUT_MS / 1000}s`,
      });
    }, BROWSER_CHECK_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      if (out.length < 262144) out += d;
    });
    child.stderr.on("data", (d) => {
      if (errOut.length < 8192) errOut += d;
    });
    child.on("error", (err) => {
      finish({ ok: false, bin: name, url: BROWSER_CHECK_URL, error: `could not launch: ${err.message}` });
    });
    child.on("close", (code) => {
      const ms = Date.now() - started;
      if (code === 0 && /<html[\s>]/i.test(out)) {
        return finish({ ok: true, bin: name, url: BROWSER_CHECK_URL, ms });
      }
      const lastLine = errOut.trim().split("\n").pop() ?? "";
      const error =
        code === 0
          ? "page loaded but returned no HTML"
          : `exit ${code}${lastLine ? `: ${lastLine.slice(0, 200)}` : ""}`;
      finish({ ok: false, bin: name, url: BROWSER_CHECK_URL, ms, error });
    });
  });
}

const PORTMAP_DEFAULT_DOMAIN = "fusenv.com";
const PORTMAP_TIMEOUT_MS = 10_000;

/* Each claw instance gets its own subdomain: <claw>.fusenv.com. Override the
   full target with OPENCLAW_TELEMETRY_PORTMAP (or disable with "off"); change
   just the domain with OPENCLAW_TELEMETRY_PORTMAP_DOMAIN. */
function portmapTarget(claw) {
  const override = process.env.OPENCLAW_TELEMETRY_PORTMAP ?? "";
  if (/^(off|none|0|false)$/i.test(override)) return null;
  if (override) return override.includes("://") ? override : `https://${override}`;
  if (!claw) return null;
  const domain = process.env.OPENCLAW_TELEMETRY_PORTMAP_DOMAIN || PORTMAP_DEFAULT_DOMAIN;
  return `https://${claw}.${domain}`;
}

/* Verify the claw's public hostname actually routes somewhere: tunnel and
   wildcard catch-alls answer 404, a mapped claw gateway answers anything
   else. Resolves to { ok, url, status?, ms, error? }, or null when disabled.
   Never rejects. */
async function checkPortmap(claw) {
  const url = portmapTarget(claw);
  if (!url) return null;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PORTMAP_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (res.status === 404) {
      return {
        ok: false,
        url,
        status: 404,
        ms,
        error: "hostname resolves but is not mapped to this claw (catch-all 404): check the tunnel ingress + DNS record",
      };
    }
    return { ok: true, url, status: res.status, ms };
  } catch (err) {
    const ms = Date.now() - started;
    const error =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `no response within ${PORTMAP_TIMEOUT_MS / 1000}s`
        : err?.cause?.code ?? err?.message ?? String(err);
    return { ok: false, url, ms, error };
  }
}

function imprint(config, lastError, browser, portmap) {
  const clawStatus = readJson(STATUS) ?? {};
  const errors = Array.isArray(clawStatus.errors) ? [...clawStatus.errors] : [];
  if (lastError) errors.push(`telemetry: previous send failed: ${lastError}`);
  if (browser && !browser.ok) errors.push(`browser: ${browser.error}`);
  if (portmap && !portmap.ok) errors.push(`portmap: ${portmap.url}: ${portmap.error}`);
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
    ...(browser ? { browser } : {}),
    ...(portmap ? { portmap } : {}),
    ...(clawStatus.extra ? { extra: clawStatus.extra } : {}),
    agent: { name: "openclaw-telemetry", version: VERSION },
  };
}

async function send(config, lastError, browser, portmap) {
  const body = JSON.stringify({ claws: [imprint(config, lastError, browser, portmap)] });
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
    const browser = await checkBrowser();
    if (browser) {
      log(
        browser.ok
          ? `browser ok: ${browser.bin} loaded ${browser.url} in ${browser.ms}ms`
          : `browser check failed: ${browser.error}`
      );
    }
    const portmap = await checkPortmap(config.claw);
    if (portmap) {
      log(
        portmap.ok
          ? `portmap ok: ${portmap.url} answered ${portmap.status} in ${portmap.ms}ms`
          : `portmap check failed: ${portmap.url}: ${portmap.error}`
      );
    }
    try {
      await send(config, lastError, browser, portmap);
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
    (async () => {
      const browser = await checkBrowser();
      if (browser && !browser.ok) console.error(`browser check failed: ${browser.error}`);
      const portmap = await checkPortmap(config.claw);
      if (portmap && !portmap.ok) console.error(`portmap check failed: ${portmap.url}: ${portmap.error}`);
      try {
        await send(config, null, browser, portmap);
        console.log("sent");
      } catch (err) {
        console.error("send failed:", err.message);
        process.exit(1);
      }
    })();
    break;
  }
  case "browser-check":
    checkBrowser().then((browser) => {
      console.log(JSON.stringify(browser));
      if (browser && !browser.ok) process.exitCode = 1;
    });
    break;
  case "portmap-check": {
    const claw =
      process.env.OPENCLAW_TELEMETRY_CLAW || process.env.CLAW_USERNAME || loadConfig()?.claw;
    checkPortmap(claw).then((portmap) => {
      console.log(JSON.stringify(portmap));
      if (portmap && !portmap.ok) process.exitCode = 1;
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
        "  openclaw-telemetry browser-check  test browser discovery and launch",
        "  openclaw-telemetry portmap-check  verify <claw>.fusenv.com routes to this claw",
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
