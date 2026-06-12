---
name: skill-scope-decision
description: Decide whether a skill or rule belongs in the shared global registry or should remain private and excluded from Git-backed sync.
---

# Skill Scope Decision

## Goal

Decide whether a skill, rule, or workflow belongs in the shared global registry.

This skill exists to prevent private behavior from leaking into shared infrastructure.

## Shared Global Scope

A skill belongs in the shared global registry only when all of the following are true:

1. It is reusable across multiple gateways, or is intended to be reusable.
2. It does not depend on one gateway's private context.
3. It does not depend on one agent's private role or working memory.
4. It is not a temporary experiment tied to a single task.
5. It is stable enough to be reviewed, versioned, and published.

Examples of shared global scope:
- Git-backed skill sync workflow
- Feishu document operation rules that should be reused broadly
- Knowledge-base routing rules intended for general reuse
- Generic report-writing standards

## Non-Shared Scope

A skill does not belong in the shared global registry if any of the following are true:

1. It exists only for one gateway's operational quirks.
2. It exists only for one agent's personality, role, or output contract.
3. It depends on local memory, local datasets, local secrets, or temporary context.
4. It is still exploratory and not ready to be shared.

Examples that should remain private:
- A single agent's local drafting shortcuts
- A gateway-specific operational workaround
- Temporary debugging helpers
- One-off research or experiment scaffolding

## Decision Rule

Default stance:
- Prefer shared global scope only when reuse is intentional and justified.
- If the scope is ambiguous, do not automatically promote it into the shared registry.

In ambiguous cases, ask:
- Would another gateway benefit from this without inheriting private assumptions?
- Would another agent use this without surprising behavior?
- Would it still make sense six weeks from now?

If the answer is unclear, keep it out of the shared registry for now.

## Required Output

This skill should produce one of these conclusions:

1. `shared-global`
   The skill belongs under `/opt/skill-registry/global-skills/`

2. `private-local`
   The skill should remain outside the shared registry and outside Git-backed sync

3. `not-ready`
   The idea may become shared later, but should not enter the registry yet

## Hard Rules

- Do not place gateway-private or agent-private skills in `/opt/skill-registry/global-skills/`.
- Do not use the shared registry as a dumping ground for unfinished experiments.
- Do not confuse "currently convenient" with "globally reusable".
- Review shared scope before pushing to the registry.

## Summary

Only skills that are genuinely reusable, stable, and free of private assumptions should enter the shared global registry.

Everything else stays private and outside Git-backed shared sync.
