# openclaw-telemetry

Call-home telemetry reporter for [OpenClaw AI workers](https://8examples.com/openclaw).
Installs globally, asks where home is once, then runs a background job that
phones in one imprint every 10 minutes: status, model, token usage, errors,
and host health.

## Install and run

```
npm install -g openclaw-telemetry
openclaw-telemetry
```

First run asks three questions:

```
Telemetry URL [https://8examples.com/openclaw/telemetry]:
Access key (oct_...): <token from your 8Examples admin>
Claw name (e.g. openclaw1): openclaw1
```

then starts the background job. Config is saved to
`~/.openclaw-telemetry/config.json` (mode 600), so subsequent runs start
straight away.

```
openclaw-telemetry once     # send a single imprint now
openclaw-telemetry status   # daemon state + last sends
openclaw-telemetry stop     # stop the background job
openclaw-telemetry setup    # change URL / key / claw name
```

Admins issue access keys from the Fleet tab at
[8examples.com/account](https://8examples.com/account).

## What it sends

`POST <url>` with `Authorization: Bearer <key>`:

```json
{
  "claws": [
    {
      "claw": "openclaw1",
      "at": "2026-08-13T12:00:00.000Z",
      "status": "ok",
      "model": "claude-fable-5",
      "tokens": { "input": 12000, "output": 3400 },
      "errors": [],
      "note": "free text",
      "host": {
        "hostname": "openclaw-vm",
        "platform": "linux 6.8.0",
        "arch": "x64",
        "uptimeHours": 12.5,
        "load": [0.1, 0.2, 0.15],
        "memFreeMB": 2048,
        "memTotalMB": 8192
      },
      "agent": { "name": "openclaw-telemetry", "version": "0.1.0" }
    }
  ]
}
```

## Letting the claw speak for itself

The reporter merges `~/.openclaw-telemetry/status.json` into every imprint,
so the worker (or anything else on the machine) can keep it current:

```json
{
  "status": "ok",
  "model": "claude-fable-5",
  "tokens": { "input": 12000, "output": 3400 },
  "errors": [],
  "note": "processed 14 bookings today",
  "extra": { "queueDepth": 0 }
}
```

`status` may be `ok`, `warn`, or `error`; it drives the color of the claw's
tile on the fleet dashboard.

## Surviving reboots

The daemon does not install itself as a system service. Add one line to cron
if you want it back after a reboot:

```
@reboot /usr/bin/env openclaw-telemetry start
```

## License

MIT
