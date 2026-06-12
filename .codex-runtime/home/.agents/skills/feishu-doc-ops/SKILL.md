---
name: feishu-doc-ops
description: Use when executing real Feishu knowledge-base, wiki, or doc-library read/write operations after destination and content are already decided.
---

# Feishu Doc Ops

## Goal

Handle Feishu knowledge-base reads and writes with the correct identity and real execution evidence.

This skill is about operational execution, not personal knowledge-system routing or writing judgment.

## Identity Rule

Default rule:
- Use `user` identity for Feishu knowledge-base reads and writes.

If application identity can read but cannot write to the intended parent directory:
- switch to user identity and continue with real execution

Do not claim completion without real command output.

## Read Workflow

Use the official `lark-cli` flow.

Typical sequence:

1. Check auth status.
2. Confirm identity and scopes.
3. Read wiki spaces or nodes directly when global search permissions are missing.
4. Gather real evidence before making a routing or write claim.

Representative commands:

```bash
lark-cli auth status
lark-cli wiki spaces list --as user
lark-cli wiki spaces get_node --as user --params '{"token":"<node_token>"}'
lark-cli wiki nodes list --as user --params '{"space_id":"<space_id>","parent_node_token":"<node_token>"}'
```

## Write Workflow

Write only after `personal-knowledge-write` and `feishu-doc-library-writing` have already decided that a write is allowed, where it belongs, and what durable content should be written.

Typical sequence:

1. Confirm destination node or parent directory.
2. Confirm user identity is active.
3. Execute the real create/update action.
4. Capture returned identifiers, URLs, or metadata.
5. Report the real result.

## CLI Practical Notes

Observed with `lark-cli docs +create`:

- `--markdown @file` must use a file path relative to the current working directory. If the source file is in `/tmp/...`, `cd` into that directory first and pass `@file.md`.
- `--folder-token`, `--wiki-node`, and `--wiki-space` are mutually exclusive. To create a document under an existing wiki parent node, pass only `--wiki-node <parent_node_token>` and let the CLI infer the space.
- For appending to an existing document such as a TODO page, use `lark-cli docs +update --mode append --doc <obj_token> --markdown @file.md`.

## Permission Fallback Rule

If document search scope is missing:
- do not stop immediately
- fall back to direct wiki reads when tokens or known nodes are available

If write permissions are missing:
- do not fabricate success
- stop and report the exact blocker

## Evidence Rule

Every success claim must be backed by at least one of:
- returned node token
- returned object token
- returned URL
- returned metadata from `lark-cli`

If no real evidence exists, do not say the task is done.

## Scope of Use

Use this skill for:
- reading the knowledge-base structure
- reading target nodes
- confirming write permissions through real execution
- writing or updating Feishu knowledge-base content

Do not use this skill to decide:
- whether the user explicitly asked for a knowledge-system write
- which directory is best
- whether a new directory should exist
- how a report should be structured

Those belong to `personal-knowledge-write` and writing skills.

## Related Skills

Use this skill after personal knowledge-system protocol and writing decisions are clear.

Sequence:

1. `personal-knowledge-write`
   Confirm the explicit write request, read the required system and directory rules, and decide the destination/update policy.

2. `feishu-doc-library-writing`
   Prepare the durable title, body, evidence, and update policy.

3. `feishu-doc-ops`
   Execute the read/write command and capture returned Feishu evidence.

## Hard Rules

- Default to user identity for Feishu knowledge-base operations.
- Never fabricate Feishu results.
- Prefer the existing knowledge base over creating isolated documents when the task is to write into the user's doc library.
- Separate personal knowledge-system judgment from operational execution.

## Summary

Use `lark-cli`, use user identity by default, collect real evidence, and only claim completion when Feishu has actually returned success metadata.
