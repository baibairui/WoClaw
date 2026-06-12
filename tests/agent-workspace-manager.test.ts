import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentWorkspaceManager } from '../src/services/agent-workspace-manager.js';

describe('AgentWorkspaceManager', () => {
  it('creates scaffold for the built-in default workspace inside the agents directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-default-'));
    const manager = new AgentWorkspaceManager(dir);

    const result = manager.ensureDefaultWorkspace('wecom:u1');

    expect(result.agentId).toBe('default');
    expect(result.workspaceDir).toContain(path.join('users'));
    expect(result.workspaceDir).toContain(path.join('agents', 'default'));
    expect(fs.existsSync(path.join(result.workspaceDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'SOUL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'memory', 'daily'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'gateway-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'macos-gui-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'reminder-tool', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'TOOLS.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'browser-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'feishu-ops-playbook.md'))).toBe(false);
  });

  it('creates a minimal workspace scaffold plus runtime and user identity files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);

    const result = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: 'Frontend Pair',
      existingAgentIds: [],
    });

    const userDir = findOnlyUserDir(dir);
    const agentsMd = fs.readFileSync(path.join(result.workspaceDir, 'AGENTS.md'), 'utf8');
    const soul = fs.readFileSync(path.join(result.workspaceDir, 'SOUL.md'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(result.workspaceDir, '.codex', 'workspace.json'), 'utf8')) as Record<string, unknown>;

    expect(result.agentId).toBe('frontend-pair');
    expect(result.workspaceDir).toBe(path.join(userDir, 'agents', 'frontend-pair'));
    expect(fs.existsSync(path.join(dir, 'runtime', 'shared-context.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'runtime', 'house-rules.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'user.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'internal'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'memory', 'daily'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'lark-cli', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'social-intel', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'TOOLS.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'browser-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'feishu-ops-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'memory', 'identity.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'memory', 'profile.md'))).toBe(false);
    expect(agentsMd).toContain('./SOUL.md');
    expect(agentsMd).toContain('../../user.md');
    expect(agentsMd).toContain('../../../../runtime/house-rules.md');
    expect(agentsMd).toContain('../../../../runtime/shared-context.md');
    expect(agentsMd).toContain('./.codex/skills/gateway-browser/SKILL.md');
    expect(agentsMd).toContain('./.codex/skills/lark-cli/SKILL.md');
    expect(agentsMd).not.toContain('browser-playbook');
    expect(agentsMd).not.toContain('feishu-ops-playbook');
    expect(soul).toContain('- Agent name: Frontend Pair');
    expect(soul).toContain('- Agent ID: frontend-pair');
    expect(soul).toContain('- Role: Frontend Pair');
    expect(manifest.agentId).toBe('frontend-pair');
    expect(manifest.template).toBe('default');
  });

  it('creates hidden system memory steward workspace under the internal directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);

    const result = manager.ensureSystemMemoryStewardWorkspace('wecom:u1');

    const agentsMd = fs.readFileSync(path.join(result.workspaceDir, 'AGENTS.md'), 'utf8');
    const soul = fs.readFileSync(path.join(result.workspaceDir, 'SOUL.md'), 'utf8');

    expect(result.workspaceDir).toContain(path.join('internal', 'memory-steward'));
    expect(fs.existsSync(path.join(result.workspaceDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, 'agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'TOOLS.md'))).toBe(false);
    expect(agentsMd).toContain('Memory Steward');
    expect(agentsMd).toContain('../../user.md');
    expect(agentsMd).toContain('../../../../runtime/house-rules.md');
    expect(agentsMd).toContain('../../../../runtime/shared-context.md');
    expect(soul).toContain('- Role: System Memory Steward');
  });

  it('repairs root workspace AGENTS.md by removing legacy references', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-root-repair-'));
    const manager = new AgentWorkspaceManager(dir);
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      [
        '# Root Agent',
        '',
        '- `./TOOLS.md`',
        '- `./memory/identity.md`',
        '- `./shared-memory/identity.md`',
        '- browser-playbook.md',
        '- feishu-ops-playbook.md',
      ].join('\n'),
      'utf8',
    );

    manager.repairWorkspaceScaffold(dir);

    const agentsMd = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('./TOOLS.md');
    expect(agentsMd).not.toContain('./memory/identity.md');
    expect(agentsMd).not.toContain('./shared-memory/identity.md');
    expect(agentsMd).not.toContain('browser-playbook');
    expect(agentsMd).not.toContain('feishu-ops-playbook');
  });

  it('repairs the root workspace as a managed default agent without overwriting AGENTS.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-root-managed-'));
    const manager = new AgentWorkspaceManager(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Root Agent Rules\n', 'utf8');

    manager.repairWorkspaceScaffold(dir);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'workspace.json'), 'utf8')) as Record<string, unknown>;
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('# Root Agent Rules');
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'SOUL.md'))).toBe(true);
    expect(manifest.agentId).toBe('default');
    expect(manifest.agentName).toBe('默认Agent');
  });

  it('creates minimal onboarding scaffolds without legacy checklist files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);

    const memoryOnboarding = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: '记忆初始化引导',
      existingAgentIds: [],
      template: 'memory-onboarding',
    });
    const skillOnboarding = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: '技能扩展助手',
      existingAgentIds: [memoryOnboarding.agentId],
      template: 'skill-onboarding',
    });

    const memorySoul = fs.readFileSync(path.join(memoryOnboarding.workspaceDir, 'SOUL.md'), 'utf8');
    const skillSoul = fs.readFileSync(path.join(skillOnboarding.workspaceDir, 'SOUL.md'), 'utf8');

    expect(memoryOnboarding.agentId).toBe('memory-onboarding');
    expect(skillOnboarding.agentId).toBe('skill-onboarding');
    expect(memorySoul).toContain('记忆初始化引导');
    expect(skillSoul).toContain('技能扩展助手');
    expect(fs.existsSync(path.join(memoryOnboarding.workspaceDir, 'memory-init-checklist.md'))).toBe(false);
    expect(fs.existsSync(path.join(skillOnboarding.workspaceDir, 'skill-install-checklist.md'))).toBe(false);
  });

  it('detects whether the user identity has meaningful content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const userId = 'wecom:u1';

    manager.createWorkspace({
      userId,
      agentName: '个人助理',
      existingAgentIds: [],
    });
    expect(manager.isSharedMemoryEmpty(userId)).toBe(true);

    const userDir = findOnlyUserDir(dir);
    fs.writeFileSync(path.join(userDir, 'user.md'), [
      '# User Identity',
      '',
      '## Core Identity',
      '- Preferred name: Alice',
      '- Primary role: 工程师',
      '- Language style: 中文',
      '- Communication style: 直接',
      '- Decision principles:',
      '  - 基于事实',
      '',
      '## Stable Preferences',
      '-',
      '',
      '## Ongoing Context',
      '-',
      '',
    ].join('\n'), 'utf8');

    expect(manager.isSharedMemoryEmpty(userId)).toBe(false);
  });

  it('keeps user identity empty until core identity fields are populated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const userId = 'wecom:u1';

    manager.createWorkspace({
      userId,
      agentName: '个人助理',
      existingAgentIds: [],
    });

    const userDir = findOnlyUserDir(dir);
    fs.writeFileSync(path.join(userDir, 'user.md'), [
      '# User Identity',
      '',
      '## Core Identity',
      '- Preferred name: Alice',
      '- Primary role:',
      '- Language style:',
      '- Communication style:',
      '- Decision principles:',
      '  - 基于事实',
      '',
      '## Stable Preferences',
      '-',
      '',
      '## Ongoing Context',
      '-',
      '',
    ].join('\n'), 'utf8');

    expect(manager.isSharedMemoryEmpty(userId)).toBe(true);

    fs.writeFileSync(path.join(userDir, 'user.md'), [
      '# User Identity',
      '',
      '## Core Identity',
      '- Preferred name: Alice',
      '- Primary role: 工程师',
      '- Language style: 中文',
      '- Communication style: 直接',
      '- Decision principles:',
      '  - 基于事实',
      '',
      '## Stable Preferences',
      '-',
      '',
      '## Ongoing Context',
      '-',
      '',
    ].join('\n'), 'utf8');

    expect(manager.isSharedMemoryEmpty(userId)).toBe(false);
  });

  it('detects whether a workspace soul is initialized', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const userId = 'wecom:u1';

    const workspace = manager.createWorkspace({
      userId,
      agentName: 'first-agent',
      existingAgentIds: [],
    });
    expect(manager.isWorkspaceIdentityEmpty(workspace.workspaceDir)).toBe(true);

    fs.writeFileSync(path.join(workspace.workspaceDir, 'SOUL.md'), [
      '# SOUL',
      '',
      '- Agent name: first-agent',
      '- Agent ID: first-agent',
      '- Role: first-agent',
      '- Mission: 负责需求澄清与实现',
      '- Working style: 直接、基于事实',
      '- Decision principles:',
      '  - 遵守事实',
      '- Boundaries:',
      '  - 不做半途兼容方案',
      '- Success criteria: 可验证、可回归、可上线',
      '',
    ].join('\n'), 'utf8');

    expect(manager.isWorkspaceIdentityEmpty(workspace.workspaceDir)).toBe(false);
  });

  it('keeps workspace identity empty until role is initialized as well', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const userId = 'wecom:u1';

    const workspace = manager.createWorkspace({
      userId,
      agentName: 'first-agent',
      existingAgentIds: [],
    });

    fs.writeFileSync(path.join(workspace.workspaceDir, 'SOUL.md'), [
      '# SOUL',
      '',
      '- Agent name: first-agent',
      '- Agent ID: first-agent',
      '- Role:',
      '- Mission: 负责需求澄清与实现',
      '- Working style: 直接、基于事实',
      '- Decision principles:',
      '  - 遵守事实',
      '- Boundaries:',
      '  - 不做半途兼容方案',
      '- Success criteria: 可验证、可回归、可上线',
      '',
    ].join('\n'), 'utf8');

    expect(manager.isWorkspaceIdentityEmpty(workspace.workspaceDir)).toBe(true);

    fs.writeFileSync(path.join(workspace.workspaceDir, 'SOUL.md'), [
      '# SOUL',
      '',
      '- Agent name: first-agent',
      '- Agent ID: first-agent',
      '- Role: first-agent',
      '- Mission: 负责需求澄清与实现',
      '- Working style: 直接、基于事实',
      '- Decision principles:',
      '  - 遵守事实',
      '- Boundaries:',
      '  - 不做半途兼容方案',
      '- Success criteria: 可验证、可回归、可上线',
      '',
    ].join('\n'), 'utf8');

    expect(manager.isWorkspaceIdentityEmpty(workspace.workspaceDir)).toBe(false);
  });

  it('migrates legacy shared memory into user.md and moves the steward workspace under internal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const userDir = path.join(dir, 'users', 'legacy-user');
    const sharedMemoryDir = path.join(userDir, 'shared-memory');
    const legacyStewardDir = path.join(userDir, '_memory-steward');

    fs.mkdirSync(path.join(sharedMemoryDir, 'daily'), { recursive: true });
    fs.mkdirSync(legacyStewardDir, { recursive: true });
    fs.writeFileSync(path.join(sharedMemoryDir, 'identity.md'), '# Identity\n\n- Preferred name: Alice\n', 'utf8');
    fs.writeFileSync(path.join(sharedMemoryDir, 'preferences.md'), '# Preferences\n\n- 中文交流\n', 'utf8');
    fs.writeFileSync(path.join(legacyStewardDir, 'README.md'), '# Legacy Steward\n', 'utf8');

    manager.repairUserSharedMemoryTree(userDir);

    expect(fs.existsSync(path.join(userDir, 'user.md'))).toBe(true);
    expect(fs.readFileSync(path.join(userDir, 'user.md'), 'utf8')).toContain('Alice');
    expect(fs.readFileSync(path.join(userDir, 'user.md'), 'utf8')).toContain('中文交流');
    expect(fs.existsSync(path.join(userDir, '_legacy', 'shared-memory', 'identity.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'shared-memory'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'internal', 'memory-steward', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, '_memory-steward'))).toBe(false);
  });

  it('migrates a legacy agent workspace into agents dir and merges soul content idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const userDir = path.join(dir, 'users', 'legacy-user');
    const legacyWorkspaceDir = path.join(userDir, 'frontend-pair');

    fs.mkdirSync(path.join(legacyWorkspaceDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'agent.md'), [
      '# Agent Memory Index',
      '',
      '- Agent Name: Frontend Pair',
      '- Agent ID: frontend-pair',
      '- Role: Frontend Pair',
      '- Boundaries: Avoid unrelated edits',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'memory', 'identity.md'), [
      '# Identity',
      '',
      '## Current Agent Identity',
      '- Agent name: Frontend Pair',
      '- Agent ID: frontend-pair',
      '- Agent role: Frontend Pair',
      '- Mission: Build the UI refactor',
      '- Working style: Direct and test-first',
      '- Decision principles:',
      '  - Prefer minimal diffs',
      '- Boundaries:',
      '  - Keep scope tight',
      '- Success criteria: Verified changes only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'TOOLS.md'), '# TOOLS\n', 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'browser-playbook.md'), '# Browser Playbook\n', 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'feishu-ops-playbook.md'), '# Feishu Ops Playbook\n', 'utf8');

    manager.repairWorkspaceScaffold(legacyWorkspaceDir);

    const migratedWorkspaceDir = path.join(userDir, 'agents', 'frontend-pair');
    const firstSoul = fs.readFileSync(path.join(migratedWorkspaceDir, 'SOUL.md'), 'utf8');

    expect(fs.existsSync(migratedWorkspaceDir)).toBe(true);
    expect(firstSoul).toContain('- Mission: Build the UI refactor');
    expect(firstSoul).toContain('- Working style: Direct and test-first');
    expect(firstSoul).toContain('- Success criteria: Verified changes only');
    expect(firstSoul).toContain('Prefer minimal diffs');
    expect(firstSoul).toContain('Keep scope tight');
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'TOOLS.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'browser-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'feishu-ops-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'memory', 'identity.md'))).toBe(false);

    manager.repairWorkspaceScaffold(migratedWorkspaceDir);

    expect(fs.readFileSync(path.join(migratedWorkspaceDir, 'SOUL.md'), 'utf8')).toBe(firstSoul);
  });

  it('reuses onboarding workspace ids but refreshes managed scaffold to the new memory layout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);
    const workspace = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: '记忆初始化引导',
      existingAgentIds: [],
      template: 'memory-onboarding',
    });

    fs.writeFileSync(path.join(workspace.workspaceDir, 'AGENTS.md'), [
      '# AGENTS.md',
      '',
      '开始任务前，先阅读这些文件：',
      '- `./agent.md`',
      '- `./memory/identity.md`',
      '- `./memory/profile.md`',
      '- `./memory/preferences.md`',
      '- `./memory/projects.md`',
      '- `./memory/relationships.md`',
      '- `./memory/decisions.md`',
      '- `./memory/open-loops.md`',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(workspace.workspaceDir, 'README.md'), '# Legacy Agent\n\n旧版说明。\n', 'utf8');
    fs.writeFileSync(path.join(workspace.workspaceDir, 'SOUL.md'), [
      '# SOUL',
      '',
      '- Agent name: 记忆初始化引导',
      '- Agent ID: memory-onboarding',
      '- Role: 记忆初始化引导',
      '- Mission: 保留已有身份',
      '- Working style: 直接',
      '- Decision principles:',
      '  - 先验证',
      '- Boundaries:',
      '  - 不编造',
      '- Success criteria: 可验证',
      '',
    ].join('\n'), 'utf8');

    const recreated = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: '记忆初始化引导',
      existingAgentIds: ['memory-onboarding'],
      template: 'memory-onboarding',
    });

    expect(recreated.agentId).toBe('memory-onboarding');
    expect(recreated.workspaceDir).toBe(workspace.workspaceDir);

    const agentsMd = fs.readFileSync(path.join(recreated.workspaceDir, 'AGENTS.md'), 'utf8');
    const readme = fs.readFileSync(path.join(recreated.workspaceDir, 'README.md'), 'utf8');
    const soul = fs.readFileSync(path.join(recreated.workspaceDir, 'SOUL.md'), 'utf8');

    expect(agentsMd).toContain('./SOUL.md');
    expect(agentsMd).toContain('../../user.md');
    expect(agentsMd).toContain('./memory/daily/');
    expect(agentsMd).not.toContain('./memory/identity.md');
    expect(agentsMd).not.toContain('./memory/profile.md');
    expect(readme).toContain('该 agent 用于引导用户补齐用户身份与当前 agent 身份。');
    expect(soul).toContain('- Mission: 保留已有身份');
    expect(soul).toContain('- Success criteria: 可验证');
  });
});

function findOnlyUserDir(rootDir: string): string {
  const usersDir = path.join(rootDir, 'users');
  const userDirs = fs.readdirSync(usersDir);
  expect(userDirs).toHaveLength(1);
  return path.join(usersDir, userDirs[0]!);
}
