---
name: feishu-doc-library-writing
description: Use when creating, updating, or polishing durable content for a Feishu knowledge base, personal doc library, wiki, or document archive.
---

# Feishu Doc Library Writing

## Goal

Turn working notes, chat context, research, or project outputs into durable Feishu knowledge-base content.

This skill is about the document body and update policy. Personal knowledge-system protocol and API execution belong to separate skills.

## When to Use

Use this skill when the user asks to:
- write something into the doc library, knowledge base, wiki, or Feishu docs
- turn a conversation, investigation, report, or research result into reusable documentation
- update an existing knowledge-base article instead of only replying in chat
- polish draft content so it can live as long-term reference

Do not use this skill for:
- temporary chat replies
- one-off operational commands
- gateway deployment scripts or server runbooks unless the target is explicitly a project document
- raw dumps of logs, secrets, tokens, or private runtime state

## Required Sequence

Before writing a Feishu knowledge-base document:

1. Use `personal-knowledge-write` to confirm the write is explicitly requested, read the required knowledge-system rules, and choose the destination.
2. Read the relevant existing node when possible.
3. Decide whether the right action is `create`, `update`, `append`, or `leave unchanged`.
4. Draft content that can stand on its own without the original chat.
5. Use operational execution only after the body and destination are clear.
6. Report the final Feishu URL, node token, or blocker from the real operation.

Never create a new isolated document just because writing a new page is easier.

## Durable Content Standard

A doc-library entry should usually include:
- a precise title that explains the topic, not just the task
- a short context paragraph explaining why the document exists
- the stable conclusion, decision, or reusable pattern
- evidence, source links, or observed facts when the claim depends on them
- boundaries: what this document covers and what it does not cover
- open questions or next actions only when they are useful later

Prefer concise sections over transcript-style narration.

If the content came from investigation, distinguish:
- `Observed`: command output, Feishu metadata, file paths, timestamps, or direct source facts
- `Inferred`: conclusions drawn from the observed facts
- `Decision`: the chosen rule, routing, or next behavior

## Update vs Create

Prefer updating an existing document when:
- the topic already has a stable home
- the new content corrects, expands, or supersedes prior content
- a reader would expect to find the answer in the existing page

Create a new document only when:
- the topic is durable enough to deserve its own page
- the title and boundaries are clear
- the chosen directory can hold similar future content

If unsure, create a short proposed title and explain whether it is better as a new page or an update.

## Writing Style

Use a library style:
- write for future retrieval, not only for the current chat
- keep operational details only when they help reproduce or audit the result
- convert long command traces into short evidence summaries
- preserve exact paths, IDs, and dates when they matter
- label assumptions instead of hiding them
- avoid saying something is done unless the Feishu operation returned real evidence

Avoid:
- dumping the whole conversation
- mixing deployment instructions with knowledge-base routing rules
- storing secrets, tokens, private credentials, or temporary debug artifacts
- creating broad catch-all pages with unclear future use

## Coordination With Related Skills

Use the skills in this order when all apply:

1. `personal-knowledge-write`
   Confirm the user explicitly asked for a knowledge-system write, read the required system and directory rules, and choose the destination/update policy.

2. `feishu-doc-library-writing`
   Shape the content, title, update policy, evidence, and long-term structure.

3. `feishu-doc-ops`
   Execute the real Feishu read/write operation with user identity and evidence.

## Hard Rules

- Do not write into Feishu before destination and update policy are clear.
- Do not create isolated docs when the user's doc library already has an appropriate home.
- Do not claim a document was created or updated without real Feishu evidence.
- Do not store secrets or raw runtime state in durable docs.
- Keep personal knowledge protocol, writing, and API execution as separate decisions.

## Summary

Write Feishu knowledge-base content as durable, searchable documentation: choose the right update policy, preserve evidence, avoid raw dumps, and only hand off to Feishu operations when the destination and body are ready.
