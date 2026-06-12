---
name: reminder-tool
description: Use when a user asks to be reminded later, at a time, after a delay, or on a schedule in the current chat. Runs the bundled reminder script to create a durable reminder task instead of emitting reminder-action text blocks or asking the user to run /remind.
---

# Reminder Tool

When the user asks for a reminder, run the bundled script in this skill.

Use this workflow:
1. Extract the delay and reminder message.
2. If the delay is ambiguous, ask a follow-up question before running the command.
3. Run `node ./.codex/skills/reminder-tool/scripts/reminder-cli.mjs create --delay <value> --message <text>`.
4. Read the returned JSON and tell the user the reminder has been created. Do not emit fenced action blocks.

Rules:
- Prefer `delay` for simple durations such as `5min`, `2h`, `1d`.
- Keep `message` short, concrete, and action-oriented.
- Never ask the user to type `/remind`.
- Never output ```reminder-action blocks.
- The script expects these env vars to already exist in the runtime: `GATEWAY_REMINDER_DB_PATH`, `GATEWAY_REMINDER_CHANNEL`, `GATEWAY_REMINDER_USER_ID`.

Examples:
- User: `20分钟后提醒我开会`
  Run: `node ./.codex/skills/reminder-tool/scripts/reminder-cli.mjs create --delay 20min --message "开会"`
- User: `明天提醒我交周报`
  If the exact trigger time is unclear, ask for a concrete time first.
