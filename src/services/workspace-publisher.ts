import { spawn } from 'node:child_process';

export interface WorkspacePublisherOptions {
  cwd?: string;
  timeoutMs?: number;
}

export class WorkspacePublisher {
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(options: WorkspacePublisherOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  publish(): Promise<{ output: string }> {
    return this.runScript('publish:workspace');
  }

  private runScript(scriptName: string): Promise<{ output: string }> {
    return new Promise((resolve, reject) => {
      const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npmCommand, ['run', scriptName], {
        cwd: this.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      const append = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        if (output.length > 8000) {
          output = output.slice(-8000);
        }
      };

      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, this.timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ output: output.trim() });
          return;
        }
        reject(new Error(`${scriptName} exited with code ${code}\n${output.trim()}`));
      });
    });
  }
}
