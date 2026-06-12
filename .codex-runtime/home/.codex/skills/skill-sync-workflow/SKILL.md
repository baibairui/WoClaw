---
name: skill-sync-workflow
description: Manage shared global skills via Git and publish them to multiple gateway runtime skill directories; exclude gateway-private and agent-private local skills.
---

# Skill Sync Workflow

## Goal

Manage shared global skills as versioned assets and publish them to multiple gateways.

This skill is only for:
- shared global skills
- Git-backed source control for shared skills
- publish timing and sync timing
- multi-gateway deployment of shared skills

This skill is not for:
- gateway-private skills
- agent-private local skills
- workspace-local `./.codex/skills`
- session, memory, runtime cache, or temporary debug assets

## Current Topology

The current environment has three relevant gateway targets:

- `opt-gateway`
  The gateway rooted at `/opt/gateway`

- `gateway-a`
  The gateway rooted at `/opt/codexGetaways/gateway-a`

- `gateway-a-codex-gateway`
  The test gateway codebase rooted at `/opt/codexGetaways/gateway-a/CodexWorkspace/users/ou-262539d37c35ced724f44a5e40896da4-224880b7/agents/coder/codex-gateway`

Important relationship:
- `gateway-a` is the broader working environment
- `gateway-a-codex-gateway` is the user's test version of gateway code
- the user may ask `gateway-a` to modify the gateway code that lives in `gateway-a-codex-gateway`
- work may be initiated from `gateway-a`, but the code change itself may belong to `gateway-a-codex-gateway`

This means the two are related, but they are not the same publish target.
The test version must be treated as its own logical target in the sync flow.

## Directory Relationship

The relationship is:

- `/opt/gateway`
  standalone production-like gateway root

- `/opt/codexGetaways/gateway-a`
  standalone gateway root used as a broader working environment

- `/opt/codexGetaways/gateway-a/CodexWorkspace/.../agents/coder/codex-gateway`
  a separate gateway repository nested inside `gateway-a`'s workspace

Operationally:
- `gateway-a` and `gateway-a-codex-gateway` may exist on the same machine
- `gateway-a-codex-gateway` is not a submodule of the shared-skill registry
- `gateway-a-codex-gateway` should be treated as a separate gateway target even though it is stored inside the `gateway-a` workspace tree
- editing code from the outer `gateway-a` environment does not change the fact that the nested `codex-gateway` remains its own gateway target

## Source of Truth

Shared global skills live in the Git-backed registry:

- `/opt/skill-registry/global-skills/`

This directory is the source of truth for shared global skills.

## Supported Inputs

Shared skills may originate from:

1. Skills authored directly in the registry.
2. Skills installed into `$CODEX_HOME/skills` that are later reviewed and promoted into the registry.

Promotion rule:
- Do not copy every installed skill into the registry by default.
- Only promote skills that are confirmed to be reusable shared global skills.

## Non-Goals

Do not put the following into the registry:
- gateway-private skills
- agent-private skills
- any workspace-local `./.codex/skills`
- anything carrying session or environment-specific state

## Runtime Targets

For each gateway, publish shared skills to:

Primary target:
- `<gateway-root>/.codex-runtime/home/.codex/skills`

Compatibility mirror:
- `<gateway-root>/.codex-runtime/home/.agents/skills`

Rules:
- Treat `.codex/skills` as the primary runtime global directory.
- Treat `.agents/skills` as a compatibility mirror.
- Keep the two runtime global directories equivalent.
- Do not rely on precedence between them.

For `gateway-a-codex-gateway`, the real target path must be mapped explicitly from the local environment.
Do not assume it shares the same runtime publish root as `gateway-a`.

## Managed Gateways

Current shared publish targets:
- `opt-gateway`
- `gateway-a`
- `gateway-a-codex-gateway`

Each name is logical. Real local paths must come from sync configuration.

Operational interpretation:
- `gateway-a` may act as the working environment used to edit and prepare changes
- `gateway-a-codex-gateway` should be treated as the user's test gateway version
- syncing to one does not imply syncing to the other
- publish decisions must state exactly which gateway target is being updated
- if the user says "let gateway-a modify gateway", interpret this as:
  - the operator environment may be `gateway-a`
  - the code or runtime target may still be `gateway-a-codex-gateway`
  - the target must be stated explicitly before publish

## Path Mapping

Do not assume repository names and local filesystem paths are identical.

