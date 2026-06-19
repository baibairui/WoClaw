import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { installGatewayBrowserSkill } from './gateway-browser-skill.js';
import { installGatewayDesktopSkill } from './gateway-desktop-skill.js';
import { installLarkCliSkill } from './lark-cli-skill.js';
import { installReminderToolSkill } from './reminder-tool-skill.js';
import { installSocialIntelSkills } from './social-intel-skill.js';

export interface AgentWorkspaceRecord {
  agentId: string;
  workspaceDir: string;
}

export type WorkspaceTemplate = 'default' | 'skill-onboarding';

interface CreateAgentWorkspaceInput {
  userId: string;
  agentName: string;
  existingAgentIds: string[];
  template?: WorkspaceTemplate;
}

interface WorkspaceManifest {
  schemaVersion: number;
  kind: 'agent';
  agentId: string;
  agentName: string;
  template: WorkspaceTemplate;
}

const SKILL_ONBOARDING_AGENT_ID = 'skill-onboarding';

export class AgentWorkspaceManager {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  createWorkspace(input: CreateAgentWorkspaceInput): AgentWorkspaceRecord {
    const agentId = resolveAgentId(input);
    const userDir = this.resolveUserDir(input.userId);
    this.ensureUserLayout(userDir);
    const workspaceDir = path.join(this.resolveUserAgentsDir(userDir), agentId);
    const template = input.template ?? 'default';

    this.ensureWorkspaceScaffold({
      workspaceDir,
      agentName: input.agentName,
      agentId,
      template,
    });

    return { agentId, workspaceDir };
  }

  ensureDefaultWorkspace(userId: string): AgentWorkspaceRecord {
    const agentId = 'default';
    const agentName = '默认Agent';
    const userDir = this.resolveUserDir(userId);
    this.ensureUserLayout(userDir);
    const workspaceDir = path.join(this.resolveUserAgentsDir(userDir), agentId);

    this.ensureWorkspaceScaffold({
      workspaceDir,
      agentName,
      agentId,
      template: 'default',
    });

    return { agentId, workspaceDir };
  }

  repairWorkspaceScaffold(workspaceDir: string): void {
    fs.mkdirSync(workspaceDir, { recursive: true });
    installManagedSkills(workspaceDir);
    this.stripLegacyAgentsReferences(workspaceDir);

    if (workspaceDir === this.rootDir) {
      this.ensureRootWorkspaceScaffold(workspaceDir);
      return;
    }

    const currentDir = this.migrateLegacyWorkspaceDir(workspaceDir);
    const meta = readWorkspaceMeta(currentDir);
    this.ensureWorkspaceScaffold({
      workspaceDir: currentDir,
      agentName: meta.agentName,
      agentId: meta.agentId,
      template: meta.template,
    });
  }

  private resolveUserDir(userId: string): string {
    const digest = shortHash(userId);
    const slug = toSlug(userId, 'user');
    return path.join(this.rootDir, 'users', `${slug}-${digest}`);
  }

  private resolveUserAgentsDir(userDir: string): string {
    return path.join(userDir, 'agents');
  }

  private ensureUserLayout(userDir: string): void {
    fs.mkdirSync(this.resolveUserAgentsDir(userDir), { recursive: true });
  }

  private ensureWorkspaceScaffold(input: {
    workspaceDir: string;
    agentName: string;
    agentId: string;
    template: WorkspaceTemplate;
  }): void {
    const { workspaceDir, agentName, agentId, template } = input;
    fs.mkdirSync(workspaceDir, { recursive: true });

    this.writeManagedFile(
      path.join(workspaceDir, 'AGENTS.md'),
      renderWorkspaceAgentsMd(agentName, agentId, template),
    );
    this.writeManagedFile(
      path.join(workspaceDir, 'README.md'),
      renderWorkspaceReadme(agentName, agentId, template),
    );
    this.writeWorkspaceManifest(workspaceDir, {
      schemaVersion: 1,
      kind: 'agent',
      agentId,
      agentName,
      template,
    });
    this.removeLegacyWorkspaceFiles(workspaceDir);
    installManagedSkills(workspaceDir);
    this.stripLegacyAgentsReferences(workspaceDir);
  }

