import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  installGatewayDesktopSkill,
  renderGatewayDesktopSkill,
  syncManagedGlobalDesktopSkills,
} from '../src/services/gateway-desktop-skill.js';

describe('gateway-desktop-skill', () => {
  it('installs gateway desktop skill in workspace local skills', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-desktop-skill-'));
    installGatewayDesktopSkill(dir);

    const skillFile = path.join(dir, '.codex', 'skills', 'macos-gui-skill', 'SKILL.md');
    const scriptFile = path.join(dir, '.codex', 'skills', 'macos-gui-skill', 'scripts', 'macos-gui-skill.mjs');
    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.existsSync(scriptFile)).toBe(true);
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('name: macos-gui-skill');
    expect(fs.readFileSync(scriptFile, 'utf8')).toContain("@nut-tree-fork/nut-js");
    expect(fs.readFileSync(scriptFile, 'utf8')).toContain('PNG.sync.read');
    expect(fs.readFileSync(scriptFile, 'utf8')).toContain('screencapture');
    expect(fs.readFileSync(scriptFile, 'utf8')).not.toContain('GATEWAY_DESKTOP_API_BASE');
  });

  it('upgrades legacy desktop rules in AGENTS.md to the skill-only workflow', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-desktop-skill-'));
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      [
        '# AGENTS.md',
        '',
        '桌面操作职责：',
        '- 当任务需要桌面软件交互时，只允许使用 shell 命令或 osascript 直接操作系统。',
        '- 每次操作前先说明计划步骤，操作后回报关键结果与下一步。',
        '',
      ].join('\n'),
      'utf8',
    );

    installGatewayDesktopSkill(dir);

    const agentsMd = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('<!-- gateway:desktop-rule:start -->');
    expect(agentsMd).toContain('./.codex/skills/macos-gui-skill/SKILL.md');
    expect(agentsMd).toContain('`observe`');
    expect(agentsMd).toContain('`act`');
    expect(agentsMd).toContain('前台可见应用');
    expect(agentsMd).not.toContain('shell 命令或 osascript 直接操作系统');
  });

  it('renders desktop workflow with visual-first observe and bundled act guidance', () => {
    const skill = renderGatewayDesktopSkill();

    expect(skill).toContain('./scripts/macos-gui-skill.mjs observe');
    expect(skill).toContain('./scripts/macos-gui-skill.mjs act --steps');
    expect(skill).toContain('`observe -> act -> observe`');
    expect(skill).toContain('doctor');
    expect(skill).toContain('locate-image');
    expect(skill).toContain('Do not claim the skill "lacks dependencies"');
    expect(skill).toContain('restore the remembered target app');
    expect(skill).toContain('frontmost visible application only');
    expect(skill).toContain('Do not start with `run-shell` or `run-applescript`');
    expect(skill).toContain('request confirmation');
    expect(skill).toContain('local macOS execution');
    expect(skill).toContain('Accessibility');
    expect(skill).toContain('Automation');
    expect(skill).not.toContain('./.codex/skills/macos-gui-skill/scripts/macos-gui-skill.mjs');
  });

  it('renders direct local desktop helpers, observe, act, and workspace artifact output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-desktop-skill-'));
    installGatewayDesktopSkill(dir);

    const scriptFile = path.join(dir, '.codex', 'skills', 'macos-gui-skill', 'scripts', 'macos-gui-skill.mjs');
    const script = fs.readFileSync(scriptFile, 'utf8');

    expect(script).toContain("process.platform !== 'darwin'");
    expect(script).toContain("case 'observe':");
    expect(script).toContain("case 'act':");
    expect(script).toContain("const steps = jsonArrayValue(parsed.steps, '--steps');");
    expect(script).toContain('action bundles support at most 5 steps');
    expect(script).toContain("step.type === 'run-shell' || step.type === 'run-applescript'");
    expect(script).toContain('.codex/artifacts/desktop');
    expect(script).toContain("case 'doctor':");
    expect(script).toContain("case 'list-windows':");
    expect(script).toContain("case 'window-bounds':");
    expect(script).toContain("case 'locate-image':");
    expect(script).toContain("case 'locate-image-center':");
    expect(script).toContain("case 'run-applescript':");
    expect(script).toContain("case 'run-shell':");
    expect(script).toContain('screenshot [--app-name <name>] [--filename desktop-step.png] [--show-cursor true] [--settle-ms 350]');
    expect(script).toContain('observe [--app-name <name>] [--filename desktop-observe.png] [--label inbox] [--show-cursor true] [--settle-ms 350]');
    expect(script).toContain('doctor');
    expect(script).toContain('locate-image --image <template.png>');
    expect(script).toContain("case 'input-text':");
    expect(script).toContain("case 'type':");
    expect(script).toContain("text: `observed ${frontmostApp}`");
    expect(script).toContain('press-key --key <key>');
    expect(script).toContain('showCursor: booleanValue(parsed["show-cursor"] ?? parsed.showCursor)');
    expect(script).toContain('loadNutJs');
    expect(script).toContain("import { createRequire } from 'node:module';");
    expect(script).toContain('PNG.sync.read');
    expect(script).toContain('resolveNutJsSpecifier');
    expect(script).toContain("__macos-gui-skill__.cjs");
    expect(script).toContain('const HOST_APP_NAMES = new Set([');
    expect(script).toContain('readDesktopSessionState');
    expect(script).toContain('writeDesktopSessionState');
    expect(script).toContain('maybeRestoreRememberedApp');
    expect(script).toContain('ensureScreenCaptureAccess');
    expect(script).toContain('ensureAccessibilityAccess');
    expect(script).toContain('AXIsProcessTrustedWithOptions');
    expect(script).toContain('kAXTrustedCheckOptionPrompt');
    expect(script).toContain('CGPreflightScreenCaptureAccess()');
    expect(script).toContain('CGRequestScreenCaptureAccess()');
    expect(script).toContain('openAccessibilitySettings');
    expect(script).toContain('openScreenCaptureSettings');
    expect(script).toContain('runAppleScript');
    expect(script).toContain('Privacy_Automation');
    expect(script).toContain('Automation permission is required');
    expect(script).toContain('A system permission prompt may have been opened for you.');
    expect(script).toContain('Without it, macOS screenshots will only show the wallpaper or desktop.');
    expect(script).toContain('appName: optionalString(parsed["app-name"] ?? parsed.appName)');
    expect(script).toContain('settleMs: optionalNumber(parsed["settle-ms"] ?? parsed.settleMs) ?? 350');
    expect(script).toContain('actReady');
    expect(script).toContain('fallbackPolicy');
    expect(script.indexOf('const HOST_APP_NAMES = new Set([')).toBeLessThan(script.indexOf('try {'));
    expect(script.indexOf('let nutJsPromise;')).toBeLessThan(script.indexOf('try {'));
  });

  it('syncs managed desktop skills into global skill roots', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'global-desktop-skills-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'global-desktop-skills-b-'));

    syncManagedGlobalDesktopSkills({ roots: [rootA, rootB] });

    expect(fs.existsSync(path.join(rootA, 'macos-gui-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(rootB, 'macos-gui-skill', 'SKILL.md'))).toBe(true);
  });

  it('uses configured runner-home roots for default managed global desktop skill roots', async () => {
    const runnerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-desktop-runner-home-'));
    const codexRoot = path.join(runnerHome, '.codex', 'skills');
    const agentsRoot = path.join(runnerHome, '.agents', 'skills');

    vi.resetModules();
    const mod = await import('../src/services/gateway-desktop-skill.js');
    try {
      mod.configureManagedGlobalSkillRoots([codexRoot, agentsRoot]);
      mod.syncManagedGlobalDesktopSkills();

      expect(fs.existsSync(path.join(codexRoot, 'macos-gui-skill', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(agentsRoot, 'macos-gui-skill', 'SKILL.md'))).toBe(true);
    } finally {
      mod.configureManagedGlobalSkillRoots(undefined);
    }
  });
});
