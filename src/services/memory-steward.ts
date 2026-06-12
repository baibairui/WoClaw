import path from 'node:path';

import type { AgentListItem } from '../stores/session-store.js';
import type { SystemMemoryStewardWorkspaceRecord } from './agent-workspace-manager.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MemorySteward');

interface SessionStoreLike {
  listKnownUsers(): string[];
  listAgents(userId: string): AgentListItem[];
}

interface AgentWorkspaceManagerLike {
  ensureSystemMemoryStewardWorkspace(userId: string): SystemMemoryStewardWorkspaceRecord;
}

interface CodexRunnerLike {
  runForSystem?(input: {
    prompt: string;
    model?: string;
    search?: boolean;
    workdir?: string;
  }): Promise<{ threadId: string; rawOutput: string }>;
  run?(input: {
    prompt: string;
    model?: string;
    search?: boolean;
    workdir?: string;
  }): Promise<{ threadId: string; rawOutput: string }>;
}

interface MemoryStewardOptions {
  sessionStore: SessionStoreLike;
  agentWorkspaceManager: AgentWorkspaceManagerLike;
  codexRunner: CodexRunnerLike;
  intervalMs: number;
  enabled: boolean;
  model?: string;
}

export class MemorySteward {
  private readonly sessionStore: SessionStoreLike;
  private readonly agentWorkspaceManager: AgentWorkspaceManagerLike;
  private readonly codexRunner: CodexRunnerLike;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly model?: string;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(options: MemoryStewardOptions) {
    this.sessionStore = options.sessionStore;
    this.agentWorkspaceManager = options.agentWorkspaceManager;
    this.codexRunner = options.codexRunner;
    this.intervalMs = options.intervalMs;
    this.enabled = options.enabled;
    this.model = options.model;
  }

  start(): void {
    if (!this.enabled) {
      log.info('MemorySteward 已禁用，跳过启动');
      return;
    }
    if (this.timer) {
      return;
    }

    log.info('MemorySteward 已启动', {
      intervalMs: this.intervalMs,
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

  async runCycle(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.running) {
      log.warn('MemorySteward 上一轮尚未结束，跳过本轮');
      return;
    }

    this.running = true;
    try {
      const users = this.sessionStore.listKnownUsers();
      if (users.length === 0) {
        log.debug('MemorySteward 未发现已知用户');
        return;
      }

      for (const userId of users) {
        await this.runForUser(userId);
      }
    } finally {
      this.running = false;
    }
  }

  private async runForUser(userId: string): Promise<void> {
    const agents = this.sessionStore.listAgents(userId).filter((item) => !item.isDefault);
    if (agents.length === 0) {
      log.debug('MemorySteward 当前用户无自定义 agent，跳过', { userId });
      return;
    }

    const workspace = this.agentWorkspaceManager.ensureSystemMemoryStewardWorkspace(userId);
    const prompt = buildStewardPrompt(userId, workspace, agents);

    log.info('MemorySteward 开始整理用户记忆', {
      userId,
      agentCount: agents.length,
      workspaceDir: workspace.workspaceDir,
    });

    try {
      const runForSystem = this.codexRunner.runForSystem?.bind(this.codexRunner)
        ?? this.codexRunner.run?.bind(this.codexRunner);
      if (!runForSystem) {
        throw new TypeError('codexRunner requires runForSystem or run');
      }
      await runForSystem({
        prompt,
        model: this.model,
        search: false,
        workdir: workspace.workspaceDir,
      });
      log.info('MemorySteward 完成用户记忆整理', { userId });
    } catch (error) {
      log.error('MemorySteward 运行失败', {
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}

function buildStewardPrompt(
  userId: string,
  workspace: SystemMemoryStewardWorkspaceRecord,
  agents: AgentListItem[],
): string {
  const agentLines = agents.map((agent, index) => (
    `${index + 1}. ${agent.name} (${agent.agentId})\n` +
    `   workspace: ${agent.workspaceDir}\n` +
    `   soul: ${path.join(agent.workspaceDir, 'SOUL.md')}\n` +
    `   daily: ${path.join(agent.workspaceDir, 'memory', 'daily')}`
  ));

  return [
    `你正在为用户 ${userId} 执行系统级身份整理任务。`,
    '',
    '目标：',
    '- 检查用户身份文件与各 agent 的身份文件、短期记忆目录。',
    '- 只把跨会话稳定、未来还值得再读的信息整理进 user.md。',
    '- 短期或不确定信息保留在各 agent 的 daily 目录。',
    '- 高敏感信息不要直接写入长期身份，改为记录到 steward-log.md，等待用户确认。',
    '',
    `user identity: ${workspace.userIdentityPath}`,
    `runtime root: ${workspace.userDir}`,
    '',
    '当前用户的可见 agent 工作区：',
    ...agentLines,
    '',
    '执行要求：',
    '- 先阅读 user.md 现有内容，避免重复和同义改写。',
    '- 再检查各 agent 的 `SOUL.md` 与 `memory/daily/`。',
    '- 只更新 user.md；若发现某个 agent 身份漂移，在 steward-log.md 记录建议，不要默认重写对方 SOUL.md。',
    '- 在当前工作区写入或追加 `steward-log.md`，记录本轮新增、跳过和待确认项。',
    '- 不要输出给用户的解释性长文，直接修改文件即可。',
  ].join('\n');
}
