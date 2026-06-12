---
name: social-intel
description: Use when a task needs public social media research across one or more platforms, such as trend tracking, competitor monitoring, account research, or source collection before writing a report.
---

# Social Intel

Use this skill for cross-platform public research.

Workflow:
- Clarify the platform scope, keywords, entities, time range, and output goal.
- If the task is single-platform and needs depth, switch to the matching platform skill.
- Use `./.codex/skills/gateway-browser/SKILL.md` for public-page browsing and evidence capture.
- Record sources, publish time, author/account, summary, and evidence before drawing conclusions.
- Distinguish between no results, login required, page blocked, and insufficient evidence.

Rules:
- Default boundary: public pages and user-accessible pages only; do not imply private/API access.
- Never fabricate metrics, timestamps, authors, or rankings.
- If evidence is weak or partial, say so explicitly and list the gaps.
- For cross-platform summaries, keep platform findings separate before synthesizing.

Minimum result fields:
- platform
- query
- title
- author/account
- published_at
- url
- evidence
- notes
