import path from 'node:path';

import { runnerHomeDirName, type CliProvider } from './cli-provider.js';

const CLI_PROVIDERS: CliProvider[] = ['codex', 'opencode'];

export function resolveManagedGlobalSkillRoots(cliHomeDirs: string[]): string[] {
  const roots: string[] = [];

  for (const cliHomeDir of cliHomeDirs) {
    const trimmed = cliHomeDir.trim();
    if (!trimmed) {
      continue;
    }
    const resolvedHome = path.resolve(trimmed);
    roots.push(path.join(resolvedHome, '.codex', 'skills'));
  }

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

export function resolveGatewayRunnerHomeDirs(dataDir: string): string[] {
  const resolvedDataDir = path.resolve(dataDir);
  return CLI_PROVIDERS.map((provider) => path.join(resolvedDataDir, runnerHomeDirName(provider)));
}