  private ensureRootWorkspaceScaffold(workspaceDir: string): void {
    this.writeIfMissing(
      path.join(workspaceDir, 'README.md'),
      renderRootWorkspaceReadme(),
    );
    this.writeWorkspaceManifest(workspaceDir, {
      schemaVersion: 1,
      kind: 'agent',
      agentId: 'default',
      agentName: '默认Agent',
      template: 'default',
    });
  }

  private resolveUserDirFromWorkspace(workspaceDir: string): string {
    const normalized = path.resolve(workspaceDir);
    const parent = path.dirname(normalized);
    const parentBase = path.basename(parent);
    if (parentBase === 'agents' || parentBase === 'internal') {
      return path.dirname(parent);
    }
    return parent;
  }

  private migrateLegacyWorkspaceDir(workspaceDir: string): string {
    const normalized = path.resolve(workspaceDir);
    const userDir = this.resolveUserDirFromWorkspace(normalized);
    const parentBase = path.basename(path.dirname(normalized));
    if (parentBase === 'agents' || parentBase === 'internal') {
      return normalized;
    }

    const workspaceName = path.basename(normalized);
    const targetDir = path.join(this.resolveUserAgentsDir(userDir), workspaceName);
    return moveDirectoryIfNeeded(normalized, targetDir);
  }

  private writeIfMissing(filePath: string, content: string): void {
    if (fs.existsSync(filePath)) {
      return;
    }
    this.writeManagedFile(filePath, content);
  }

