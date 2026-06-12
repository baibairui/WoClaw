import fs from 'node:fs';
import path from 'node:path';
import { upsertManagedSection } from './agents-managed-sections.js';
import {
  configureManagedGlobalSkillRoots,
  defaultGlobalSkillRoots,
} from './gateway-browser-skill.js';

import {
  MACOS_GUI_SKILL_MARKDOWN,
  MACOS_GUI_SKILL_OPENAI_YAML,
  MACOS_GUI_SKILL_SCRIPT,
} from './macos-gui-skill-assets.js';

export const MACOS_GUI_SKILL_NAME = 'macos-gui-skill';
export const GATEWAY_DESKTOP_SKILL_NAME = MACOS_GUI_SKILL_NAME;
export { configureManagedGlobalSkillRoots };

const DESKTOP_RULE_START = '<!-- gateway:desktop-rule:start -->';
const DESKTOP_RULE_END = '<!-- gateway:desktop-rule:end -->';

interface GlobalSkillSyncOptions {
  roots?: string[];
}

export function installGatewayDesktopSkill(workspaceDir: string): void {
  installToSkillRoot(path.join(workspaceDir, '.codex', 'skills'));
  ensureAgentsDesktopRule(workspaceDir);
}

export function syncManagedGlobalDesktopSkills(options: GlobalSkillSyncOptions = {}): void {
  const roots = options.roots ?? defaultGlobalSkillRoots();
  for (const root of roots) {
    installToSkillRoot(root);
  }
}

export function renderGatewayDesktopSkill(): string {
  return MACOS_GUI_SKILL_MARKDOWN;
}

function renderGatewayDesktopOpenAiYaml(): string {
  return MACOS_GUI_SKILL_OPENAI_YAML;
}

function renderGatewayDesktopScript(): string {
  return MACOS_GUI_SKILL_SCRIPT;
}

function renderAgentsDesktopRuleSection(): string {
  return [
    DESKTOP_RULE_START,
    '桌面操作职责：',
    `- 当任务需要桌面软件交互时，只允许使用 \`./.codex/skills/${MACOS_GUI_SKILL_NAME}/SKILL.md\` 及其自带脚本完成操作，不要直接执行 shell 命令或自行调用 osascript。`,
    '- 只操作前台可见应用；如果目标应用不在前台，先用 skill 激活或启动它。',
    '- 默认走 `observe -> act -> observe`；先用 `observe` 拿视觉证据，再执行一个 2-5 步的 `act` GUI 动作包，然后再次观察结果。',
    '- 在认定 `act` 不可用、缺依赖或权限不足之前，必须先运行 `doctor` 读取明确诊断结果。',
    '- 不要自行切换到系统级 UI 脚本探测环境；`doctor` 是桌面技能依赖、权限和 fallback 判断的唯一依据。',
    '- `run-shell` 和 `run-applescript` 只作为兜底，不要作为默认首选；只有在 `doctor` 明确表明需要处理 blocker，或用户明确要求时才允许使用。',
    '- 每次关键动作后都要补一张截图作为证据，按“Action Bundle / Evidence / Result / Next step”回报。',
    '- 涉及发送、删除、支付、权限确认等不可逆动作时，若用户未明确授权，先暂停并请求确认。',
    DESKTOP_RULE_END,
  ].join('\n');
}

function installToSkillRoot(skillRootDir: string): void {
  const skillDir = path.join(skillRootDir, MACOS_GUI_SKILL_NAME);
  fs.mkdirSync(path.join(skillDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  writeIfChanged(path.join(skillDir, 'SKILL.md'), renderGatewayDesktopSkill());
  writeIfChanged(path.join(skillDir, 'agents', 'openai.yaml'), renderGatewayDesktopOpenAiYaml());
  writeIfChanged(path.join(skillDir, 'scripts', 'macos-gui-skill.mjs'), renderGatewayDesktopScript());
}

function ensureAgentsDesktopRule(workspaceDir: string): void {
  const agentsPath = path.join(workspaceDir, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return;
  }
  const content = fs.readFileSync(agentsPath, 'utf8');
  const next = upsertManagedSection(
    content,
    DESKTOP_RULE_START,
    DESKTOP_RULE_END,
    renderAgentsDesktopRuleSection(),
    [
      /(?:\n|^)桌面操作职责：[\s\S]*?(?=\n开始任何任务前，先阅读这些记忆文件：|\n<!-- gateway:desktop-rule:start -->|\n$)/m,
    ],
  );
  if (next !== content) {
    fs.writeFileSync(agentsPath, `${next.trimEnd()}\n`, 'utf8');
  }
}

function writeIfChanged(filePath: string, content: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  if (existing === content) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
