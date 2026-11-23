# Claude Gravity Bridge (agy-bridge)

[![GitHub stars](https://img.shields.io/github/stars/thecrystoria-svg/claude-gravity-bridge?style=social)](https://github.com/thecrystoria-svg/claude-gravity-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=22](https://img.shields.io/badge/Node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Protocol: MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-purple.svg)](https://modelcontextprotocol.io/)
[![Claude Desktop](https://img.shields.io/badge/Claude-Desktop_Compatible-orange.svg)](https://claude.ai/download)

A small, local MCP server that lets Claude send tasks to the **Antigravity desktop app** and read back the results.

- Drives the desktop app itself (not the CLI or IDE plugin).
- Zero dependencies. Node 22 or newer.
- Opens no network port. Nothing leaves your PC.
- The launcher script is for Windows (PowerShell). The server itself is plain Node and the test suite runs on any OS.

## How it works

```
Claude  --(stdio pipe)-->  agy-bridge  --(127.0.0.1 debug port)-->  Antigravity app
                               |                                         |
                               +--- writes  inbox/<id>.md  <-------------+ agent reads it
                               +--- reads   outbox/<id>.md + .done  <----+ agent writes it
```

1. `ag_send` writes the full task (with safety rules) to `inbox/<id>.md`.
2. The bridge types one short line into the agent chat: "Read the file ... and follow it".
3. The agent writes its report to `outbox/<id>.md`, then creates `outbox/<id>.done` holding a one-time code.
4. `ag_result` finishes only when that code matches. The bridge never guesses completion from the screen.

If auto-typing fails, the task becomes `manual_pending` and Claude gets the exact one-line message for you to paste. Nothing is lost.

## Install

You need: Windows, Node 22+, the Antigravity desktop app, and Claude desktop.

1. **Get the code.**
   ```powershell
   git clone https://github.com/thecrystoria-svg/claude-gravity-bridge.git C:\tools\agy-bridge
   cd C:\tools\agy-bridge
   npm test        # optional: 14 tests against a fake app
   ```
2. **Add it to Claude desktop.** Open Claude desktop, then Settings, Developer, Edit Config. Add this under `mcpServers` (also in `claude-config-snippet.json`) and fix the two paths:
   ```json
   "agy-bridge": {
     "command": "C:\\Program Files\\nodejs\\node.exe",
     "args": ["C:\\tools\\agy-bridge\\src\\server.mjs"],
     "env": {
       "AGY_PROJECT_DIR": "C:\\path\\to\\your\\project"
     }
   }
   ```
   `AGY_PROJECT_DIR` is required. The bridge refuses to send tasks without it, and tasks can only run inside that folder. Fully quit and reopen Claude desktop.
3. **Start Antigravity with a private debug port.** Close Antigravity completely (check the tray), then run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tools\agy-bridge\scripts\start-antigravity.ps1
   ```
   Wait for the green "OK ... local-only" line. If the app is not found, pass `-Exe "C:\full\path\Antigravity.exe"`. If it is already running, close it or add `-ForceClose`.
4. **Open your project** in Antigravity and open its agent chat panel.
5. **Check it from Claude.** Ask: "run ag_status". It should say `reachable: true`. Then "run ag_diagnose" to see the chat box the bridge will type into.
6. **Try a harmless task first**: "ask Antigravity to list the files in the project and report the count".

To turn the bridge off, close Antigravity and start it normally from the Start menu. No debug port is open then.

## Usage

Just talk to Claude. Examples:

- "Ask Antigravity to run the tests and report the result."
- "Check what Antigravity is doing now." (uses `ag_read_screen`)
- "Stop Antigravity." (uses `ag_buttons` to find the Stop button, then `ag_stop`)

Claude sends a task with `ag_send`, gets a task id back immediately, then polls `ag_result` until the agent finishes or the timeout is reached.

### Tools

| Tool | What it does |
|---|---|
| `ag_status` | Health check: is the app reachable, which tasks are active |
| `ag_diagnose` | Lists the input boxes the bridge can see (to tune `AGY_INPUT_SELECTOR`) |
| `ag_send` | Sends a task to the agent. Returns a task id |
| `ag_result` | Waits up to `wait_ms` (max 45 000) for completion, then returns the status or report |
| `ag_tasks` | Lists recent tasks |
| `ag_cancel` | Stops tracking a task (does not stop the agent) |
| `ag_read_screen` | Reads the visible text of the app window (secrets redacted) |
| `ag_buttons` | Lists visible button labels (read-only) |
| `ag_stop` | Clicks the agent's Stop button. Never clicks Allow, Run or Approve. Refuses unless exactly one match |
| `ag_screenshot` | Saves a screenshot of the app window and returns the file path |

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `AGY_PROJECT_DIR` | none, **required** | The only folder tasks may work in |
| `AGY_BRIDGE_DIR` | `~/.agy-bridge/data` | Where `inbox/`, `outbox/`, `audit.log` and `port` live |
| `AGY_CDP_PORT` | read from the port file | Fix the debug port instead of reading it from the launcher's file |
| `AGY_PORT_FILE` | `~/.agy-bridge/port` | Backup location of the port file |
| `AGY_TARGET_MATCH` | any window | Text to match when the app has several windows |
| `AGY_INPUT_SELECTOR` | auto-detect | CSS selector of the agent chat box, if `ag_diagnose` shows a wrong one |
| `AGY_STOP_SELECTOR` | auto-detect | CSS selector of the Stop button |

## Security model

| Threat | Defence |
|---|---|
| Someone on the internet or Wi-Fi | The bridge opens **no port and no server**. It talks to Claude over a stdio pipe only |
| Debug port of the app | Random port each launch, loopback only. The launcher checks it listens on 127.0.0.1 and **closes the app if not**. The bridge refuses any host except 127.0.0.1 |
| A website in your browser | The bridge sends no `Origin` header and the launcher never sets `--remote-allow-origins`, so Chromium rejects browser pages |
| Secrets leaking to Claude or logs | Output is scrubbed for keys, tokens, passwords, connection strings and private keys |
| Claude passing secrets into the app | `ag_send` refuses any prompt that looks like it contains a secret. You type secrets yourself |
| Claude running its own code in the app | Only fixed built-in page scripts run. Claude cannot supply script text |
| Fake completion | The `.done` file must be a small regular file with the task's one-time code. Symlinks are rejected |
| Path tricks | Task ids must be 16 hex characters. Every path is checked to stay inside the bridge folder |
| Runaway use | One active task at a time, 30 per hour, 20 000 character prompts, every task has a timeout |
| Agent does something risky | The task wrapper tells the agent to stay in the project folder, never handle secrets, and stop with `NEEDS APPROVAL` for destructive steps. **The bridge never clicks "approve" or "run".** Antigravity's own permission prompts stay on and are yours to answer |
| Malicious text in a report | Reports are returned with a warning that they are untrusted data |
| Audit | `audit.log` records every call (no prompt text, no secrets) |

### What this does NOT protect against

- While the debug port is on, **any program running as your Windows user** can control the app through it. That is how Chromium debugging works. Keep it on only while you use the bridge.
- The agent inside Antigravity is itself an AI with access to what you give it. The wrapper rules are instructions, not a sandbox. Open only the project folder in it.
- A prompt-injected agent could write a misleading report. Check important results yourself (for example by re-running the tests).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `reachable: false` | Antigravity was not started by the launcher. Close it fully and run `start-antigravity.ps1` again |
| `no_project` error | Set `AGY_PROJECT_DIR` in the Claude config and restart Claude desktop |
| Task stays `manual_pending` | The bridge could not type into the chat. Paste the one-line message it gives you, or set `AGY_INPUT_SELECTOR` after `ag_diagnose` |
| Launcher says the app is already running | Close it from the tray, or add `-ForceClose` |
| Port file errors | Set `AGY_CDP_PORT` to the port the launcher printed |

## Tests

`npm test` runs 14 tests against a fake app: protocol, secret scrubbing, fake completion, symlinks, hostile host names, the manual fallback, and the one-task limit. They do not need Antigravity.

## Limits

This bridge depends on how the Antigravity window is built. A big app update can change the chat box or Stop button, which is what `AGY_INPUT_SELECTOR` and `AGY_STOP_SELECTOR` are for.

## License

MIT, see `LICENSE`.

---

## 🏷️ Search Keywords & Tags

`claude-desktop` · `antigravity` · `model-context-protocol` · `mcp` · `mcp-server` · `claude-bridge` · `claude-gravity-bridge` · `agentic-ai` · `autonomous-agents` · `ai-developer-tools` · `claude-tools` · `chrome-devtools-protocol` · `cdp` · `desktop-automation` · `llm-agents` · `claude-ai` · `developer-tools` · `anthropic` · `claude-desktop-mcp`