The sync workflow must map logical gateway names to real local paths, for example:
- `opt-gateway` -> `/opt/gateway`
- `gateway-a` -> `/opt/codexGetaways/gateway-a`
- `gateway-a-codex-gateway` -> `/opt/codexGetaways/gateway-a/CodexWorkspace/users/ou-262539d37c35ced724f44a5e40896da4-224880b7/agents/coder/codex-gateway`

All publish operations must use configured mappings, never guessed paths.

Because `gateway-a-codex-gateway` is nested inside the broader `gateway-a` workspace, special care is required:
- do not confuse the parent workspace path with the test gateway runtime path
- do not publish to the test gateway just because changes were authored from `gateway-a`
- keep target selection explicit

## Target Selection Rule

Before any publish or sync action, determine two separate things:

1. the operator environment
2. the actual gateway target

Examples:
- operator environment = `gateway-a`, target = `gateway-a-codex-gateway`
- operator environment = `gateway-a`, target = `gateway-a`
- operator environment = any shell session, target = `opt-gateway`

Never infer the target only from the shell location.
Never infer the target only from the repository currently open.

## Default Policy

- Shared skills go into `/opt/skill-registry/global-skills/`.
- Shared skills publish to gateway runtime global directories only.
- Agent-private skills never enter the shared sync chain.
- Push and publish are separate steps.
- Publish must dry-run before real execution.
- `gateway-a` and `gateway-a-codex-gateway` must be treated as separate publish targets.

## Push Timing

Push means updating the Git source of truth.

Default sequence:
1. Edit or add a shared global skill.
2. Review the skill contents and confirm it belongs in the shared registry.
3. Commit locally.
4. Push to the Git remote.

Rules:
- Do not push half-finished drafts.
- Review before push.
- Pushing does not mean gateways have been updated.

## Publish Timing

Publish means syncing the Git-backed shared skills to one or more gateway runtime targets.

Default sequence:
1. Select a Git revision to publish.
2. Choose gateway targets.
3. Run dry-run first.
4. Confirm the target set.
5. Execute the real sync.
6. Record the published revision and results.

Rules:
- Do not auto-publish on every commit by default.
- Push and publish must remain separate steps.
- Default to targeted publish, not full publish to all gateways.
- Only publish to all gateways when explicitly requested.

## Recommended End-to-End Flow

1. Create or update a shared skill.
2. Review and confirm it is a shared global skill.
3. Commit.
4. Push.
5. Decide whether to publish to `opt-gateway`, `gateway-a`, `gateway-a-codex-gateway`, or a subset.
6. Run publish dry-run.
7. Confirm selected gateway targets explicitly.
8. Publish for real.
9. Record revision and per-gateway results.

Current practical pattern:
- use `gateway-a` as the place where work may be prepared or edited
- use `gateway-a-codex-gateway` as the test target when validating gateway-specific behavior
- only after explicit choice should other gateway targets receive the same shared-skill update

## Result States

`success`
- The selected shared skills were synced to the gateway runtime global directories.

`skipped`
- The gateway is disabled, unmapped, unchanged, or not part of the current publish scope.

`failed`
- The gateway sync failed and the real error must be reported.

## Required Sync Script Behavior

The sync script should support:
- `--all`
- `--target <gateway-name>`
- `--dry-run`
- optional revision selection

The sync script must:
1. Read gateway path mappings.
2. Read the registry contents from `/opt/skill-registry/global-skills/`.
3. Determine the revision being published.
4. Show the planned changes during dry-run.
5. Resolve the chosen logical targets into real local paths.
6. Publish to each chosen gateway's `.codex/skills`.
7. Mirror the same content to each chosen gateway's `.agents/skills`.
8. Output `success`, `skipped`, or `failed` per gateway.
9. Record revision, time, targets, and results.

## Hard Rules

- Do not put agent-local skills into the shared registry.
- Do not use runtime directories as the only source of truth.
- Do not maintain `.agents/skills` manually as a separate ruleset.
- Do not treat push as equivalent to publish.
- Do not skip dry-run for broad releases unless explicitly approved.

## Summary

Shared global skills live in `/opt/skill-registry/global-skills/`.

Reusable skills from `$CODEX_HOME/skills` may be promoted into the registry after review.

Publishing pushes the same reviewed shared skills into each gateway's runtime global directories:
- `.codex/skills` as primary
- `.agents/skills` as compatibility mirror

Agent-private local skills are excluded from this workflow.
