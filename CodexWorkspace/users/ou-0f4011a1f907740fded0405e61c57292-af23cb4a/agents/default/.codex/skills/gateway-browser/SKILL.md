---
name: gateway-browser
description: Use when tasks require operating web pages. Run the bundled browser script in this skill so browser actions stay observable and reversible.
---

# Gateway Browser Skill

When the user asks for browser operations, run the bundled browser script in this skill.

Workflow:
1. Read current page state with `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs snapshot` before deciding the next action.
2. Execute one minimal action at a time (click/type/select-option/navigate/wait-for).
3. Re-run `snapshot` after each key action; refs are not stable across navigations.
4. If needed, use `screenshot`, `tabs`, `evaluate`, or recording commands to collect evidence.
5. Report action, evidence, result, and next step.

Environment:
- `GATEWAY_BROWSER_API_BASE`
- `GATEWAY_INTERNAL_API_TOKEN`

Examples:
- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs snapshot`
- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs navigate --url "https://example.com"`
- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs click --ref e1`
- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs type --ref e2 --text "hello" --submit true`
- `node ./.codex/skills/gateway-browser/scripts/gateway-browser.mjs tabs --action list`

Report format:
- Action: what changed on the page in this step.
- Evidence: snapshot/screenshot/console/network findings that support the conclusion.
- Result: success, blocked state, or failure reason.
- Next step: the next minimal action or the exact user takeover request.

Status templates:
- In progress: report the latest action, current evidence, and immediate next step.
- Blocked: report the blocker, risk, and the exact decision needed from the user.
- Handoff: report why user takeover is required, what state is preserved, and how to resume.
- Done: report what was completed, the final result/artifact, and any follow-up suggestion.

Stop conditions:
- Stop when the page intent is ambiguous, multiple similar targets exist, or the expected page state did not appear.
- Stop when a modal, redirect, or permission prompt changes the task scope unexpectedly.
- Stop when the action would send external data, upload files, or submit content the user did not explicitly approve.
- When stopping, report the last confirmed page state and the exact decision needed from the user.

Rules:
- Reuse existing tabs whenever possible.
- Prefer visible, reversible actions over hidden shortcuts.
- Do not run Playwright directly or invent another browser wrapper; use only the script bundled in this skill.
- On login/OTP/captcha/payment confirmation, request user takeover.
- Before submit/delete/publish/payment or other irreversible actions, capture evidence and confirm intent if the user did not state it explicitly.
- If the page is visually unclear or the user asks what is on screen, capture a screenshot instead of guessing from stale refs.
- If an action fails twice, stop and ask for user decision.
- If a click/type fails, refresh the snapshot first, then inspect console/network before retrying.
- During user takeover, keep the current tab/state intact and report the exact resume point.
- Treat logged-in browser profiles, cookies, and storage as sensitive data.
- Avoid arbitrary page-context JS unless it is necessary to inspect or unblock the task.
