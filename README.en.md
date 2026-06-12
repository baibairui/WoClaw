# AgentClaw

[中文说明](./README.md)

[![CI](https://github.com/baibairui/AgentClaw/actions/workflows/ci.yml/badge.svg)](https://github.com/baibairui/AgentClaw/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

Bring Codex CLI into Feishu, WeCom, or personal WeChat as a long-running multi-agent teammate with persistent workspaces, memory, tools, and execution.

AgentClaw is for teams that want more than a chat bot. Each agent gets its own working directory, long-term identity, short-term memory, local skills, browser automation, and operational channel entry points.

## Why People Star It

- It turns Codex CLI from a solo terminal tool into a team-facing persistent agent system.
- It gives every agent an isolated workspace and memory boundary, so tasks do not contaminate each other.
- It supports real execution, not just answers: browser actions, reminders, Feishu API operations, document workflows, and custom local skills.
- It is self-hosted, so credentials, context, workspaces, and automation stay under your control.

## How AgentClaw Differs From Typical Chat Bots

| Capability | AgentClaw | Typical Chat Bot |
| --- | --- | --- |
| Long-lived agent workspaces | Yes | Usually no |
| Separate memory per agent | Yes | Usually shared or ephemeral |
| Codex CLI execution in real project directories | Yes | Rare |
| Local skill system | Yes | Rare |
| Feishu / WeCom / WeChat entry points | Yes | Often single-channel |
| Self-hosted deployment | Yes | Often SaaS-only |

## Core Use Cases

- Run a coding agent from Feishu or WeCom and keep context across many sessions.
- Give different responsibilities to different agents: engineer, reviewer, researcher, doc writer, ops assistant.
- Let an agent open a browser, inspect pages, write files, update docs, and report back in chat.
- Keep memory and execution inside your own infrastructure instead of outsourcing the workflow to a hosted bot.
- Wrap internal automation as local skills and let agents invoke it directly.

## How It Works

```text
Feishu / WeCom / WeChat
        |
        v
      AgentClaw
        |
        +--> user / session / agent routing
        +--> agent-specific workspace and memory
        +--> Codex CLI / OpenCode runner
        +--> local skills / browser / reminders / platform APIs
        |
        v
   replies + updated state
```

## Channel Support

| Channel | Status | Notes |
| --- | --- | --- |
| Feishu | Supported | Long connection mode available |
| WeCom | Supported | Requires a public callback endpoint |
| Personal WeChat | Supported | QR login and polling flow |

## Quick Start

### 1. Prerequisites

- Node.js 20+
- npm 10+
- An installed `codex` CLI
- At least one configured channel: Feishu, WeCom, or WeChat

Optional but useful:

- Playwright for browser automation
- `xvfb` for headless Linux servers
- Nginx, FRP, ngrok, or another reverse proxy / tunnel

Install dependencies:

```bash
npm install
```

Optional browser runtime:

```bash
npx playwright install chromium
```

### 2. Create configuration

```bash
cp .env.example .env
```

Or use the setup wizard:

```bash
agentclaw setup
```

### 3. Minimal configuration examples

Feishu:

```env
PORT=3000
WECOM_ENABLED=false
FEISHU_ENABLED=true
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_LONG_CONNECTION=true
CODEX_BIN=codex
CODEX_WORKDIR=/absolute/path/to/agent-root
CODEX_SANDBOX=full-auto
RUNNER_ENABLED=true
```

Agent runs always use isolated `bwrap` workspaces now; `CODEX_WORKDIR_ISOLATION` is no longer configurable.

WeCom:

```env
PORT=3000
WECOM_ENABLED=true
WEWORK_CORP_ID=your_corp_id
WEWORK_SECRET=your_secret
WEWORK_AGENT_ID=your_agent_id
WEWORK_TOKEN=your_callback_token
WEWORK_ENCODING_AES_KEY=your_encoding_aes_key
CODEX_BIN=codex
CODEX_WORKDIR=/absolute/path/to/agent-root
RUNNER_ENABLED=true
```

WeChat:

```env
PORT=3000
WECOM_ENABLED=false
FEISHU_ENABLED=false
WEIXIN_ENABLED=true
CODEX_BIN=codex
CODEX_WORKDIR=/absolute/path/to/agent-root
RUNNER_ENABLED=true
```

If WeChat is enabled and no session exists yet:

```bash
npm run weixin:login
```

### 4. Start AgentClaw

Development:

```bash
agentclaw doctor
agentclaw up
```

Production:

```bash
npm run build
agentclaw start
```

### 5. Check health

```bash
curl http://127.0.0.1:3000/healthz
```

## Why The Workspace Model Matters

Each agent gets its own workspace, identity, and short-term memory. That is the main reason the system remains stable over time.

Typical layout:

```text
.data/
  users/<user>/
    user.md
    agents/<agent>/
      AGENTS.md
      README.md
      SOUL.md
      memory/daily/
      .codex/workspace.json
```

This keeps:

- long-term user identity in `user.md`
- long-term agent identity in `SOUL.md`
- short-lived context in `memory/daily/`
- execution constrained to a concrete agent workspace

## Built-In Capability Areas

- Multi-agent routing and session persistence
- Feishu, WeCom, and WeChat channel adapters
- Workspace-scoped local skill loading
- Browser and desktop automation integration
- Reminder and recurring follow-up flows
- Health checks and PM2-friendly deployment

## Common Commands

```bash
npm run dev
npm run build
npm run weixin:login
npm run config:check
npm run publish:workspace
```

Using the local CLI:

```bash
agentclaw setup
agentclaw doctor
agentclaw up
agentclaw start
```

## Deployment Notes

- `deploy.sh` publishes the current workspace to a target server while preserving `.env` and `.data`.
- PM2 is the default production process manager in the built-in deployment flow.
- `/healthz` is the main readiness endpoint.
- `CODEX_WORKDIR` should point to the agent root, while each execution must still use a concrete agent workspace.

## FAQ

### Is this a bot or an agent runtime?

Closer to an agent runtime. Messaging is only the entry point.

### Does it support multiple agents per user?

Yes. That is a core design goal.

### Can it perform real actions instead of only replying?

Yes. That is the purpose of the skill system and execution runners.

### Does it require SaaS hosting?

No. It is designed for self-hosted deployment.

### Is WeChat login interactive?

Yes. Initial login uses QR-based authorization and stores the session locally afterwards.

## Contributing

Issues and PRs are welcome. Strong contributions usually include:

- a clear use case
- a minimal reproduction for bugs
- validation notes for behavior changes
- README or docs updates when external behavior changes

Start with [CONTRIBUTING.md](./CONTRIBUTING.md), then open an issue or PR.

## Project Status

AgentClaw is actively evolving. The repository is optimized for real-world deployments first, so some parts still reflect operator workflows more than polished product UX. Improvements that make installation, docs, reproducibility, and demos better are especially valuable.

## License

[ISC](./LICENSE)
