import fs from 'node:fs';
import path from 'node:path';

import { defaultGlobalSkillRoots } from './gateway-browser-skill.js';

export interface SkillCatalogEntry {
  name: string;
  description?: string;
  source: 'global' | 'agent-local';
  skillDir: string;
}

export function listSkillsForAgentWorkspace(workspaceDir: string): SkillCatalogEntry[] {
  const result: SkillCatalogEntry[] = [];
  for (const root of defaultGlobalSkillRoots()) {
    result.push(...listSkillsInRoot(root, 'global'));
  }
  result.push(...listSkillsInRoot(path.join(workspaceDir, '.codex', 'skills'), 'agent-local'));
  result.push(...listSkillsInRoot(path.join(workspaceDir, '.agents', 'skills'), 'agent-local'));
  return dedupeSkillEntries(result);
}

function listSkillsInRoot(rootDir: string, source: SkillCatalogEntry['source']): SkillCatalogEntry[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const output: SkillCatalogEntry[] = [];
  for (const dirName of fs.readdirSync(rootDir)) {
    const skillDir = path.join(rootDir, dirName);
    if (!fs.statSync(skillDir).isDirectory()) {
      continue;
    }
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      continue;
    }
    const parsed = parseSkillMetadata(fs.readFileSync(skillFile, 'utf8'));
    output.push({
      name: parsed.name || dirName,
      description: parsed.description,
      source,
      skillDir,
    });
  }
  return output;
}

function parseSkillMetadata(content: string): { name?: string; description?: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return {};
  }
  const lines = trimmed.split('\n');
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '---') {
      break;
    }
    if (line.startsWith('name:')) {
      name = line.slice('name:'.length).trim();
      continue;
    }
    if (line.startsWith('description:')) {
      description = line.slice('description:'.length).trim();
    }
  }
  return { name, description };
}

function dedupeSkillEntries(entries: SkillCatalogEntry[]): SkillCatalogEntry[] {
  const output: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  const sorted = [...entries].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === 'agent-local' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    // 同名 skill 只保留一个：按排序优先级，agent-local 覆盖 global。
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }
  return output;
}
