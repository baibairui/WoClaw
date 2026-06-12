import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { WorkspacePublisher } from '../src/services/workspace-publisher.js';

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('WorkspacePublisher', () => {
  it('runs the publish workspace npm script', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const publisher = new WorkspacePublisher({ cwd: '/tmp/gateway' });

    const promise = publisher.publish();
    child.stdout.write('publish ok\n');
    child.emit('close', 0);
    await flushEvents();

    await expect(promise).resolves.toEqual({ output: 'publish ok' });
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(?:\.cmd)?$/),
      ['run', 'publish:workspace'],
      expect.objectContaining({
        cwd: '/tmp/gateway',
      }),
    );
  });

  it('does not expose a repairUsers helper anymore', () => {
    const publisher = new WorkspacePublisher();
    expect('repairUsers' in publisher).toBe(false);
  });
});
