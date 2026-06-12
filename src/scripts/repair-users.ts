import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceManager } from '../services/agent-workspace-manager.js';
import { configureManagedGlobalSkillRoots } from '../services/gateway-browser-skill.js';
import { resolveGatewayRunnerHomeDirs, resolveManagedGlobalSkillRoots } from '../services/managed-global-skill-roots.js';
import { runStartupWorkspaceRepair } from '../services/workspace-repair.js';

interface RepairStats {
  users: number;
  workspaces: number;
  syncedWorkspaceDirs: number;
  movedLegacyWorkspaceDirs: number;
  workspaceDirConflicts: number;
}

function resolveAgentsDir(): string {
  const configured = process.env.CODEX_AGENTS_DIR?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  }
  return path.resolve(process.cwd(), '.data', 'agents');
}

function run(): void {
  const agentsDir = resolveAgentsDir();
  const gatewayRootDir = process.env.GATEWAY_ROOT_DIR?.trim()
    ? path.resolve(process.env.GATEWAY_ROOT_DIR.trim())
    : process.cwd();
  const dataDir = path.join(gatewayRootDir, '.data');
  const runnerHomeDirs = resolveGatewayRunnerHomeDirs(dataDir);
  const managedGlobalSkillRoots = resolveManagedGlobalSkillRoots(runnerHomeDirs);
  fs.mkdirSync(agentsDir, { recursive: true });
  configureManagedGlobalSkillRoots(managedGlobalSkillRoots);
  const workspaceManager = new AgentWorkspaceManager(agentsDir);
  const stats: RepairStats = runStartupWorkspaceRepair({
    agentsDir,
    cwd: process.cwd(),
    gatewayRootDir,
    managedGlobalSkillRoots,
    workspaceManager,
  });

  process.stdout.write(
    `repair:users done (agentsDir=${agentsDir}, users=${stats.users}, workspaces=${stats.workspaces}, syncedWorkspaceDirs=${stats.syncedWorkspaceDirs}, movedLegacyWorkspaceDirs=${stats.movedLegacyWorkspaceDirs}, workspaceDirConflicts=${stats.workspaceDirConflicts})\n`,
  );
}

run();
