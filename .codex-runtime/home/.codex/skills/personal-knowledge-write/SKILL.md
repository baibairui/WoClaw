---
name: personal-knowledge-write
description: Use when the user explicitly asks to write, organize, archive, remember, or turn chat content into Jngyen's personal Feishu knowledge system.
---

# Personal Knowledge Write

## Goal

Operate the user's personal Feishu knowledge system safely and consistently.

This skill is the top-level protocol for deciding whether a chat item should be written, where it should live, what must be read first, and when to hand off to content-writing and Feishu execution skills.

## Default Knowledge Space

Default target:

- Name: `个人知识系统`
- `space_id`: `7633290967985949654`
- Purpose: AI-readable and AI-writable personal knowledge system for durable personal knowledge, with writes only after the user explicitly asks to store, organize, archive, remember, or turn content into long-term documentation.

Treat this as the default target for:
- `我的知识库`
- `个人知识系统`
- `记到知识库`
- `整理成文档`
- `归档`
- `放到人生区 / 专业区 / 灵感池 / TODO`

Do not use the older `知识写作库` as a default target. Its useful documents have been copied into `个人知识系统`; keep the older space as historical context only.

## Trigger Rule

Use this skill when the user explicitly asks to:
- write something into the knowledge system
- organize a discussion into a knowledge-base area
- archive or remember a decision, idea, note, or context
- turn chat context into a durable Feishu document
- put content into `人生区`, `专业区`, `信息流`, `灵感池`, `TODO`, or `归档`

Do not write when the user is only thinking aloud, brainstorming, or asking for an answer in chat.

If the content seems worth preserving but the user did not ask to store it:
- suggest a destination in chat
- ask for confirmation only when useful
- do not execute a Feishu write

## Required Read Order

Before any write into `个人知识系统`:

1. Read `00-系统区 / AI 使用说明`.
2. Read `00-系统区 / 写入与整理规则`.
3. Identify the candidate top-level area.
4. Read the candidate area's `00-目录说明`.
5. Check whether an existing page or subdirectory fits.
6. Decide whether to update, append, create, or leave unchanged.
7. Only then hand off to writing and execution.

This read order is mandatory even when the user names a destination, because the destination's `00-目录说明` may contain boundary rules.

## Top-Level Directory Map

- `00-系统区`
  Rules, navigation, inbox, AI instructions, write policy, and unclassified intake.

- `10-人生区`
  Career choices, internships, relationships, financial constraints, self-understanding, life systems, and long-running personal questions.

- `20-专业区`
  Agent and AI development, software engineering, projects, industry observation, methodology, work systems, and professional research.

- `30-信息流与周期报告`
  Daily notes, weekly reports, news summaries, technology reports, trend tracking, and time-sensitive updates.

- `40-灵感池`
  Early ideas, loose thoughts, product ideas, technical ideas, life ideas, and things worth keeping but not yet structured.

- `50-TODO与时间轴`
  TODOs, action items, waiting items, timelines, and someday/maybe lists. Only write here when the user explicitly asks for TODO, action-item, or timeline organization.

- `90-归档`
  Old rules, obsolete topics, completed projects, migrated legacy documents, and material that should remain searchable but not prominent.

## Common Routing Examples

- "把刚才关于实习选择的讨论整理到人生区"
  Route to `10-人生区 / 职业选择与路径`.

- "把这段 Agent 上下文工程讨论整理到专业区"
  Route to `20-专业区 / Agent 与 AI 开发`, or `20-专业区 / 方法论与工作流` if the durable value is mainly process or methodology.

- "这个想法放到灵感池"
  Route to `40-灵感池`, then choose product, technical, life, or not-actionable subarea after reading the directory description.

- "把行动项整理成 TODO"
  Route to `50-TODO与时间轴`, usually `TODO 总页` unless the directory rules indicate a better destination.

- Gateway troubleshooting, Codex implementation notes, or project investigation records
  Route to `20-专业区 / 项目与实验` unless they are broadly reusable methodology, in which case use `20-专业区 / 方法论与工作流`.

## Write Policy

Prefer updating or appending to existing pages when:
- the topic already has a stable home
- the new content corrects, expands, or supersedes prior content
- a future reader would expect to find the answer in that page

Create a new page only when:
- the topic is durable enough to deserve a separate page
- the title and boundary are clear
- the selected directory can hold similar future material

If no destination fits cleanly:
- use `00-系统区 / 收件箱` for unclassified intake
- use `40-灵感池` for ideas that are not yet actionable or structured
- ask the user before creating a new top-level category

## Directory Creation Rules

Do not create new top-level directories without explicit user confirmation.

Creating a second- or third-level directory is allowed only when:
- existing directories do not fit cleanly
- the new directory is a durable category, not a one-off convenience
- its role and boundary can be explained in one sentence

If creating a new subdirectory, also create a `00-目录说明` in it.

The `00-目录说明` must explain:
- what belongs there
- what does not belong there
- common document types
- boundaries against nearby directories

## Safety Rules

Do not store:
- secrets, tokens, passwords, app secrets, or private credentials
- raw runtime state that only matters temporarily
- full unfiltered logs when a short evidence summary is enough
- large chat dumps without distillation
- private data unrelated to the user's explicit storage request

For debugging or operational records, preserve exact paths, IDs, dates, and observed facts only when they help future reproduction or audit.

## Execution Handoff

After destination and write policy are clear:

1. Use `feishu-doc-library-writing` to shape the durable title, body, evidence, boundaries, and update policy.
2. Use `feishu-doc-ops` to execute the real Feishu read/write operation.
3. Report real evidence from Feishu: returned URL, node token, object token, metadata, or the exact blocker.

Do not claim success without real Feishu evidence.

## Relationship To Other Skills

This skill replaces the old standalone routing role.

Use this skill as the entrypoint for personal knowledge writes. Use lower-level Feishu skills only after this protocol has decided that a write is allowed and where it belongs.

## Hard Rules

- Do not write unless the user explicitly asks to store, organize, archive, remember, or create durable documentation.
- Always use `个人知识系统` as the default knowledge space.
- Always read `AI 使用说明`, `写入与整理规则`, and the candidate directory's `00-目录说明` before writing.
- Prefer existing pages and directories over unnecessary new documents.
- Do not create top-level directories without explicit confirmation.
- Every success claim must include real Feishu evidence.

## Summary

Use `personal-knowledge-write` as the stable operation protocol for the user's Feishu personal knowledge system: confirm the write is explicitly requested, read the system rules, route through the new directory model, produce durable content, execute through Feishu, and report real evidence.
