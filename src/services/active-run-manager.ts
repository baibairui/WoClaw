type Channel = 'wecom' | 'feishu' | 'weixin';
export type ActiveRunStatus = 'running' | 'stopping' | 'stopped' | 'stop_failed' | 'completed';

export interface ActiveRunRecord {
  runId: string;
  channel: Channel;
  userId: string;
  agentId: string;
  status: ActiveRunStatus;
  startedAt: number;
  lastActivityAt: number;
  provider?: 'codex' | 'opencode';
  messageId?: string;
  threadId?: string;
  stop: (reason: string) => Promise<void> | void;
}

export class ActiveRunManager {
  private readonly runs = new Map<string, ActiveRunRecord>();

  register(record: ActiveRunRecord): void {
    this.runs.set(record.runId, record);
  }

  get(runId: string): ActiveRunRecord | undefined {
    return this.runs.get(runId);
  }

  update(runId: string, patch: Partial<Omit<ActiveRunRecord, 'runId' | 'channel' | 'userId' | 'agentId' | 'stop'>>): ActiveRunRecord | undefined {
    const existing = this.runs.get(runId);
    if (!existing) {
      return undefined;
    }
    const next = { ...existing, ...patch };
    this.runs.set(runId, next);
    return next;
  }

  delete(runId: string): boolean {
    return this.runs.delete(runId);
  }

  async stopRun(input: { runId: string; channel: Channel; userId: string }): Promise<'stopped'> {
    const run = this.runs.get(input.runId);
    if (!run || run.channel !== input.channel || run.userId !== input.userId) {
      throw new Error('run not found');
    }
    this.runs.set(input.runId, {
      ...run,
      status: 'stopping',
      lastActivityAt: Date.now(),
    });
    try {
      await run.stop('user_stop');
    } catch (error) {
      // The run may have been removed while stopping; only mark stop_failed if it still exists.
      const stillPresent = this.runs.get(input.runId);
      if (stillPresent) {
        this.runs.set(input.runId, {
          ...stillPresent,
          status: 'stop_failed',
          lastActivityAt: Date.now(),
        });
      }
      throw error;
    }
    const refreshed = this.runs.get(input.runId);
    if (refreshed) {
      this.runs.set(input.runId, {
        ...refreshed,
        status: 'stopped',
        lastActivityAt: Date.now(),
      });
    }
    return 'stopped';
  }
}
