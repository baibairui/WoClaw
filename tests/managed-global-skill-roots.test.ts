import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveManagedGlobalSkillRoots } from '../src/services/managed-global-skill-roots.js';

describe('resolveManagedGlobalSkillRoots', () => {
  it('returns only the canonical Codex global skill root for each runner home', () => {
    const rootA = '/tmp/codex-runner-home';
    const rootB = '/tmp/opencode-runner-home';

    expect(resolveManagedGlobalSkillRoots([rootA, rootB])).toEqual([
      path.resolve(rootA, '.codex', 'skills'),
      path.resolve(rootB, '.codex', 'skills'),
    ]);
  });
});
