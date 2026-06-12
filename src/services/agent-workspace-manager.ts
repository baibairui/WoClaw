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

export interface SystemMemoryStewardWorkspaceRecord {
  workspaceDir: string;
  userDir: string;
  userIdentityPath: string;
  sharedMemoryDir: string;
}

export interface SharedMemorySnapshot {
  sharedMemoryDir: string;
  userIdentityPath?: string;
  identityContent: string;
  identityVersion: string;
  hasIdentity: boolean;
}

export interface MemorySummaryEntry {
  fileName: string;
  summary: string;
}

export interface MemorySummarySnapshot {
  sharedMemoryDir: string;
  workspaceMemoryDir: string;
  shared: MemorySummaryEntry[];
  agent: MemorySummaryEntry[];
}

interface CreateAgentWorkspaceInput {
  userId: string;
  agentName: string;
  existingAgentIds: string[];
  template?: 'default' | 'memory-onboarding' | 'skill-onboarding';
}

interface WorkspaceManifest {
  schemaVersion: number;
  kind: 'agent' | 'system-memory-steward';
  agentId: string;
  agentName: string;
  template: 'default' | 'memory-onboarding' | 'skill-onboarding';
}

interface ParsedSoulContent {
  agentName?: string;
  agentId?: string;
  role?: string;
  mission?: string;
  workingStyle?: string;
  successCriteria?: string;
  decisionPrinciples: string[];
  boundaries: string[];
}

const MEMORY_ONBOARDING_AGENT_ID = 'memory-onboarding';
const SKILL_ONBOARDING_AGENT_ID = 'skill-onboarding';
const RUNTIME_FILES = ['shared-context.md', 'house-rules.md'] as const;
const USER_IDENTITY_HEADINGS = [
  '## Core Identity',
  '## Stable Preferences',
  '## Ongoing Context',
];

