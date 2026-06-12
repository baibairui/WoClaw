import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertManagedSection } from './agents-managed-sections.js';

export const LARK_CLI_SKILL_NAME = 'lark-cli';
const FEISHU_RULE_START = '<!-- gateway:feishu-ops:start -->';
const FEISHU_RULE_END = '<!-- gateway:feishu-ops:end -->';

const SOURCE_SKILL_DIR = fileURLToPath(
  new URL(`../../.codex/skills/${LARK_CLI_SKILL_NAME}`, import.meta.url),
);

export function installLarkCliSkill(workspaceDir: string): void {
  installToSkillRoot(path.join(workspaceDir, '.codex', 'skills'));
  ensureAgentsLarkRule(workspaceDir);
}

function installToSkillRoot(skillRootDir: string): void {
  const targetSkillDir = path.join(skillRootDir, LARK_CLI_SKILL_NAME);
  if (path.resolve(targetSkillDir) === path.resolve(SOURCE_SKILL_DIR)) {
    return;
  }
  fs.mkdirSync(skillRootDir, { recursive: true });
  fs.rmSync(path.join(skillRootDir, 'feishu-official-ops'), { recursive: true, force: true });
  fs.rmSync(path.join(skillRootDir, 'feishu-canvas'), { recursive: true, force: true });
  fs.rmSync(targetSkillDir, { recursive: true, force: true });
  fs.cpSync(SOURCE_SKILL_DIR, targetSkillDir, { recursive: true, force: true });
}

function ensureAgentsLarkRule(workspaceDir: string): void {
  const agentsPath = path.join(workspaceDir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return;
  }
  const content = fs.readFileSync(agentsPath, 'utf8');
  const section = [
    FEISHU_RULE_START,
    '飞书官方操作规则：',
    '- 用户要求创建或编辑飞书文档、知识库、日程、待办、云空间对象时，统一使用 `./.codex/skills/lark-cli/SKILL.md`。',
    '- 优先使用 `lark-cli` 的 shortcut 命令，不要继续调用仓库里的旧飞书脚本。',
    '- 首次使用前先确认宿主机已安装 `@larksuite/cli`，并完成 `npx skills add larksuite/cli -y -g`。',
    '- 文档写入优先使用 `lark-cli docs +create` / `lark-cli docs +update`；知识库节点操作优先使用 `lark-cli wiki`；不要再使用 `feishu-canvas`。',
    '- 日程优先使用 `lark-cli calendar +agenda`、`+freebusy`、`+suggestion`、`+create`；待办优先使用 `lark-cli task +create`、`+update`、`+get-my-tasks`。',
    '- 若参数结构不确定，先执行 `lark-cli schema ...` 或阅读官方 lark skill 文档，不要猜字段。',
    '- 必须执行真实 `lark-cli` 命令拿到返回结果后再声称完成。',
    FEISHU_RULE_END,
  ].join('\n');
  const next = upsertManagedSection(content, FEISHU_RULE_START, FEISHU_RULE_END, section, [
    /(?:\n|^)飞书官方操作规则：[\s\S]*?(?=\n[A-Z\u4e00-\u9fff#].*：|\n执行权限规则：|\n提醒规则：|\n$)/m,
  ]);
  if (next !== content) {
    fs.writeFileSync(agentsPath, `${next.trimEnd()}\n`, 'utf8');
  }
}
