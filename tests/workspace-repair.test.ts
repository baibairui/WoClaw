import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import * as workspaceRepair from '../src/services/workspace-repair.js';

const {
  listRepairableWorkspaceDirs,
  resolveRepairSessionsDbPath,
} = workspaceRepair;

describe('workspace-repair helpers', () => {
  it('includes agents, internal workspaces, and legacy top-level workspaces in repair scan', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-repair-user-'));
    const agentDir = path.join(userDir, 'agents', 'assistant');
    const internalDir = path.join(userDir, 'internal', 'memory-steward');
    const legacyDir = path.join(userDir, 'frontend-pair');
    const ignoredLegacyDir = path.join(userDir, '_legacy');

    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(internalDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(ignoredLegacyDir, { recursive: true });

    const dirs = listRepairableWorkspaceDirs(userDir);

    expect(dirs).toContain(path.resolve(agentDir));
    expect(dirs).toContain(path.resolve(internalDir));
    expect(dirs).toContain(path.resolve(legacyDir));
    expect(dirs).not.toContain(path.resolve(ignoredLegacyDir));
  });

  it('prefers the gateway data directory for repair sessions db when available', () => {
    const cwd = '/tmp/repair-cwd';
    const agentsDir = '/custom/location/agents';

    const filePath = resolveRepairSessionsDbPath({
      agentsDir,
      cwd,
      gatewayRootDir: '/srv/gateway',
    });

    expect(filePath).toBe(path.resolve('/srv/gateway/.data/sessions.db'));
  });

  it('falls back to the agents sibling data dir for repair sessions db', () => {
    const cwd = '/tmp/repair-cwd';
    const agentsDir = '/srv/gateway/.data/agents';

    const filePath = resolveRepairSessionsDbPath({
      agentsDir,
      cwd,
    });

    expect(filePath).toBe(path.resolve('/srv/gateway/.data/sessions.db'));
  });

  it('exports a startup repair orchestrator that repairs root and user workspaces in one pass', () => {
    const runStartupWorkspaceRepair = (workspaceRepair as {
      runStartupWorkspaceRepair?: (input: {
        agentsDir: string;
        cwd: string;
        managedGlobalSkillRoots: string[];
        syncManagedGlobalSkills: (input?: { roots?: string[] }) => void;
        syncManagedGlobalDesktopSkills: (input?: { roots?: string[] }) => void;
        workspaceManager: {
          repairWorkspaceScaffold: (workspaceDir: string) => void;
          repairUserSharedMemoryTree: (userDir: string) => void;
        };
        syncSessionWorkspaceDirs: (dbPath: string) => { synced: number; moved: number; conflicts: number };
      }) => {
        users: number;
        workspaces: number;
        syncedWorkspaceDirs: number;
        movedLegacyWorkspaceDirs: number;
        workspaceDirConflicts: number;
      };
    }).runStartupWorkspaceRepair;

    expect(runStartupWorkspaceRepair).toBeTypeOf('function');

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-repair-startup-'));
    const agentsDir = path.join(rootDir, 'agents');
    const managedGlobalSkillRoots = [
      path.join(rootDir, 'codex-home', '.codex', 'skills'),
      path.join(rootDir, 'codex-home', '.agents', 'skills'),
      path.join(rootDir, 'opencode-home', '.codex', 'skills'),
      path.join(rootDir, 'opencode-home', '.agents', 'skills'),
    ];
    const userDir = path.join(agentsDir, 'users', 'u1');
    const agentWorkspaceDir = path.join(userDir, 'agents', 'assistant');
    const internalWorkspaceDir = path.join(userDir, 'internal', 'memory-steward');
    fs.mkdirSync(agentWorkspaceDir, { recursive: true });
    fs.mkdirSync(internalWorkspaceDir, { recursive: true });

    const calls: string[] = [];
    const result = runStartupWorkspaceRepair!({
      agentsDir,
      cwd: agentsDir,
      managedGlobalSkillRoots,
      syncManagedGlobalSkills: (input) => {
        calls.push(`syncManagedGlobalSkills:${JSON.stringify(input?.roots ?? [])}`);
      },
      syncManagedGlobalDesktopSkills: (input) => {
        calls.push(`syncManagedGlobalDesktopSkills:${JSON.stringify(input?.roots ?? [])}`);
      },
      workspaceManager: {
        repairWorkspaceScaffold: (workspaceDir: string) => {
          calls.push(`repairWorkspaceScaffold:${path.resolve(workspaceDir)}`);
        },
        repairUserSharedMemoryTree: (repairUserDir: string) => {
          calls.push(`repairUserSharedMemoryTree:${path.resolve(repairUserDir)}`);
        },
      },
      syncSessionWorkspaceDirs: (dbPath: string) => {
        calls.push(`syncSessionWorkspaceDirs:${path.resolve(dbPath)}`);
        return { synced: 3, moved: 1, conflicts: 0 };
      },
    });

    expect(calls).toEqual([
      `syncManagedGlobalSkills:${JSON.stringify(managedGlobalSkillRoots)}`,
      `syncManagedGlobalDesktopSkills:${JSON.stringify(managedGlobalSkillRoots)}`,
      `repairWorkspaceScaffold:${path.resolve(agentsDir)}`,
      `repairUserSharedMemoryTree:${path.resolve(userDir)}`,
      `repairWorkspaceScaffold:${path.resolve(agentWorkspaceDir)}`,
      `repairWorkspaceScaffold:${path.resolve(internalWorkspaceDir)}`,
      `syncSessionWorkspaceDirs:${path.resolve(rootDir, 'sessions.db')}`,
    ]);
    expect(result).toMatchObject({
      users: 1,
      workspaces: 2,
      syncedWorkspaceDirs: 3,
      movedLegacyWorkspaceDirs: 1,
      workspaceDirConflicts: 0,
    });
  });

  it('exports a session workspace migration helper that canonicalizes agent workspace paths', () => {
    const syncSessionWorkspaceDirs = (workspaceRepair as {
      syncSessionWorkspaceDirs?: (dbPath: string) => { synced: number; moved: number; conflicts: number };
    }).syncSessionWorkspaceDirs;

    expect(syncSessionWorkspaceDirs).toBeTypeOf('function');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-repair-db-'));
    const dbPath = path.join(tempRoot, 'sessions.db');
    const userDir = path.join(tempRoot, 'users', 'u1');
    const legacyWorkspaceDir = path.join(userDir, 'frontend');
    const canonicalWorkspaceDir = path.join(userDir, 'agents', 'assistant');

    fs.mkdirSync(legacyWorkspaceDir, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspaceDir, 'AGENTS.md'), '# legacy\n', 'utf8');

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE user_agent (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO user_agent (user_id, agent_id, workspace_dir, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('u1', 'assistant', legacyWorkspaceDir, Date.now());

    const stats = syncSessionWorkspaceDirs!(dbPath);
    const row = db.prepare('SELECT workspace_dir AS workspaceDir FROM user_agent').get() as { workspaceDir: string };

    expect(stats).toEqual({ synced: 1, moved: 1, conflicts: 0 });
    expect(row.workspaceDir).toBe(path.resolve(canonicalWorkspaceDir));
    expect(fs.existsSync(canonicalWorkspaceDir)).toBe(true);
    expect(fs.existsSync(legacyWorkspaceDir)).toBe(false);
  });
});
