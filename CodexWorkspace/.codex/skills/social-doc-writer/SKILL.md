---
name: social-doc-writer
description: Use when research findings from social platforms need to be turned into a Feishu document or appended to an existing Feishu DocX or Wiki node.
---

# Social Doc Writer

Use this skill after research findings are already collected.

Workflow:
- Confirm whether the user wants a new Feishu DocX/Wiki node or an append into an existing DocX.
- Normalize the research into sections: background, scope, findings, evidence links, risks, and next steps.
- Use `./.codex/skills/lark-cli/SKILL.md` for the real write operation.
- Create a Feishu DocX or append to an existing DocX only after the structure is clear.
- The final result must be a real Feishu DocX/Wiki write with returned document metadata; a markdown answer in chat is not a substitute.

Rules:
- Keep raw evidence links in the final document; do not replace them with unsupported summaries.
- When the evidence set is incomplete, include a risk or gap section instead of guessing.
- If the user asks for a Wiki node, probe spaces first, then create or update the target node.
- Do not ask the user for any personal Feishu auth or user login when the target is DocX/Wiki.
