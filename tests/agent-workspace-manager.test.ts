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
    expect(fs.existsSync(path.join(result.workspaceDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'gateway-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'macos-gui-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'reminder-tool', 'SKILL.md'))).toBe(true);
    // Memory-era artifacts are no longer scaffolded.
    expect(fs.existsSync(path.join(result.workspaceDir, 'SOUL.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'TOOLS.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'browser-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'feishu-ops-playbook.md'))).toBe(false);
  });

  it('creates a minimal workspace scaffold without memory or identity files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);

    const result = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: 'Frontend Pair',
      existingAgentIds: [],
    });

    const userDir = findOnlyUserDir(dir);
    const agentsMd = fs.readFileSync(path.join(result.workspaceDir, 'AGENTS.md'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(result.workspaceDir, '.codex', 'workspace.json'), 'utf8')) as Record<string, unknown>;

    expect(result.agentId).toBe('frontend-pair');
    expect(result.workspaceDir).toBe(path.join(userDir, 'agents', 'frontend-pair'));
    expect(fs.existsSync(path.join(userDir, 'agents'))).toBe(true);
    // No more shared user identity, runtime memory rules, SOUL or memory directories.
    expect(fs.existsSync(path.join(dir, 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'user.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'SOUL.md'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'lark-cli', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspaceDir, '.codex', 'skills', 'social-intel', 'SKILL.md'))).toBe(true);
    expect(agentsMd).toContain('当前工作区属于 agent `Frontend Pair`');
    expect(agentsMd).toContain('./.codex/skills/gateway-browser/SKILL.md');
    expect(agentsMd).toContain('./.codex/skills/lark-cli/SKILL.md');
    expect(agentsMd).not.toContain('SOUL.md');
    expect(agentsMd).not.toContain('user.md');
    expect(agentsMd).not.toContain('memory/daily');
    expect(agentsMd).not.toContain('browser-playbook');
    expect(agentsMd).not.toContain('feishu-ops-playbook');
    expect(manifest.agentId).toBe('frontend-pair');
    expect(manifest.template).toBe('default');
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
        '- `./SOUL.md`',
        '- `./memory/identity.md`',
        '- `../../user.md`',
        '- `./shared-memory/identity.md`',
        '- browser-playbook.md',
        '- feishu-ops-playbook.md',
      ].join('\n'),
      'utf8',
    );

    manager.repairWorkspaceScaffold(dir);

    const agentsMd = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).not.toContain('./TOOLS.md');
    expect(agentsMd).not.toContain('./SOUL.md');
    expect(agentsMd).not.toContain('./memory/identity.md');
    expect(agentsMd).not.toContain('user.md');
    expect(agentsMd).not.toContain('shared-memory');
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
    expect(manifest.agentId).toBe('default');
    expect(manifest.agentName).toBe('默认Agent');
  });

  it('creates the skill-onboarding workspace with a fixed id and no legacy checklist files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-'));
    const manager = new AgentWorkspaceManager(dir);

    const skillOnboarding = manager.createWorkspace({
      userId: 'wecom:u1',
      agentName: '技能扩展助手',
      existingAgentIds: [],
      template: 'skill-onboarding',
    });

    const agentsMd = fs.readFileSync(path.join(skillOnboarding.workspaceDir, 'AGENTS.md'), 'utf8');

    expect(skillOnboarding.agentId).toBe('skill-onboarding');
    expect(agentsMd).toContain('技能扩展职责');
    expect(fs.existsSync(path.join(skillOnboarding.workspaceDir, 'skill-install-checklist.md'))).toBe(false);
    expect(fs.existsSync(path.join(skillOnboarding.workspaceDir, 'SOUL.md'))).toBe(false);
  });

  it('migrates a legacy agent workspace into the agents dir and strips legacy files', () => {
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
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'SOUL.md'), '# SOUL\n\n- Agent name: Frontend Pair\n', 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'TOOLS.md'), '# TOOLS\n', 'utf8');
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'browser-playbook.md'), '# Browser Playbook\n', 'utf8');

    manager.repairWorkspaceScaffold(legacyWorkspaceDir);

    const migratedWorkspaceDir = path.join(userDir, 'agents', 'frontend-pair');
    expect(fs.existsSync(migratedWorkspaceDir)).toBe(true);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'SOUL.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'TOOLS.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'browser-playbook.md'))).toBe(false);
    expect(fs.existsSync(path.join(migratedWorkspaceDir, 'memory'))).toBe(false);

    // Idempotent: a second repair pass keeps the managed AGENTS.md stable.
    const firstAgentsMd = fs.readFileSync(path.join(migratedWorkspaceDir, 'AGENTS.md'), 'utf8');
    manager.repairWorkspaceScaffold(migratedWorkspaceDir);
    expect(fs.readFileSync(path.join(migratedWorkspaceDir, 'AGENTS.md'), 'utf8')).toBe(firstAgentsMd);
  });
});

function findOnlyUserDir(rootDir: string): string {
  const usersDir = path.join(rootDir, 'users');
  const userDirs = fs.readdirSync(usersDir);
  expect(userDirs).toHaveLength(1);
  return path.join(usersDir, userDirs[0]!);
}