  private writeManagedFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  private writeWorkspaceManifest(workspaceDir: string, manifest: WorkspaceManifest): void {
    const manifestPath = path.join(workspaceDir, '.codex', 'workspace.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  private removeLegacyWorkspaceFiles(workspaceDir: string): void {
    const legacyFiles = [
      path.join(workspaceDir, 'agent.md'),
      path.join(workspaceDir, 'SOUL.md'),
      path.join(workspaceDir, 'TOOLS.md'),
      path.join(workspaceDir, 'browser-playbook.md'),
      path.join(workspaceDir, 'feishu-ops-playbook.md'),
      path.join(workspaceDir, 'memory-init-checklist.md'),
      path.join(workspaceDir, 'skill-install-checklist.md'),
      path.join(workspaceDir, 'memory'),
    ];
    for (const filePath of legacyFiles) {
      fs.rmSync(filePath, { force: true, recursive: true });
    }
  }

  private stripLegacyAgentsReferences(workspaceDir: string): void {
    const agentsPath = path.join(workspaceDir, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) {
      return;
    }
    const content = fs.readFileSync(agentsPath, 'utf8');
    const next = content
      .replace(/^.*browser-playbook.*\n?/gim, '')
      .replace(/^.*feishu-ops-playbook.*\n?/gim, '')
      .replace(/^.*`\.\/TOOLS\.md`.*\n?/gim, '')
      .replace(/^.*`\.\/SOUL\.md`.*\n?/gim, '')
      .replace(/^.*`\.\/memory\/.*\n?/gim, '')
      .replace(/^.*\buser\.md\b.*\n?/gim, '')
      .replace(/^.*shared-memory.*\n?/gim, '');
    if (next !== content) {
      fs.writeFileSync(agentsPath, next.trimEnd() + '\n', 'utf8');
    }
  }
}

function renderWorkspaceAgentsMd(
  agentName: string,
  agentId: string,
  template: WorkspaceTemplate,
): string {
  const onboardingRules = template === 'skill-onboarding'
    ? [
        '技能扩展职责：',
        '- 你不是通用助手；你的主要职责是帮助用户给其他 agent 安装和配置 skills。',
        '- 必须先确认目标 agent（名称/ID）和目标能力，再执行安装。',
        '',
      ]
    : [];

  return [
    '# AGENTS.md',
    '',
    `当前工作区属于 agent \`${agentName}\`（ID: \`${agentId}\`）。`,
    '',
    ...onboardingRules,
    '工具路由：',
    '- 浏览器任务：`./.codex/skills/gateway-browser/SKILL.md`',
    '- 桌面任务：`./.codex/skills/macos-gui-skill/SKILL.md`',
    '- 定时提醒：`./.codex/skills/reminder-tool/SKILL.md`',
    '- 飞书官方操作：`./.codex/skills/lark-cli/SKILL.md`',
    '- 社媒调研：`./.codex/skills/social-intel/SKILL.md`',
    '',
    '工作规则：',
    '- 不要编造执行结果；没有真实证据前不要声称完成。',
    '- 能力专属的长操作规范留在对应 skill 中，不在当前工作区复制 playbook。',
    '',
  ].join('\n');
}

function renderWorkspaceReadme(
  agentName: string,
  agentId: string,
  template: WorkspaceTemplate,
): string {
  const extraTips = template === 'skill-onboarding'
    ? [
        '- 该 agent 用于给其它 agent 安装和配置 skills。',
      ]
    : [
        '- agent 的行为规则维护在 `AGENTS.md`。',
      ];
  return [
    `# ${agentName}`,
    '',
    `这个目录是 agent \`${agentId}\` 的独立工作空间。`,
    '',
    ...extraTips,
    '',
  ].join('\n');
}

function renderRootWorkspaceReadme(): string {
  return [
    '# 默认Agent',
    '',
    '这个目录是实例级共享默认 agent 的工作空间。',
    '用于部署、实例编排、运行排障、配置审计与修复。',
    '',
  ].join('\n');
}

function readWorkspaceMeta(workspaceDir: string): {
  agentName: string;
  agentId: string;
  template: WorkspaceTemplate;
} {
  const manifestPath = path.join(workspaceDir, '.codex', 'workspace.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<WorkspaceManifest>;
      const agentId = parsed.agentId ?? path.basename(workspaceDir);
      return {
        agentName: parsed.agentName ?? agentId,
        agentId,
        template: parsed.template ?? resolveTemplateFromAgentId(agentId),
      };
    } catch {
      // fall through to file-based detection
    }
  }

  const legacyAgent = parseLegacyAgentMd(readIfExists(path.join(workspaceDir, 'agent.md')));
  const fallbackAgentId = path.basename(workspaceDir);
  return {
    agentName: legacyAgent.agentName ?? fallbackAgentId,
    agentId: legacyAgent.agentId ?? fallbackAgentId,
    template: resolveTemplateFromAgentId(legacyAgent.agentId ?? fallbackAgentId),
  };
}

function resolveTemplateFromAgentId(agentId: string): WorkspaceTemplate {
  if (agentId === SKILL_ONBOARDING_AGENT_ID) {
    return 'skill-onboarding';
  }
  return 'default';
}

function parseLegacyAgentMd(content?: string): { agentName?: string; agentId?: string } {
  return {
    agentName: matchField(content, 'Agent Name'),
    agentId: matchField(content, 'Agent ID'),
  };
}

function readIfExists(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function matchField(content: string | undefined, label: string): string | undefined {
  if (!content) {
    return undefined;
  }
  const pattern = new RegExp(`^-\\s+${escapeRegExp(label)}:[ \\t]*([^\\n]*)$`, 'im');
  const value = content.match(pattern)?.[1]?.trim();
  if (!value || value === '-') {
    return undefined;
  }
  return value;
}

function resolveAgentId(input: CreateAgentWorkspaceInput): string {
  if (input.template === 'skill-onboarding') {
    return SKILL_ONBOARDING_AGENT_ID;
  }
  return createUniqueAgentId(input.agentName, input.existingAgentIds);
}

function createUniqueAgentId(name: string, existingAgentIds: string[]): string {
  const base = toSlug(name, 'agent');
  const existing = new Set(existingAgentIds);
  if (!existing.has(base)) {
    return base;
  }
  let counter = 2;
  while (existing.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

function toSlug(input: string, fallback: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

function installManagedSkills(workspaceDir: string): void {
  installGatewayBrowserSkill(workspaceDir);
  installGatewayDesktopSkill(workspaceDir);
  installReminderToolSkill(workspaceDir);
  installLarkCliSkill(workspaceDir);
  installSocialIntelSkills(workspaceDir);
}

function moveDirectoryIfNeeded(sourceDir: string, targetDir: string): string {
  const normalizedSource = path.resolve(sourceDir);
  const normalizedTarget = path.resolve(targetDir);
  if (normalizedSource === normalizedTarget) {
    return normalizedTarget;
  }
  if (fs.existsSync(normalizedTarget)) {
    return normalizedTarget;
  }
  fs.mkdirSync(path.dirname(normalizedTarget), { recursive: true });
  fs.renameSync(normalizedSource, normalizedTarget);
  return normalizedTarget;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
