import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  installGatewayBrowserSkill,
  renderGatewayBrowserSkill,
  syncManagedGlobalSkills,
} from '../src/services/gateway-browser-skill.js';

describe('gateway-browser-skill', () => {
  it('installs gateway browser skill in workspace local skills', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-browser-skill-'));
    installGatewayBrowserSkill(dir);

    const skillFile = path.join(dir, '.codex', 'skills', 'gateway-browser', 'SKILL.md');
    const scriptFile = path.join(dir, '.codex', 'skills', 'gateway-browser', 'scripts', 'gateway-browser.mjs');
    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.existsSync(scriptFile)).toBe(true);
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('name: gateway-browser');
  });

  it('upgrades legacy browser rules in AGENTS.md to the skill-only workflow', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-browser-skill-'));
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      [
        '# AGENTS.md',
        '',
        '浏览器操作职责：',
        '- 当任务需要网页交互时，只允许使用 gateway 提供的 browser_* MCP 工具完成操作，而不是让用户手工点击。',
        '- 禁止使用 playwright-cli、npx @playwright/mcp、任何自定义 wrapper script、/open 或其他 shell/browser 启动通道。',
        '- 每次操作前先说明计划步骤，操作后回报关键结果与下一步。',
        '',
        '定时提醒职责：',
        '- 当用户提出“稍后提醒我”这类需求时，不要要求用户输入 `/remind` 命令。',
        '',
      ].join('\n'),
      'utf8',
    );

    installGatewayBrowserSkill(dir);

    const agentsMd = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('<!-- gateway:browser-rule:start -->');
    expect(agentsMd).toContain('./.codex/skills/gateway-browser/SKILL.md');
    expect(agentsMd).toContain('自带脚本完成操作');
    expect(agentsMd).not.toContain('browser_* MCP 工具');
    expect(agentsMd).not.toContain('@playwright/mcp');
  });

  it('dedupes repeated browser managed sections in AGENTS.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-browser-skill-'));
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      [
        '# AGENTS.md',
        '',
        '<!-- gateway:browser-rule:start -->',
        '旧浏览器规则 A',
        '<!-- gateway:browser-rule:end -->',
        '',
        '<!-- gateway:browser-rule:start -->',
        '旧浏览器规则 B',
        '<!-- gateway:browser-rule:end -->',
        '',
        '<!-- gateway:browser-rule:start -->',
        '',
      ].join('\n'),
      'utf8',
    );

    installGatewayBrowserSkill(dir);

    const agentsMd = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsMd.match(/<!-- gateway:browser-rule:start -->/g)?.length).toBe(1);
    expect(agentsMd.match(/<!-- gateway:browser-rule:end -->/g)?.length).toBe(1);
    expect(agentsMd).toContain('./.codex/skills/gateway-browser/SKILL.md');
    expect(agentsMd).not.toContain('旧浏览器规则 A');
    expect(agentsMd).not.toContain('旧浏览器规则 B');
  });

  it('renders browser workflow with evidence and safety rules', () => {
    const skill = renderGatewayBrowserSkill();

    expect(skill).toContain('gateway-browser.mjs snapshot');
    expect(skill).not.toContain('browser-playbook');
    expect(skill).not.toContain('feishu-ops-playbook');
    expect(skill).toContain('refs are not stable across navigations');
    expect(skill).toContain('use `screenshot`, `tabs`, `evaluate`, or recording commands to collect evidence');
    expect(skill).toContain('Report format:');
    expect(skill).toContain('Evidence: snapshot/screenshot/console/network findings');
    expect(skill).toContain('Next step: the next minimal action or the exact user takeover request.');
    expect(skill).toContain('Status templates:');
    expect(skill).toContain('In progress: report the latest action');
    expect(skill).toContain('Blocked: report the blocker, risk');
    expect(skill).toContain('Handoff: report why user takeover is required');
    expect(skill).toContain('Done: report what was completed');
    expect(skill).toContain('Stop conditions:');
    expect(skill).toContain('multiple similar targets exist');
    expect(skill).toContain('upload files, or submit content the user did not explicitly approve');
    expect(skill).toContain('report the last confirmed page state');
    expect(skill).toContain('capture evidence and confirm intent');
    expect(skill).toContain('capture a screenshot instead of guessing from stale refs');
    expect(skill).toContain('inspect console/network before retrying');
    expect(skill).toContain('report the exact resume point');
    expect(skill).toContain('cookies, and storage as sensitive data');
  });

  it('syncs managed global skills and removes legacy skill dirs', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'global-skills-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'global-skills-b-'));

    fs.mkdirSync(path.join(rootA, 'playwright-explore-website'), { recursive: true });
    fs.mkdirSync(path.join(rootA, 'react-best-practices'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'playwright-explore-website'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'react-best-practices'), { recursive: true });

    syncManagedGlobalSkills({ roots: [rootA, rootB] });

    expect(fs.existsSync(path.join(rootA, 'playwright-explore-website'))).toBe(false);
    expect(fs.existsSync(path.join(rootA, 'react-best-practices'))).toBe(false);
    expect(fs.existsSync(path.join(rootB, 'playwright-explore-website'))).toBe(false);
    expect(fs.existsSync(path.join(rootB, 'react-best-practices'))).toBe(false);
    expect(fs.existsSync(path.join(rootA, 'gateway-browser', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(rootB, 'gateway-browser', 'SKILL.md'))).toBe(true);
  });

  it('uses configured runner-home roots for default managed global skill roots', async () => {
    const runnerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-browser-runner-home-'));
    const codexRoot = path.join(runnerHome, '.codex', 'skills');
    const agentsRoot = path.join(runnerHome, '.agents', 'skills');

    vi.resetModules();
    const mod = await import('../src/services/gateway-browser-skill.js');
    try {
      mod.configureManagedGlobalSkillRoots([codexRoot, agentsRoot]);
      mod.syncManagedGlobalSkills();

      expect(fs.existsSync(path.join(codexRoot, 'gateway-browser', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(agentsRoot, 'gateway-browser', 'SKILL.md'))).toBe(true);
    } finally {
      mod.configureManagedGlobalSkillRoots(undefined);
    }
  });
});
