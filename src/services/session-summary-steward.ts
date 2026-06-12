import { createLogger } from '../utils/logger.js';
import type { SessionSummaryCandidate } from '../stores/session-store.js';

const log = createLogger('SessionSummarySteward');

interface SessionStoreLike {
  listSummaryCandidates(input?: {
    now?: number;
    quietWindowMs?: number;
    limit?: number;
  }): SessionSummaryCandidate[];
  updateSessionSummary(
    threadId: string,
    input: {
      summary: string;
      source?: 'llm' | 'seed' | 'manual';
      state?: 'stable' | 'dirty' | 'pending_init' | 'manual_locked';
      timestamp?: number;
    },
  ): void;
  markSummaryRefreshFailed(threadId: string, retryAt?: number): void;
}

interface CodexRunnerLike {
  runForSystem(input: {
    prompt: string;
    model?: string;
    search?: boolean;
    workdir?: string;
  }): Promise<{ threadId: string; rawOutput: string }>;
}

interface SessionSummaryStewardOptions {
  sessionStore: SessionStoreLike;
  codexRunner: CodexRunnerLike;
  intervalMs: number;
  enabled: boolean;
  model?: string;
  quietWindowMs?: number;
  limitPerCycle?: number;
}

export class SessionSummarySteward {
  private readonly sessionStore: SessionStoreLike;
  private readonly codexRunner: CodexRunnerLike;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly model?: string;
  private readonly quietWindowMs: number;
  private readonly limitPerCycle: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(options: SessionSummaryStewardOptions) {
    this.sessionStore = options.sessionStore;
    this.codexRunner = options.codexRunner;
    this.intervalMs = options.intervalMs;
    this.enabled = options.enabled;
    this.model = options.model;
    this.quietWindowMs = options.quietWindowMs ?? 60_000;
    this.limitPerCycle = options.limitPerCycle ?? 20;
  }

  start(): void {
    if (!this.enabled) {
      log.info('SessionSummarySteward 已禁用，跳过启动');
      return;
    }
    if (this.timer) {
      return;
    }
    log.info('SessionSummarySteward 已启动', {
      intervalMs: this.intervalMs,
      quietWindowMs: this.quietWindowMs,
      limitPerCycle: this.limitPerCycle,
      model: this.model ?? '(codex cli default)',
    });
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runCycle(now = Date.now()): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.running) {
      log.warn('SessionSummarySteward 上一轮尚未结束，跳过本轮');
      return;
    }
    this.running = true;
    try {
      const candidates = this.sessionStore.listSummaryCandidates({
        now,
        quietWindowMs: this.quietWindowMs,
        limit: this.limitPerCycle,
      });
      for (const candidate of candidates) {
        await this.runForCandidate(candidate, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async runForCandidate(candidate: SessionSummaryCandidate, now: number): Promise<void> {
    try {
      const result = await this.codexRunner.runForSystem({
        prompt: buildSummaryPrompt(candidate),
        model: this.model,
        search: false,
      });
      const summary = normalizeSummary(result.rawOutput);
      if (!summary) {
        this.sessionStore.markSummaryRefreshFailed(candidate.threadId, now + 10 * 60_000);
        return;
      }
      this.sessionStore.updateSessionSummary(candidate.threadId, {
        summary,
        source: 'llm',
        state: 'stable',
        timestamp: now,
      });
    } catch (error) {
      log.error('SessionSummarySteward 生成摘要失败', {
        threadId: candidate.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sessionStore.markSummaryRefreshFailed(candidate.threadId, now + 10 * 60_000);
    }
  }
}

function buildSummaryPrompt(candidate: SessionSummaryCandidate): string {
  return [
    '请把这个 session 当前主要话题总结成一句不超过 18 个字的中文短语。',
    '要求：',
    '1. 像会话标题，不要像完整句子。',
    '2. 不要出现“用户在问”“正在讨论”这类表述。',
    '3. 只输出标题本身。',
    '',
    `最近摘要：${candidate.summary ?? '(无)'}`,
    `最近用户输入：${candidate.lastPrompt ?? '(无)'}`,
    `新增用户轮次：${candidate.userTurnsSinceSummary}`,
    `新增字符数：${candidate.charsSinceSummary}`,
  ].join('\n');
}

function normalizeSummary(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= 18 ? normalized : `${normalized.slice(0, 18).trimEnd()}…`;
}
