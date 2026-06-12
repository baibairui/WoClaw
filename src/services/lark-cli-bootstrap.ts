import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveManagedGlobalSkillRoots } from './managed-global-skill-roots.js';

const REQUIRED_LARK_SKILLS = [
  'lark-shared',
  'lark-doc',
  'lark-calendar',
  'lark-task',
  'lark-wiki',
] as const;

interface EnsureLarkCliReadyInput {
  cliHomeDirs: string[];
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export async function ensureLarkCliReady(input: EnsureLarkCliReadyInput): Promise<void> {
  const hostHomeDir = process.env.HOME?.trim();
  if (!hostHomeDir) {
    input.log?.warn('跳过 lark-cli 启动自举：HOME 未设置');
    return;
  }

  const resolvedHostHome = path.resolve(hostHomeDir);
  ensureLarkCliBinary(input.log);
  ensureOfficialLarkSkillsInstalled(resolvedHostHome, input.log);

  const targetRoots = resolveManagedGlobalSkillRoots(input.cliHomeDirs);
  syncOfficialLarkSkills(resolvedHostHome, targetRoots, input.log);
}

function ensureLarkCliBinary(log?: EnsureLarkCliReadyInput['log']): void {
  if (commandExists('lark-cli')) {
    return;
  }
  log?.info('未检测到 lark-cli，开始自动安装');
  runCommand('npm', ['install', '-g', '@larksuite/cli']);
  log?.info('lark-cli 自动安装完成');
}

function ensureOfficialLarkSkillsInstalled(hostHomeDir: string, log?: EnsureLarkCliReadyInput['log']): void {
  if (hasRequiredSkills(hostHomeDir)) {
    return;
  }
  log?.info('未检测到官方 lark skills，开始自动安装');
  runCommand('npx', ['skills', 'add', 'larksuite/cli', '-y', '-g']);
  if (!hasRequiredSkills(hostHomeDir)) {
    throw new Error('lark-cli skills install finished but required lark skills are still missing');
  }
  log?.info('官方 lark skills 自动安装完成');
}

function syncOfficialLarkSkills(
  hostHomeDir: string,
  targetRoots: string[],
  log?: EnsureLarkCliReadyInput['log'],
): void {
  const sourceRoots = [
    path.join(hostHomeDir, '.codex', 'skills'),
    path.join(hostHomeDir, '.agents', 'skills'),
  ];
  const copied = new Set<string>();
  for (const sourceRoot of sourceRoots) {
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('lark-')) {
        continue;
      }
      const sourceDir = path.join(sourceRoot, entry.name);
      const skillFile = path.join(sourceDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        continue;
      }
      for (const targetRoot of targetRoots) {
        const targetDir = path.join(targetRoot, entry.name);
        fs.mkdirSync(targetRoot, { recursive: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
      }
      copied.add(entry.name);
    }
  }
  if (copied.size > 0) {
    log?.info('已同步官方 lark skills 到 gateway 运行目录', {
      skills: Array.from(copied).sort(),
      targetRoots,
    });
  }
}

function hasRequiredSkills(hostHomeDir: string): boolean {
  return REQUIRED_LARK_SKILLS.every((skillName) => resolveSkillDir(hostHomeDir, skillName));
}

function resolveSkillDir(hostHomeDir: string, skillName: string): string | undefined {
  const candidates = [
    path.join(hostHomeDir, '.codex', 'skills', skillName),
    path.join(hostHomeDir, '.agents', 'skills', skillName),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
}

function commandExists(command: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidateDir = dir.trim();
    if (!candidateDir) {
      continue;
    }
    const candidate = path.join(candidateDir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function runCommand(command: string, args: string[]): void {
  execFileSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });
}
