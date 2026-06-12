---
name: lark-cli
description: Use when an agent needs to perform real Feishu/Lark actions through the official larksuite/cli tool, including Docs, Wiki, Calendar, Tasks, Drive, Messenger, and discovery via official agent skills.
---

# Lark CLI

Use this skill when the user wants a real Feishu/Lark action completed through the official [`larksuite/cli`](https://github.com/larksuite/cli) project.

This skill replaces the old local `feishu-official-ops` and `feishu-canvas` workflows.

## Required Setup

The host must have the official CLI installed:

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
```

Before doing real work, verify the CLI exists:

```bash
lark-cli --help
```

If it is missing, stop and report the blocker instead of falling back to the old local Feishu scripts.

## Default Rule

Prefer the official `lark-cli` command surface over local wrappers:

1. Use `lark-cli <service> +<shortcut>` first.
2. If a shortcut is not enough, inspect `lark-cli schema <service>.<resource>.<method>`.
3. Then call `lark-cli <service> <resource> <method>`.
4. Only use `lark-cli api ...` as the last resort.

## Core Flows

### Docs

- Create a document:

```bash
lark-cli docs +create --title "Weekly Report" --markdown "# Progress\n- Completed feature X"
```

- Append or update an existing document:

```bash
lark-cli docs +update --doc "<doc_id_or_url>" --mode append --markdown "## Update\n\nNew content"
```

- Search documents or spreadsheets before deciding which domain skill to use:

```bash
lark-cli docs +search --query "项目周报"
```

### Wiki

- Inspect or manage wiki nodes via `lark-cli wiki ...`.
- If a wiki link is provided, first resolve the real object/token instead of assuming the wiki token is the doc token.

### Calendar

- View agenda:

```bash
lark-cli calendar +agenda
```

- Recommend time slots before creating a meeting when time is uncertain:

```bash
lark-cli calendar +suggestion --start "2026-03-30T09:00:00+08:00" --end "2026-03-30T18:00:00+08:00" --duration-minutes 30
```

- Create an event after time is confirmed:

```bash
lark-cli calendar +create --summary "项目评审" --start "2026-03-30T14:00:00+08:00" --end "2026-03-30T15:00:00+08:00"
```

### Tasks

- Create a task:

```bash
lark-cli task +create --summary "整理发布清单"
```

- List my tasks:

```bash
lark-cli task +get-my-tasks
```

## Rules

- Do not use `feishu-canvas`; document workspace requests should go through `lark-cli docs +create` and `lark-cli docs +update`.
- Do not use the old `feishu-openapi.mjs` script.
- When command parameters are unclear, inspect `schema` first instead of guessing.
- Report the real returned IDs, URLs, and metadata after successful writes.
- If auth or config is missing, report the exact missing step.