export class AgentWorkspaceManager {
  private readonly rootDir: string;
  private readonly runtimeDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.runtimeDir = path.join(this.rootDir, 'runtime');
    this.ensureRuntimeScaffold();
  }

  createWorkspace(input: CreateAgentWorkspaceInput): AgentWorkspaceRecord {
    this.ensureRuntimeScaffold();

    const agentId = resolveAgentId(input);
    const userDir = this.resolveUserDir(input.userId);
    const userIdentityPath = this.ensureUserLayout(userDir);
    const workspaceDir = path.join(this.resolveUserAgentsDir(userDir), agentId);
    const template = input.template ?? 'default';

    this.ensureWorkspaceScaffold({
      workspaceDir,
      userIdentityPath,
      agentName: input.agentName,
      agentId,
      template,
    });

    return { agentId, workspaceDir };
  }

  ensureDefaultWorkspace(userId: string): AgentWorkspaceRecord {
    this.ensureRuntimeScaffold();

    const agentId = 'default';
    const agentName = '默认Agent';
    const userDir = this.resolveUserDir(userId);
    const userIdentityPath = this.ensureUserLayout(userDir);
    const workspaceDir = path.join(this.resolveUserAgentsDir(userDir), agentId);

    this.ensureWorkspaceScaffold({
      workspaceDir,
      userIdentityPath,
      agentName,
      agentId,
      template: 'default',
    });

    return { agentId, workspaceDir };
  }

  isSharedMemoryEmpty(userId: string): boolean {
    const userDir = this.resolveUserDir(userId);
    const userIdentityPath = this.ensureUserLayout(userDir);
    const content = fs.readFileSync(userIdentityPath, 'utf8');
    return !hasMeaningfulIdentityContent(content);
  }

  isWorkspaceIdentityEmpty(workspaceDir: string): boolean {
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      return true;
    }
    return !hasInitializedSoulContent(fs.readFileSync(soulPath, 'utf8'));
  }

  getSharedMemorySnapshot(userId: string): SharedMemorySnapshot {
    const userDir = this.resolveUserDir(userId);
    const userIdentityPath = this.ensureUserLayout(userDir);
    const identityContent = fs.existsSync(userIdentityPath)
      ? fs.readFileSync(userIdentityPath, 'utf8')
      : renderUserIdentity();
    const normalized = normalizeIdentityText(identityContent);
    return {
      sharedMemoryDir: userDir,
      userIdentityPath,
      identityContent,
      identityVersion: normalized
        ? createHash('sha1').update(normalized).digest('hex').slice(0, 16)
        : 'empty',
      hasIdentity: !!normalized,
    };
  }

  getIdentitySnapshot(userId: string, workspaceDir: string): SharedMemorySnapshot {
    const shared = this.getSharedMemorySnapshot(userId);
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      return shared;
    }

    const soulContent = fs.readFileSync(soulPath, 'utf8');
    const normalizedSoul = normalizeIdentityText(soulContent);
    if (!normalizedSoul) {
      return shared;
    }

    const combinedContent = [
      '# Identity',
      '',
      '## User Identity',
      shared.identityContent.trim(),
      '',
      '## Current Agent Identity',
      soulContent.trim(),
      '',
      '## Injection Rules',
      '- 上述两部分都必须遵守，不可互相替代。',
      '- 用户身份定义长期风格与偏好；当前 agent 身份定义当前角色、职责和边界。',
    ].join('\n');
    const versionSeed = `${normalizeIdentityText(shared.identityContent)}\n---\n${normalizedSoul}`;
    return {
      sharedMemoryDir: shared.sharedMemoryDir,
      userIdentityPath: shared.userIdentityPath,
      identityContent: combinedContent,
      identityVersion: createHash('sha1').update(versionSeed).digest('hex').slice(0, 16),
      hasIdentity: true,
    };
  }

  getMemorySummary(userId: string, workspaceDir: string): MemorySummarySnapshot {
    const userDir = this.resolveUserDir(userId);
    const userIdentityPath = this.ensureUserLayout(userDir);
    const workspaceMemoryDir = path.join(workspaceDir, 'memory');
    const dailyDir = path.join(workspaceMemoryDir, 'daily');

    return {
      sharedMemoryDir: userDir,
      workspaceMemoryDir,
      shared: summarizeEntries([
        { fileName: 'user.md', filePath: userIdentityPath },
      ]),
      agent: summarizeEntries([
        { fileName: 'SOUL.md', filePath: path.join(workspaceDir, 'SOUL.md') },
        ...summarizeDailyFiles(dailyDir),
      ]),
    };
  }

  ensureSystemMemoryStewardWorkspace(userId: string): SystemMemoryStewardWorkspaceRecord {
    this.ensureRuntimeScaffold();

    const userDir = this.resolveUserDir(userId);
    const userIdentityPath = this.ensureUserLayout(userDir);
    const workspaceDir = path.join(this.resolveUserInternalDir(userDir), 'memory-steward');
    fs.mkdirSync(workspaceDir, { recursive: true });

    this.writeIfMissing(
      path.join(workspaceDir, 'AGENTS.md'),
      renderSystemMemoryStewardAgentsMd(
        normalizeRelativePath(path.relative(workspaceDir, userIdentityPath)),
        normalizeRelativePath(path.relative(workspaceDir, this.runtimeDir)),
      ),
    );
    this.writeIfMissing(
      path.join(workspaceDir, 'README.md'),
      renderSystemMemoryStewardReadme(),
    );
    this.writeIfMissing(
      path.join(workspaceDir, 'SOUL.md'),
      renderSystemMemoryStewardSoul(),
    );
    this.writeWorkspaceManifest(workspaceDir, {
      kind: 'system-memory-steward',
      agentId: 'memory-steward',
      agentName: 'Memory Steward',
      template: 'default',
      schemaVersion: 1,
    });
    this.removeLegacyWorkspaceFiles(workspaceDir);

    return {
      workspaceDir,
      userDir,
      userIdentityPath,
      sharedMemoryDir: userDir,
    };
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
    const userDir = this.resolveUserDirFromWorkspace(currentDir);
    const userIdentityPath = this.ensureUserLayout(userDir);
    this.migrateLegacyWorkspaceFiles(currentDir, meta);
    this.ensureWorkspaceScaffold({
      workspaceDir: currentDir,
      userIdentityPath,
      agentName: meta.agentName,
      agentId: meta.agentId,
      template: meta.template,
    });
  }

  repairUserSharedMemoryTree(userDir: string): string {
    const resolvedUserDir = path.resolve(userDir);
    const userIdentityPath = this.ensureUserLayout(resolvedUserDir);
    this.migrateLegacyUserMemory(resolvedUserDir, userIdentityPath);
    this.migrateLegacyStewardWorkspace(resolvedUserDir);
    return resolvedUserDir;
  }

  private ensureRuntimeScaffold(): void {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.writeIfMissing(
      path.join(this.runtimeDir, 'README.md'),
      [
        '# Runtime',
        '',
        '这里存放所有 agent 共享的运行时规则与上下文。',
        '- `shared-context.md`：跨 agent 的业务背景和术语',
        '- `house-rules.md`：所有 agent 共用的行为规则',
        '',
      ].join('\n'),
    );
    this.writeIfMissing(
      path.join(this.runtimeDir, 'shared-context.md'),
      '# Shared Context\n\n- 用户背景：\n- 常用术语：\n- 共用约束：\n',
    );
    this.writeIfMissing(
      path.join(this.runtimeDir, 'house-rules.md'),
      [
        '# House Rules',
        '',
        '- 默认优先保护用户隐私，高敏感信息不要自动写入长期身份文件。',
        '- 只有跨会话稳定、未来还值得再读的信息，才进入长期身份。',
        '- 用户明确要求“记住这个”时，应优先考虑整理进 `user.md` 或对应 agent 的 `SOUL.md`。',
        '- 临时细节、一次性安排和当天上下文记录到 `memory/daily/`。',
        '',
      ].join('\n'),
    );
  }

  private resolveUserDir(userId: string): string {
    const digest = shortHash(userId);
    const slug = toSlug(userId, 'user');
    return path.join(this.rootDir, 'users', `${slug}-${digest}`);
  }

  private resolveUserAgentsDir(userDir: string): string {
    return path.join(userDir, 'agents');
  }

  private resolveUserInternalDir(userDir: string): string {
    return path.join(userDir, 'internal');
  }

  private resolveUserIdentityPath(userDir: string): string {
    return path.join(userDir, 'user.md');
  }

  private ensureUserLayout(userDir: string): string {
    fs.mkdirSync(this.resolveUserAgentsDir(userDir), { recursive: true });
    fs.mkdirSync(this.resolveUserInternalDir(userDir), { recursive: true });

    const userIdentityPath = this.resolveUserIdentityPath(userDir);
    this.writeIfMissing(userIdentityPath, renderUserIdentity());
    return userIdentityPath;
  }

  private ensureWorkspaceScaffold(input: {
    workspaceDir: string;
    userIdentityPath: string;
    agentName: string;
    agentId: string;
    template: 'default' | 'memory-onboarding' | 'skill-onboarding';
  }): void {
    const { workspaceDir, userIdentityPath, agentName, agentId, template } = input;
    fs.mkdirSync(path.join(workspaceDir, 'memory', 'daily'), { recursive: true });

    this.writeManagedFile(
      path.join(workspaceDir, 'AGENTS.md'),
      renderWorkspaceAgentsMd(
        agentName,
        agentId,
        normalizeRelativePath(path.relative(workspaceDir, userIdentityPath)),
        normalizeRelativePath(path.relative(workspaceDir, this.runtimeDir)),
        template,
      ),
    );
    this.writeManagedFile(
      path.join(workspaceDir, 'README.md'),
      renderWorkspaceReadme(agentName, agentId, template),
    );
    this.writeSoulBootstrapIfMissingOrUninitialized(
      path.join(workspaceDir, 'SOUL.md'),
      renderSoulBootstrap(agentName, agentId, template),
    );
    this.writeManagedFile(
      path.join(workspaceDir, 'memory', 'daily', 'README.md'),
      renderDailyMemoryReadme(),
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
    this.writeSoulBootstrapIfMissingOrUninitialized(
      path.join(workspaceDir, 'SOUL.md'),
      renderRootWorkspaceSoul(),
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
    if (workspaceName === '_memory-steward') {
      const targetDir = path.join(this.resolveUserInternalDir(userDir), 'memory-steward');
      return moveDirectoryIfNeeded(normalized, targetDir);
    }

    const targetDir = path.join(this.resolveUserAgentsDir(userDir), workspaceName);
    return moveDirectoryIfNeeded(normalized, targetDir);
  }

  private migrateLegacyUserMemory(userDir: string, userIdentityPath: string): void {
    const sharedMemoryDir = path.join(userDir, 'shared-memory');
    if (!fs.existsSync(sharedMemoryDir) || !fs.statSync(sharedMemoryDir).isDirectory()) {
      return;
    }

    const currentUserIdentity = fs.existsSync(userIdentityPath) ? fs.readFileSync(userIdentityPath, 'utf8') : '';
    if (!hasMeaningfulIdentityContent(currentUserIdentity)) {
      fs.writeFileSync(userIdentityPath, renderUserIdentityFromLegacy(sharedMemoryDir), 'utf8');
    }

    const legacyDir = path.join(userDir, '_legacy', 'shared-memory');
    fs.mkdirSync(path.dirname(legacyDir), { recursive: true });
    if (!fs.existsSync(legacyDir)) {
      fs.renameSync(sharedMemoryDir, legacyDir);
    }
  }

  private migrateLegacyStewardWorkspace(userDir: string): void {
    const legacyDir = path.join(userDir, '_memory-steward');
    if (!fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) {
      return;
    }
    const targetDir = path.join(this.resolveUserInternalDir(userDir), 'memory-steward');
    moveDirectoryIfNeeded(legacyDir, targetDir);
  }

  private migrateLegacyWorkspaceFiles(
    workspaceDir: string,
    meta: { agentName: string; agentId: string; template: 'default' | 'memory-onboarding' | 'skill-onboarding' },
  ): void {
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    const mergedSoul = buildMergedSoul({
      existingSoul: fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : undefined,
      legacyAgentMd: readIfExists(path.join(workspaceDir, 'agent.md')),
      legacyIdentity: readIfExists(path.join(workspaceDir, 'memory', 'identity.md')),
      agentName: meta.agentName,
      agentId: meta.agentId,
      template: meta.template,
    });
    if (!fs.existsSync(soulPath) || !hasInitializedSoulContent(fs.readFileSync(soulPath, 'utf8'))) {
      fs.writeFileSync(soulPath, mergedSoul, 'utf8');
    }
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

  private writeSoulBootstrapIfMissingOrUninitialized(filePath: string, content: string): void {
    if (fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, 'utf8');
      if (hasInitializedSoulContent(current)) {
        return;
      }
    }
    this.writeManagedFile(filePath, content);
  }

  private writeWorkspaceManifest(workspaceDir: string, manifest: WorkspaceManifest): void {
    const manifestPath = path.join(workspaceDir, '.codex', 'workspace.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  private removeLegacyWorkspaceFiles(workspaceDir: string): void {
    const legacyFiles = [
      path.join(workspaceDir, 'agent.md'),
      path.join(workspaceDir, 'TOOLS.md'),
      path.join(workspaceDir, 'browser-playbook.md'),
      path.join(workspaceDir, 'feishu-ops-playbook.md'),
      path.join(workspaceDir, 'memory-init-checklist.md'),
      path.join(workspaceDir, 'skill-install-checklist.md'),
      path.join(workspaceDir, 'memory', 'identity.md'),
      path.join(workspaceDir, 'memory', 'profile.md'),
      path.join(workspaceDir, 'memory', 'preferences.md'),
      path.join(workspaceDir, 'memory', 'projects.md'),
      path.join(workspaceDir, 'memory', 'relationships.md'),
      path.join(workspaceDir, 'memory', 'decisions.md'),
      path.join(workspaceDir, 'memory', 'open-loops.md'),
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
      .replace(/^.*`\.\/memory\/identity\.md`.*\n?/gim, '')
      .replace(/^.*`\.\/shared-memory\/identity\.md`.*\n?/gim, '')
      .replace(/^.*shared-memory\/identity\.md.*\n?/gim, '');
    if (next !== content) {
      fs.writeFileSync(agentsPath, next.trimEnd() + '\n', 'utf8');
    }
  }
}

function renderWorkspaceAgentsMd(
  agentName: string,
  agentId: string,
  relativeUserIdentityPath: string,
  relativeRuntimeDir: string,
  template: 'default' | 'memory-onboarding' | 'skill-onboarding',
): string {
  const onboardingRules = template === 'memory-onboarding'
    ? [
        '初始化职责：',
        '- 你不是通用助手；你的主要职责是帮助用户完成用户身份与当前 agent 身份初始化。',
        '- 每轮最多 3 个问题，等待用户回答后再继续。',
        '- 优先把稳定信息整理进上层 `user.md`，把当前 agent 的角色信息整理进 `SOUL.md`。',
        '',
      ]
    : template === 'skill-onboarding'
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
    '开始任务前，先阅读这些文件：',
    '- `./SOUL.md`',
    `- \`${relativeUserIdentityPath}\``,
    `- \`${relativeRuntimeDir}/house-rules.md\``,
    `- \`${relativeRuntimeDir}/shared-context.md\``,
    '',
    '工具路由：',
    '- 浏览器任务：`./.codex/skills/gateway-browser/SKILL.md`',
    '- 桌面任务：`./.codex/skills/macos-gui-skill/SKILL.md`',
    '- 定时提醒：`./.codex/skills/reminder-tool/SKILL.md`',
    '- 飞书官方操作：`./.codex/skills/lark-cli/SKILL.md`',
    '- 社媒调研：`./.codex/skills/social-intel/SKILL.md`',
    '',
    '工作规则：',
    '- 不要编造执行结果；没有真实证据前不要声称完成。',
    '- 用户长期身份维护在上层 `user.md`。',
    '- 当前 agent 短期上下文维护在 `./memory/daily/`。',
    '- 能力专属的长操作规范留在对应 skill 中，不在当前工作区复制 playbook。',
    '',
  ].join('\n');
}

function renderSystemMemoryStewardAgentsMd(relativeUserIdentityPath: string, relativeRuntimeDir: string): string {
  return [
    '# AGENTS.md',
    '',
    '你是系统默认的 Memory Steward。这个工作区不由最终用户直接操作。',
    '',
    '职责：',
    '- 定期检查用户身份、各 agent 的 `SOUL.md` 和 `memory/daily/`。',
    '- 将跨会话稳定、低噪声的信息整理进 `user.md`。',
    '- 高敏感信息写入 `steward-log.md` 等待确认，不要直接写入长期身份。',
    '',
    '开始任务前，先阅读这些文件：',
    '- `./SOUL.md`',
    `- \`${relativeUserIdentityPath}\``,
    `- \`${relativeRuntimeDir}/shared-context.md\``,
    `- \`${relativeRuntimeDir}/house-rules.md\``,
    '',
    '工作规则：',
    '- 优先维护 `user.md`，必要时参考同级 agent 的 `SOUL.md` 和 `memory/daily/`。',
    '- 产出应是对身份文件的直接修改，而不是面向用户的解释性长文。',
    '',
  ].join('\n');
}

function renderWorkspaceReadme(
  agentName: string,
  agentId: string,
  template: 'default' | 'memory-onboarding' | 'skill-onboarding',
): string {
  const extraTips = template === 'memory-onboarding'
    ? [
        '- 该 agent 用于引导用户补齐用户身份与当前 agent 身份。',
      ]
    : template === 'skill-onboarding'
    ? [
        '- 该 agent 用于给其它 agent 安装和配置 skills。',
      ]
    : [
        '- 用户长期身份在上层 `user.md`。',
        '- 当前 agent 的长期身份在 `SOUL.md`。',
        '- 临时上下文放在 `memory/daily/`。',
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

function renderSystemMemoryStewardReadme(): string {
  return [
    '# Memory Steward Workspace',
    '',
    '这个目录属于系统后台任务，不面向最终用户。',
    '定时任务会在这里运行 Codex，用于整理当前用户的 `user.md` 与 agent 的短期上下文。',
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

function renderUserIdentity(): string {
  return [
    '# User Identity',
    '',
    '## Core Identity',
    '- Preferred name:',
    '- Primary role:',
    '- Language style:',
    '- Communication style:',
    '- Decision principles:',
    '  -',
    '',
    '## Stable Preferences',
    '-',
    '',
    '## Ongoing Context',
    '-',
    '',
  ].join('\n');
}

function renderUserIdentityFromLegacy(sharedMemoryDir: string): string {
  const identityLines = stripHeading(readIfExists(path.join(sharedMemoryDir, 'identity.md')) ?? '').filter(Boolean);
  const sections = [
    { title: 'Stable Preferences', fileName: 'preferences.md' },
    { title: 'Profile', fileName: 'profile.md' },
    { title: 'Projects', fileName: 'projects.md' },
    { title: 'Relationships', fileName: 'relationships.md' },
    { title: 'Decisions', fileName: 'decisions.md' },
    { title: 'Open Loops', fileName: 'open-loops.md' },
  ];

  const output = ['# User Identity', ''];
  output.push('## Core Identity');
  if (identityLines.length > 0) {
    output.push(...identityLines);
  } else {
    output.push('- Preferred name:');
    output.push('- Primary role:');
    output.push('- Language style:');
    output.push('- Communication style:');
    output.push('- Decision principles:');
    output.push('  -');
  }
  output.push('');

  for (const section of sections) {
    const content = readIfExists(path.join(sharedMemoryDir, section.fileName));
    const lines = stripHeading(content ?? '').filter(Boolean);
    if (lines.length === 0) {
      continue;
    }
    output.push(`## ${section.title}`);
    output.push(...lines);
    output.push('');
  }

  if (!output.some((line) => USER_IDENTITY_HEADINGS.includes(line))) {
    output.push('## Stable Preferences');
    output.push('-');
    output.push('');
    output.push('## Ongoing Context');
    output.push('-');
    output.push('');
  }

  return `${output.join('\n').trimEnd()}\n`;
}

function renderSoulBootstrap(
  agentName: string,
  agentId: string,
  template: 'default' | 'memory-onboarding' | 'skill-onboarding',
): string {
  const role = template === 'memory-onboarding'
    ? '记忆初始化引导'
    : template === 'skill-onboarding'
    ? '技能扩展助手'
    : agentName;
  const mission = template === 'memory-onboarding'
    ? '帮助用户初始化用户身份与当前 agent 身份'
    : template === 'skill-onboarding'
    ? '帮助用户为目标 agent 安装和验证 skills'
    : '';
  const workingStyle = template === 'default'
    ? ''
    : '直接、短句、可验证';
  const decisionPrinciples = template === 'default'
    ? ['-']
    : ['- 基于事实，不编造执行结果'];
  const boundaries = template === 'default'
    ? ['-']
    : ['- 不透露内部目录结构和实现细节'];
  const successCriteria = template === 'memory-onboarding'
    ? '用户身份与当前 agent 身份都已补齐'
    : template === 'skill-onboarding'
    ? '目标 skill 安装完成且可验证'
    : '';

  return [
    '# SOUL',
    '',
    `- Agent name: ${agentName}`,
    `- Agent ID: ${agentId}`,
    `- Role: ${role}`,
    `- Mission: ${mission}`,
    `- Working style: ${workingStyle}`,
    '- Decision principles:',
    ...decisionPrinciples.map((line) => `  ${line}`),
    '- Boundaries:',
    ...boundaries.map((line) => `  ${line}`),
    `- Success criteria: ${successCriteria}`,
    '',
  ].join('\n');
}

function renderSystemMemoryStewardSoul(): string {
  return [
    '# SOUL',
    '',
    '- Agent name: Memory Steward',
    '- Agent ID: memory-steward',
    '- Role: System Memory Steward',
    '- Mission: 保持用户身份低噪声、长期可读、可继续维护',
    '- Working style: 后台整理、直接修改、避免噪声',
    '- Decision principles:',
    '  - 只保留跨会话稳定的信息',
    '- Boundaries:',
    '  - 不作为通用对话助手',
    '- Success criteria: user.md 长期可读且不过度膨胀',
    '',
  ].join('\n');
}

function renderRootWorkspaceSoul(): string {
  return [
    '# SOUL',
    '',
    '- Agent name: 默认Agent',
    '- Agent ID: default',
    '- Role: 实例级默认运维助手',
    '- Mission: 维护当前 gateway 实例的部署、配置、排障与修复流程',
    '- Working style: 直接、可验证、优先收敛补丁债',
    '- Decision principles:',
    '  - 基于事实，不编造执行结果',
    '  - 优先统一入口，不继续叠兼容分支',
    '- Boundaries:',
    '  - 不把租户级业务上下文固化为实例级规则',
    '- Success criteria: 默认工作区长期稳定、提示词可维护、修复入口一致',
    '',
  ].join('\n');
}

function renderDailyMemoryReadme(): string {
  return [
    '# Daily Memory',
    '',
    '在这个目录里按日期创建短期记忆文件，例如 `2026-03-15.md`。',
    '适合记录：当天上下文、临时事项、零散发现、尚未整理进长期身份的内容。',
    '',
  ].join('\n');
}

function buildMergedSoul(input: {
  existingSoul?: string;
  legacyAgentMd?: string;
  legacyIdentity?: string;
  agentName: string;
  agentId: string;
  template: 'default' | 'memory-onboarding' | 'skill-onboarding';
}): string {
  const existing = parseSoulContent(input.existingSoul);
  const legacyAgent = parseLegacyAgentMd(input.legacyAgentMd);
  const legacyIdentity = parseLegacyIdentity(input.legacyIdentity);
  const bootstrap = parseSoulContent(renderSoulBootstrap(input.agentName, input.agentId, input.template));

  const merged: ParsedSoulContent = {
    agentName: existing.agentName ?? legacyAgent.agentName ?? bootstrap.agentName ?? input.agentName,
    agentId: existing.agentId ?? legacyAgent.agentId ?? bootstrap.agentId ?? input.agentId,
    role: existing.role ?? legacyAgent.role ?? legacyIdentity.role ?? bootstrap.role ?? input.agentName,
    mission: existing.mission ?? legacyIdentity.mission ?? bootstrap.mission,
    workingStyle: existing.workingStyle ?? legacyIdentity.workingStyle ?? bootstrap.workingStyle,
    successCriteria: existing.successCriteria ?? legacyIdentity.successCriteria ?? bootstrap.successCriteria,
    decisionPrinciples: dedupeLines([
      ...existing.decisionPrinciples,
      ...legacyIdentity.decisionPrinciples,
      ...bootstrap.decisionPrinciples,
    ]),
    boundaries: dedupeLines([
      ...existing.boundaries,
      ...legacyIdentity.boundaries,
      ...splitInlineBoundary(legacyAgent.boundaries),
      ...bootstrap.boundaries,
    ]),
  };

  return [
    '# SOUL',
    '',
    `- Agent name: ${merged.agentName ?? input.agentName}`,
    `- Agent ID: ${merged.agentId ?? input.agentId}`,
    `- Role: ${merged.role ?? input.agentName}`,
    `- Mission: ${merged.mission ?? ''}`,
    `- Working style: ${merged.workingStyle ?? ''}`,
    '- Decision principles:',
    ...renderListBlock(merged.decisionPrinciples),
    '- Boundaries:',
    ...renderListBlock(merged.boundaries),
    `- Success criteria: ${merged.successCriteria ?? ''}`,
    '',
  ].join('\n');
}

function parseSoulContent(content?: string): ParsedSoulContent {
  return {
    agentName: matchField(content, 'Agent name'),
    agentId: matchField(content, 'Agent ID'),
    role: matchField(content, 'Role'),
    mission: matchField(content, 'Mission'),
    workingStyle: matchField(content, 'Working style'),
    successCriteria: matchField(content, 'Success criteria'),
    decisionPrinciples: matchListField(content, 'Decision principles'),
    boundaries: matchListField(content, 'Boundaries'),
  };
}

function parseLegacyAgentMd(content?: string): {
  agentName?: string;
  agentId?: string;
  role?: string;
  boundaries?: string;
} {
  return {
    agentName: matchField(content, 'Agent Name'),
    agentId: matchField(content, 'Agent ID'),
    role: matchField(content, 'Role'),
    boundaries: matchField(content, 'Boundaries'),
  };
}

function parseLegacyIdentity(content?: string): ParsedSoulContent {
  return {
    role: matchField(content, 'Agent role'),
    mission: matchField(content, 'Mission'),
    workingStyle: matchField(content, 'Working style'),
    successCriteria: matchField(content, 'Success criteria'),
    decisionPrinciples: matchListField(content, 'Decision principles'),
    boundaries: matchListField(content, 'Boundaries'),
    agentName: matchField(content, 'Agent name'),
    agentId: matchField(content, 'Agent ID'),
  };
}

function readWorkspaceMeta(workspaceDir: string): {
  agentName: string;
  agentId: string;
  template: 'default' | 'memory-onboarding' | 'skill-onboarding';
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

  const soul = parseSoulContent(readIfExists(path.join(workspaceDir, 'SOUL.md')));
  if (soul.agentId || soul.agentName) {
    const agentId = soul.agentId ?? path.basename(workspaceDir);
    return {
      agentName: soul.agentName ?? agentId,
      agentId,
      template: resolveTemplateFromAgentId(agentId),
    };
  }

  const legacyAgent = parseLegacyAgentMd(readIfExists(path.join(workspaceDir, 'agent.md')));
  const fallbackAgentId = path.basename(workspaceDir);
  return {
    agentName: legacyAgent.agentName ?? fallbackAgentId,
    agentId: legacyAgent.agentId ?? fallbackAgentId,
    template: resolveTemplateFromAgentId(legacyAgent.agentId ?? fallbackAgentId),
  };
}

function resolveTemplateFromAgentId(agentId: string): 'default' | 'memory-onboarding' | 'skill-onboarding' {
  if (agentId === MEMORY_ONBOARDING_AGENT_ID) {
    return 'memory-onboarding';
  }
  if (agentId === SKILL_ONBOARDING_AGENT_ID) {
    return 'skill-onboarding';
  }
  return 'default';
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

function matchListField(content: string | undefined, label: string): string[] {
  if (!content) {
    return [];
  }
  const blockPattern = new RegExp(`^-\\s+${escapeRegExp(label)}:\\s*\\n((?:\\s{2,}-.*\\n?)*)`, 'im');
  const block = content.match(blockPattern)?.[1];
  if (!block) {
    return [];
  }
  return dedupeLines(
    block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.slice(1).trim())
      .filter((line) => line && line !== '-'),
  );
}

function splitInlineBoundary(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return dedupeLines(value.split(/;|\/|、|，/).map((item) => item.trim()).filter(Boolean));
}

function renderListBlock(lines: string[]): string[] {
  const normalized = lines.length > 0 ? lines : ['-'];
  return normalized.map((line) => `  - ${line}`);
}

function dedupeLines(lines: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized || normalized === '-') {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function resolveAgentId(input: CreateAgentWorkspaceInput): string {
  if (input.template === 'memory-onboarding') {
    return MEMORY_ONBOARDING_AGENT_ID;
  }
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

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function normalizeIdentityText(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .filter((line) => line !== '-')
    .filter((line) => !line.endsWith(':'))
    .join('\n');
}

function hasMeaningfulIdentityContent(content: string): boolean {
  const requiredFields = ['Preferred name', 'Primary role', 'Language style', 'Communication style'];
  return requiredFields.every((label) => matchField(content, label));
}

function hasInitializedSoulContent(content: string): boolean {
  const requiredFields = ['Role', 'Mission', 'Working style', 'Success criteria'];
  for (const label of requiredFields) {
    if (!matchField(content, label)) {
      return false;
    }
  }
  return matchListField(content, 'Decision principles').length > 0
    && matchListField(content, 'Boundaries').length > 0;
}

function stripHeading(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && !lines[0]!.trim()) {
    lines.shift();
  }
  if (lines[0]?.trim().startsWith('#')) {
    lines.shift();
  }
  return lines.filter((line) => line.trim());
}

function summarizeEntries(entries: Array<{ fileName: string; filePath: string }>): MemorySummaryEntry[] {
  return entries.flatMap((entry) => {
    if (!fs.existsSync(entry.filePath)) {
      return [];
    }
    const content = fs.readFileSync(entry.filePath, 'utf8');
    if (!hasMeaningfulIdentityContent(content)) {
      return [];
    }
    return [{
      fileName: entry.fileName,
      summary: summarizeContent(content),
    }];
  });
}

function summarizeDailyFiles(dailyDir: string): Array<{ fileName: string; filePath: string }> {
  if (!fs.existsSync(dailyDir) || !fs.statSync(dailyDir).isDirectory()) {
    return [];
  }
  return fs.readdirSync(dailyDir)
    .filter((fileName) => fileName.endsWith('.md') && fileName !== 'README.md')
    .sort()
    .slice(-2)
    .map((fileName) => ({
      fileName: `daily/${fileName}`,
      filePath: path.join(dailyDir, fileName),
    }));
}

function summarizeContent(content: string): string {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  if (lines.length === 0) {
    return '(已初始化，但当前没有可展示内容)';
  }
  const preview = lines.slice(0, 4).join(' / ');
  return preview.length <= 240 ? preview : `${preview.slice(0, 237)}...`;
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
