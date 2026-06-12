import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { syncManagedGlobalSkills } from './gateway-browser-skill.js';
import { syncManagedGlobalDesktopSkills } from './gateway-desktop-skill.js';

interface WorkspaceRepairManagerLike {
  repairWorkspaceScaffold(workspaceDir: string): void;
  repairUserSharedMemoryTree(userDir: string): void;
}

export interface StartupWorkspaceRepairStats {
  users: number;
  workspaces: number;
  syncedWorkspaceDirs: number;
  movedLegacyWorkspaceDirs: number;
  workspaceDirConflicts: number;
}

export function listRepairableWorkspaceDirs(userDir: string): string[] {
  const output: string[] = [];

  for (const containerName of ['agents', 'internal'] as const) {
    const containerDir = path.join(userDir, containerName);
    if (!fs.existsSync(containerDir) || !fs.statSync(containerDir).isDirectory()) {
      continue;
    }
    for (const workspaceName of fs.readdirSync(containerDir)) {
      const workspaceDir = path.join(containerDir, workspaceName);
      if (fs.statSync(workspaceDir).isDirectory()) {
        output.push(workspaceDir);
      }
    }
  }

  for (const workspaceName of fs.readdirSync(userDir)) {
    if (workspaceName === 'agents' || workspaceName === 'internal' || workspaceName === 'shared-memory' || workspaceName === '_memory-steward' || workspaceName === '_legacy') {
      continue;
    }
    const workspaceDir = path.join(userDir, workspaceName);
    if (!fs.statSync(workspaceDir).isDirectory()) {
      continue;
    }
    output.push(workspaceDir);
  }

  return Array.from(new Set(output.map((dir) => path.resolve(dir))));
}

export function resolveRepairSessionsDbPath(input: {
  agentsDir: string;
  cwd: string;
  gatewayRootDir?: string;
}): string {
  const gatewayRootDir = input.gatewayRootDir?.trim();
  if (gatewayRootDir) {
    return path.resolve(gatewayRootDir, '.data', 'sessions.db');
  }

  const resolvedAgentsDir = path.resolve(input.agentsDir);
  const parentDir = path.dirname(resolvedAgentsDir);
  if (path.basename(resolvedAgentsDir) === 'agents') {
    return path.resolve(parentDir, 'sessions.db');
  }

  return path.resolve(input.cwd, '.data', 'sessions.db');
}

export function runStartupWorkspaceRepair(input: {
  agentsDir: string;
  cwd: string;
  gatewayRootDir?: string;
  managedGlobalSkillRoots?: string[];
  workspaceManager: WorkspaceRepairManagerLike;
  syncManagedGlobalSkills?: (input?: { roots?: string[] }) => void;
  syncManagedGlobalDesktopSkills?: (input?: { roots?: string[] }) => void;
  syncSessionWorkspaceDirs?: (dbPath: string) => { synced: number; moved: number; conflicts: number };
}): StartupWorkspaceRepairStats {
  const agentsDir = path.resolve(input.agentsDir);
  fs.mkdirSync(agentsDir, { recursive: true });

  const managedSkillSyncInput = input.managedGlobalSkillRoots?.length
    ? { roots: input.managedGlobalSkillRoots }
    : undefined;

  (input.syncManagedGlobalSkills ?? syncManagedGlobalSkills)(managedSkillSyncInput);
  (input.syncManagedGlobalDesktopSkills ?? syncManagedGlobalDesktopSkills)(managedSkillSyncInput);

  input.workspaceManager.repairWorkspaceScaffold(agentsDir);

  let users = 0;
  let workspaces = 0;
  const usersDir = path.join(agentsDir, 'users');
  if (fs.existsSync(usersDir) && fs.statSync(usersDir).isDirectory()) {
    for (const userDirName of fs.readdirSync(usersDir)) {
      const userDir = path.join(usersDir, userDirName);
      if (!fs.statSync(userDir).isDirectory()) {
        continue;
      }

      users += 1;
      input.workspaceManager.repairUserSharedMemoryTree(userDir);

      for (const workspaceDir of listRepairableWorkspaceDirs(userDir)) {
        input.workspaceManager.repairWorkspaceScaffold(workspaceDir);
        workspaces += 1;
      }
    }
  }

  const syncStats = (input.syncSessionWorkspaceDirs ?? syncSessionWorkspaceDirs)(
    resolveRepairSessionsDbPath({
      agentsDir,
      cwd: input.cwd,
      gatewayRootDir: input.gatewayRootDir,
    }),
  );

  return {
    users,
    workspaces,
    syncedWorkspaceDirs: syncStats.synced,
    movedLegacyWorkspaceDirs: syncStats.moved,
    workspaceDirConflicts: syncStats.conflicts,
  };
}

export function syncSessionWorkspaceDirs(dbPath: string): {
  synced: number;
  moved: number;
  conflicts: number;
} {
  if (!fs.existsSync(dbPath)) {
    return { synced: 0, moved: 0, conflicts: 0 };
  }

  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare('SELECT user_id AS userId, agent_id AS agentId, workspace_dir AS workspaceDir FROM user_agent')
      .all() as Array<{ userId: string; agentId: string; workspaceDir: string }>;
    const updateStmt = db.prepare(`
      UPDATE user_agent
      SET workspace_dir = ?, updated_at = ?
      WHERE user_id = ? AND agent_id = ?
    `);

    let synced = 0;
    let moved = 0;
    let conflicts = 0;
    const now = Date.now();

    for (const row of rows) {
      const currentDir = path.resolve(row.workspaceDir);
      const targetDir = resolveCanonicalWorkspaceDir(currentDir, row.agentId);
      if (currentDir === targetDir) {
        continue;
      }

      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      const currentExists = fs.existsSync(currentDir);
      const targetExists = fs.existsSync(targetDir);

      if (currentExists && !targetExists) {
        fs.renameSync(currentDir, targetDir);
        moved += 1;
      } else if (currentExists && targetExists) {
        conflicts += 1;
        continue;
      }

      if (fs.existsSync(targetDir)) {
        updateStmt.run(targetDir, now, row.userId, row.agentId);
        synced += 1;
      }
    }

    return { synced, moved, conflicts };
  } finally {
    db.close();
  }
}

function resolveUserDirFromWorkspace(workspaceDir: string): string {
  const normalized = path.resolve(workspaceDir);
  const parent = path.dirname(normalized);
  const parentBase = path.basename(parent);
  if (parentBase === 'agents' || parentBase === 'internal') {
    return path.dirname(parent);
  }
  return parent;
}

function resolveCanonicalWorkspaceDir(workspaceDir: string, agentId: string): string {
  return path.join(resolveUserDirFromWorkspace(workspaceDir), 'agents', agentId);
}
