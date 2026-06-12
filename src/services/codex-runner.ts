import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { buildCodexSpawnSpec, type CodexWorkdirIsolationMode, type SkillRuntimePolicy } from './codex-bwrap.js';
import { getCliProviderSpec, isExecutableAvailable, resolveCodexBin, resolveOpenCodeBin, type CliProvider } from './cli-provider.js';
import { CodexAppServerClient, type CodexServerRequestHandler, type CodexThreadConfig, type CodexThreadGoal, type CodexTurnCompletion, type CodexTurnInputItem } from './codex-app-server-client.js';

const log = createLogger('CodexRunner');
const execFileAsync = promisify(execFile);

export interface BrowserAutomationRuntimeConfig {
  apiBaseUrl: string;
  internalApiToken: string;
}

export interface CodexRunInput {
  prompt: string;
  threadId?: string;
  model?: string;
  search?: boolean;
  workdir?: string;
  gatewayUserId?: string;
  reminderToolContext?: {
    dbPath: string;
    channel: 'wecom' | 'feishu' | 'weixin';
    userId: string;
    agentId: string;
  };
  /** 每产出一条 agent_message 就回调一次 */
  onMessage?: (text: string) => void;
  /** 一旦收到 thread.started 就立刻回调，便于上层先持久化新会话 */
  onThreadStarted?: (threadId: string) => void;
  gatewayPublicBaseUrl?: string;
  skillPolicy?: SkillRuntimePolicy;
}

export interface CodexRunResult {
  threadId: string;
  rawOutput: string;
}

export interface ControlledCodexRun {
  result: Promise<CodexRunResult>;
  stop: (reason: string) => Promise<boolean>;
}

export interface CodexReviewInput {
  mode: 'uncommitted' | 'base' | 'commit';
  target?: string;
  prompt?: string;
  model?: string;
  search?: boolean;
  workdir?: string;
  onMessage?: (text: string) => void;
  skillPolicy?: SkillRuntimePolicy;
}

export interface CodexLoginInput {
  onMessage?: (text: string) => void;
}

export interface ParsedCodexOutput {
  threadId?: string;
  answer: string;
}

interface CodexRunnerOptions {
  provider?: CliProvider;
  codexBin?: string;
  workdir?: string;
  timeoutMs?: number;
  timeoutMinMs?: number;
  timeoutMaxMs?: number;
  timeoutPerCharMs?: number;
  browserApiBaseUrl?: string;
  internalApiBaseUrl?: string;
  internalApiToken?: string;
  gatewayRootDir?: string;
  gatewayPublicBaseUrl?: string;
  /** 'full-auto' (沙箱) 或 'none' (无沙箱) */
  sandbox?: 'full-auto' | 'none';
  codexHomeDir?: string;
  codexRunTransport?: 'cli' | 'app-server';
  workdirIsolation?: CodexWorkdirIsolationMode;
  nativeToolHandler?: CodexServerRequestHandler;
}

const DEFAULT_TIMEOUT_MIN_MS = 180_000;
const DEFAULT_TIMEOUT_MAX_MS = 900_000;
const DEFAULT_TIMEOUT_PER_CHAR_MS = 80;

export function resolveServiceWorkdirIsolation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | string = process.platform,
): CodexWorkdirIsolationMode {
  const raw = env.CODEX_WORKDIR_ISOLATION?.trim().toLowerCase();
  if (!raw) {
    return platform === 'linux' ? 'bwrap' : 'off';
  }
  if (raw === 'off' || raw === 'none' || raw === 'false') {
    return 'off';
  }
  if (raw === 'bwrap') {
    return 'bwrap';
  }
  throw new Error(`invalid CODEX_WORKDIR_ISOLATION: ${raw}`);
}

export function parseCodexJsonl(raw: string): ParsedCodexOutput {
  let threadId: string | undefined;
  let answer = '';

  for (const event of iterateCodexEvents(raw)) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
    }

    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        answer = item.text;
      }
    }
  }

  return {
    threadId,
    answer: answer || '（Codex 未返回可解析内容）',
  };
}

function* iterateCodexEvents(raw: string): Generator<Record<string, unknown>> {
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
}

export class CodexRunner {
  private readonly codexBin: string;
  private readonly provider: CliProvider;
  private readonly workdir: string;
  private readonly timeoutMs?: number;
  private readonly timeoutMinMs: number;
  private readonly timeoutMaxMs: number;
  private readonly timeoutPerCharMs: number;
  private readonly browserAutomation?: BrowserAutomationRuntimeConfig;
  private readonly internalApiToken?: string;
  private readonly internalApiBaseUrl?: string;
  private readonly gatewayRootDir?: string;
  private readonly gatewayPublicBaseUrl?: string;
  private readonly sandbox: 'full-auto' | 'none';
  private readonly codexHomeDir?: string;
  private readonly codexRunTransport: 'cli' | 'app-server';
  private readonly workdirIsolation: CodexWorkdirIsolationMode;
  private readonly nativeToolHandler?: CodexServerRequestHandler;

  constructor(options: CodexRunnerOptions = {}) {
    this.provider = options.provider ?? 'codex';
    const requestedBin = options.codexBin ?? (this.provider === 'opencode' ? 'opencode' : 'codex');
    this.codexBin = this.provider === 'opencode'
      ? resolveOpenCodeBin(requestedBin)
      : resolveCodexBin(requestedBin);
    this.workdir = options.workdir ?? process.cwd();
    this.timeoutMs = options.timeoutMs;
    this.timeoutMinMs = options.timeoutMinMs ?? DEFAULT_TIMEOUT_MIN_MS;
    this.timeoutMaxMs = options.timeoutMaxMs ?? DEFAULT_TIMEOUT_MAX_MS;
    this.timeoutPerCharMs = options.timeoutPerCharMs ?? DEFAULT_TIMEOUT_PER_CHAR_MS;
    const browserApiBaseUrl = options.browserApiBaseUrl?.trim() || undefined;
    const internalApiToken = options.internalApiToken?.trim() || undefined;
    this.browserAutomation = browserApiBaseUrl && internalApiToken
      ? {
          apiBaseUrl: browserApiBaseUrl,
          internalApiToken,
        }
      : undefined;
    this.internalApiToken = internalApiToken;
    this.internalApiBaseUrl = options.internalApiBaseUrl?.trim() || undefined;
    this.gatewayRootDir = options.gatewayRootDir?.trim() || undefined;
    this.gatewayPublicBaseUrl = options.gatewayPublicBaseUrl?.trim() || undefined;
    this.sandbox = options.sandbox ?? 'full-auto';
    this.codexHomeDir = options.codexHomeDir?.trim() || undefined;
    this.codexRunTransport = options.codexRunTransport ?? 'app-server';
    this.workdirIsolation = options.workdirIsolation ?? resolveServiceWorkdirIsolation();
    this.nativeToolHandler = options.nativeToolHandler;
    log.debug('CodexRunner 构造完成', {
      codexBin: this.codexBin,
      provider: this.provider,
      workdir: this.workdir,
      timeoutMs: this.timeoutMs ?? '(adaptive)',
      timeoutMinMs: this.timeoutMinMs,
      timeoutMaxMs: this.timeoutMaxMs,
      timeoutPerCharMs: this.timeoutPerCharMs,
      browserApiBaseUrl: this.browserAutomation?.apiBaseUrl ?? '(disabled)',
      gatewayRootDir: this.gatewayRootDir ?? '(unset)',
      gatewayPublicBaseUrl: this.gatewayPublicBaseUrl ?? '(unset)',
      sandbox: this.sandbox,
      workdirIsolation: this.workdirIsolation,
      codexHomeDir: this.codexHomeDir ?? '(system HOME)',
      codexRunTransport: this.codexRunTransport,
      nativeToolHandler: this.nativeToolHandler ? 'enabled' : 'disabled',
    });
  }

  run(input: CodexRunInput): Promise<CodexRunResult> {
    return this.runWithControl(input).result;
  }

  runForSystem(input: CodexRunInput): Promise<CodexRunResult> {
    return this.runWithControlForSystem(input).result;
  }

  runWithControl(input: CodexRunInput): ControlledCodexRun {
    const workdir = this.requireAgentWorkdir(input.workdir, 'runWithControl');
    return this.runWithResolvedWorkdir(input, workdir);
  }

  runWithControlForSystem(input: CodexRunInput): ControlledCodexRun {
    const workdir = input.workdir?.trim() || this.workdir;
    return this.runWithResolvedWorkdir(input, workdir);
  }

  private runWithResolvedWorkdir(input: CodexRunInput, workdir: string): ControlledCodexRun {
    if (this.provider === 'codex' && this.codexRunTransport === 'app-server' && !input.search) {
      return this.runWithAppServer(input, workdir);
    }

    const args = buildCodexArgs({ ...input, workdir }, this.sandbox, this.provider);
    const controlled = this.runJsonl({
      args,
      prompt: input.prompt,
      env: buildCodexChildEnv(process.env, {
        reminderToolContext: input.reminderToolContext,
        browserAutomation: this.browserAutomation,
        gatewayRootDir: this.gatewayRootDir,
        gatewayPublicBaseUrl: input.gatewayPublicBaseUrl ?? this.gatewayPublicBaseUrl,
        gatewayUserId: input.gatewayUserId,
        internalApiToken: this.internalApiToken,
        internalApiBaseUrl: this.internalApiBaseUrl,
      }),
      workdir,
      onMessage: input.onMessage,
      onThreadStarted: input.onThreadStarted,
      initialThreadId: input.threadId,
      requireThreadId: true,
      skillPolicy: input.skillPolicy,
      logMeta: {
        mode: 'exec',
        isResume: !!input.threadId,
        threadId: maskThreadId(input.threadId),
      },
    });

    return {
      result: controlled.result.then((result) => {
        if (!result.threadId) {
          throw new Error('thread id not found in codex output');
        }
        return {
          threadId: result.threadId,
          rawOutput: result.rawOutput,
        };
      }),
      stop: controlled.stop,
    };
  }

  review(input: CodexReviewInput): Promise<{ rawOutput: string }> {
    const workdir = this.requireAgentWorkdir(input.workdir, 'review');
    return this.reviewWithResolvedWorkdir(input, workdir);
  }

  reviewForSystem(input: CodexReviewInput): Promise<{ rawOutput: string }> {
    const workdir = input.workdir?.trim() || this.workdir;
    return this.reviewWithResolvedWorkdir(input, workdir);
  }

  private reviewWithResolvedWorkdir(input: CodexReviewInput, workdir: string): Promise<{ rawOutput: string }> {
    const args = buildCodexReviewArgs({ ...input, workdir }, this.sandbox, this.provider);
    const timeoutHint = input.prompt ?? input.target ?? input.mode;
    return this.runJsonl({
      args,
      prompt: timeoutHint,
      env: buildCodexChildEnv(process.env, {
        browserAutomation: this.browserAutomation,
        gatewayRootDir: this.gatewayRootDir,
        internalApiToken: this.internalApiToken,
      }),
      workdir,
      onMessage: input.onMessage,
      requireThreadId: false,
      skillPolicy: input.skillPolicy,
      logMeta: {
        mode: 'review',
        reviewMode: input.mode,
        reviewTarget: input.target ?? '(none)',
      },
    }).result.then((result) => ({ rawOutput: result.rawOutput }));
  }

  private requireAgentWorkdir(workdir: string | undefined, operation: 'runWithControl' | 'review'): string {
    const resolved = workdir?.trim();
    if (resolved) {
      return resolved;
    }
    throw new Error(`CodexRunner.${operation} requires an explicit agent workspaceDir`);
  }

  login(input: CodexLoginInput): Promise<void> {
    if (!getCliProviderSpec(this.provider).supportsDeviceAuth) {
      return Promise.reject(new Error(`${getCliProviderSpec(this.provider).label} does not support gateway device auth login`));
    }
    return new Promise((resolve, reject) => {
      const args = ['login', '--device-auth'];
      log.info('Codex 登录进程启动', { bin: this.codexBin, args });
      this.assertExecutableAvailable(process.env);

      const spawnSpec = buildCodexSpawnSpec({
        provider: this.provider,
        codexBin: this.codexBin,
        args,
        cwd: this.workdir,
        env: process.env,
        isolationMode: 'off',
        codexHomeDir: this.codexHomeDir,
      });

      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: spawnSpec.cwd,
        env: spawnSpec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 登录阶段最长等待 15 分钟
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('codex login timeout after 15 minutes'));
      }, 15 * 60 * 1000);

      let stdoutBuf = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdoutBuf += text;
        const sendText = stripAnsi(text).trim();
        if (sendText && input.onMessage) {
          input.onMessage(sendText);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        log.warn('Codex login stderr', { text: chunk.toString('utf8').substring(0, 500) });
      });

      child.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`codex login exited with code ${code}`));
          return;
        }
        resolve();
      });
    });
  }

  async listModels(): Promise<{ fetchedAt?: string; models: Array<{ slug: string; visibility: 'list' | 'hide' | string; supportedInApi: boolean }> }> {
    if (this.provider === 'opencode') {
      return this.listOpenCodeModels();
    }
    return loadCodexModelsFromHome(this.codexHomeDir);
  }

  getProvider(): CliProvider {
    return this.provider;
  }

  private runJsonl(options: {
    args: string[];
    prompt: string;
    env?: NodeJS.ProcessEnv;
    workdir?: string;
    onMessage?: (text: string) => void;
    onThreadStarted?: (threadId: string) => void;
    initialThreadId?: string;
    requireThreadId: boolean;
    skillPolicy?: SkillRuntimePolicy;
    logMeta?: Record<string, unknown>;
  }): { result: Promise<{ rawOutput: string; threadId?: string }>; stop: (reason: string) => Promise<boolean> } {
    if (this.provider === 'opencode') {
      repairLegacyOpenCodeConfig(this.codexHomeDir);
    }

    log.info('Codex 子进程启动', {
      bin: this.codexBin,
      args: redactArgsForLog(options.args),
      cwd: options.workdir ?? this.workdir,
      timeoutMode: this.timeoutMs ? 'fixed' : 'adaptive',
      ...options.logMeta,
    });

    const effectiveTimeoutMs = this.resolveTimeoutMs(options.prompt);
    log.debug('Codex 子进程超时阈值已计算', {
      promptLength: options.prompt.length,
      effectiveTimeoutMs,
    });

    let stopChild: ((reason: string) => Promise<boolean>) | undefined;

    const result = new Promise<{ rawOutput: string; threadId?: string }>((resolve, reject) => {
      this.assertExecutableAvailable(options.env ?? process.env);
      const spawnSpec = buildCodexSpawnSpec({
        provider: this.provider,
        codexBin: this.codexBin,
        args: options.args,
        cwd: options.workdir ?? this.workdir,
        env: options.env ?? process.env,
        isolationMode: this.workdirIsolation,
        codexHomeDir: this.codexHomeDir,
        skillPolicy: options.skillPolicy,
      });

      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: spawnSpec.cwd,
        env: spawnSpec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      log.debug('Codex 子进程已 spawn', { pid: child.pid });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let lineBuf = '';
      let eventCount = 0;
      let observedThreadId = options.initialThreadId;
      let stopRequested = false;

      let timer: NodeJS.Timeout | undefined;
      const refreshIdleTimeout = () => {
        if (settled) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGKILL');
          log.error('Codex 子进程空闲超时，已 SIGKILL', {
            pid: child.pid,
            timeoutMs: effectiveTimeoutMs,
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
            eventCount,
          });
          reject(new Error(`${this.provider} timeout after ${effectiveTimeoutMs}ms`));
        }, effectiveTimeoutMs);
      };
      refreshIdleTimeout();

      stopChild = async (_reason: string) => {
        if (settled || stopRequested) {
          return false;
        }
        stopRequested = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 1_000);
        return true;
      };

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        refreshIdleTimeout();

        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          handleCodexLine(
            line,
            options.onMessage,
            () => {
              eventCount++;
            },
            (threadId) => {
              observedThreadId = threadId;
              options.onThreadStarted?.(threadId);
            },
          );
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        refreshIdleTimeout();
        log.warn('Codex stderr 输出', { text: text.substring(0, 500) });
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        log.error('Codex 子进程 error 事件', error);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }

        log.info('Codex 子进程退出', {
          pid: child.pid,
          exitCode: code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          eventCount,
        });

        if (stopRequested) {
          reject(new Error(`${this.provider} stopped by user`));
          return;
        }

        if (code !== 0) {
          log.error('Codex 子进程异常退出', {
            exitCode: code,
            stderr: stderr.substring(0, 500),
            stdout: stdout.substring(0, 200),
          });
          reject(new Error(`${this.provider} exited with code ${code}: ${stderr || stdout}`));
          return;
        }

        const tail = lineBuf.trim();
        if (tail) {
          handleCodexLine(
            tail,
            options.onMessage,
            () => {
              eventCount++;
            },
            (threadId) => {
              observedThreadId = threadId;
              options.onThreadStarted?.(threadId);
            },
          );
        }

        let threadId = observedThreadId;
        if (!threadId) {
          threadId = parseProviderJsonl(this.provider, stdout).threadId;
        }
        if (options.requireThreadId && !threadId) {
          log.error('Codex 输出中未找到 threadId', {
            stdoutPreview: stdout.substring(0, 500),
          });
          reject(new Error('thread id not found in codex output'));
          return;
        }

        log.info('Codex 执行成功', {
          threadId,
          rawOutputLength: stdout.length,
        });

        resolve({
          threadId,
          rawOutput: stdout,
        });
      });
    });

    return {
      result,
      stop: async (reason: string) => {
        if (!stopChild) {
          return false;
        }
        return stopChild(reason);
      },
    };
  }

  private runWithAppServer(input: CodexRunInput, effectiveWorkdir: string): ControlledCodexRun {
    const appServerCwd = this.resolveAppServerCwd(effectiveWorkdir);
    const env = this.buildAppServerEnv({
      reminderToolContext: input.reminderToolContext,
      gatewayPublicBaseUrl: input.gatewayPublicBaseUrl ?? this.gatewayPublicBaseUrl,
      gatewayUserId: input.gatewayUserId,
    });

    const promptItems = buildCodexTurnInputItems(input.prompt);
    const effectiveTimeoutMs = this.resolveTimeoutMs(input.prompt);
    let observedThreadId = input.threadId;
    let observedTurnId: string | undefined;
    let stopRequested = false;
    let settled = false;
    let rawOutput = '';
    let timer: NodeJS.Timeout | undefined;
    const agentMessageTextById = new Map<string, string>();
    let resolveCompletion: ((value: CodexTurnCompletion) => void) | undefined;
    let rejectCompletion: ((reason: Error) => void) | undefined;

    const completionPromise = new Promise<CodexTurnCompletion>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const client = new CodexAppServerClient({
      provider: this.provider,
      codexBin: this.codexBin,
      cwd: effectiveWorkdir,
      env,
      codexHomeDir: this.codexHomeDir,
      workdirIsolation: this.workdirIsolation,
      skillPolicy: input.skillPolicy,
      onServerRequest: async (request) => {
        rawOutput += `${JSON.stringify(request)}\n`;
        refreshIdleTimeout();
        const response = await this.nativeToolHandler?.(request);
        refreshIdleTimeout();
        return response;
      },
      onNotification: (notification) => {
        rawOutput += `${JSON.stringify(notification)}\n`;
        refreshIdleTimeout();
        if (notification.method === 'thread/started') {
          const thread = notification.params?.thread as { id?: string } | undefined;
          if (typeof thread?.id === 'string') {
            observedThreadId = thread.id;
            input.onThreadStarted?.(thread.id);
          }
          return;
        }
        if (notification.method === 'turn/started') {
          const turn = notification.params?.turn as { id?: string } | undefined;
          if (typeof turn?.id === 'string') {
            observedTurnId = turn.id;
          }
          return;
        }
        if (notification.method === 'thread/goal/updated') {
          const goal = parseCodexThreadGoal(notification.params?.goal);
          input.onMessage?.(goal ? formatCodexGoalUpdatedMessage(goal) : '✅ 已更新 Codex 目标。');
          return;
        }
        if (notification.method === 'thread/goal/cleared') {
          input.onMessage?.('✅ 已清除当前 Codex 目标。');
          return;
        }
        if (notification.method === 'item/agentMessage/delta') {
          const itemId = typeof notification.params?.itemId === 'string' ? notification.params.itemId : undefined;
          const delta = typeof notification.params?.delta === 'string' ? notification.params.delta : '';
          if (itemId && delta) {
            const nextText = `${agentMessageTextById.get(itemId) ?? ''}${delta}`;
            agentMessageTextById.set(itemId, nextText);
          }
          return;
        }
        if (notification.method === 'item/completed') {
          const item = notification.params?.item as Record<string, unknown> | undefined;
          if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
            agentMessageTextById.set(item.id, item.text);
            input.onMessage?.(item.text);
          }
          return;
        }
        if (notification.method === 'turn/completed') {
          const turn = notification.params?.turn as { id?: string; status?: string } | undefined;
          resolveCompletion?.({
            turnId: typeof turn?.id === 'string' ? turn.id : observedTurnId ?? '',
            status: typeof turn?.status === 'string' ? turn.status : 'completed',
          });
        }
      },
    });

    const refreshIdleTimeout = () => {
      if (settled) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        client.close();
        rejectCompletion?.(new Error(`${this.provider} timeout after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs);
    };

    refreshIdleTimeout();

    const result = (async () => {
      try {
        await client.initialize();
        refreshIdleTimeout();

        const threadConfig = this.buildAppServerThreadConfig(input.model, effectiveWorkdir);

        if (input.threadId?.trim()) {
          const resumed = await client.resumeThread(input.threadId.trim(), threadConfig);
          observedThreadId = resumed.thread.id;
        } else {
          const started = await client.startThread(threadConfig);
          observedThreadId = started.thread.id;
          input.onThreadStarted?.(started.thread.id);
        }
        refreshIdleTimeout();

        const turnStart = await client.startTurn({
          threadId: observedThreadId ?? '',
          items: promptItems,
          cwd: appServerCwd,
          model: input.model,
        });
        observedTurnId = turnStart.turn.id;
        refreshIdleTimeout();

        const completion = await completionPromise;
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (stopRequested || completion.status === 'interrupted') {
          throw new Error(`${this.provider} stopped by user`);
        }
        if (completion.status !== 'completed') {
          throw new Error(`${this.provider} turn completed with status ${completion.status}`);
        }
        if (!observedThreadId) {
          throw new Error('thread id not found in codex app-server output');
        }
        return {
          threadId: observedThreadId,
          rawOutput,
        };
      } finally {
        client.close();
      }
    })();

    return {
      result,
      stop: async (_reason: string) => {
        if (settled || stopRequested) {
          return false;
        }
        stopRequested = true;
        if (observedThreadId && observedTurnId) {
          await client.interruptTurn(observedThreadId, observedTurnId);
        } else {
          client.close();
        }
        return true;
      },
    };
  }

  private buildAppServerThreadConfig(model: string | undefined, workdir?: string): CodexThreadConfig {
    return {
      cwd: this.resolveAppServerCwd(workdir),
      model,
      sandbox: this.sandbox === 'none' ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: 'never',
      personality: 'pragmatic',
    };
  }

  private buildAppServerEnv(input: {
    reminderToolContext?: CodexRunInput['reminderToolContext'];
    gatewayPublicBaseUrl?: string;
    gatewayUserId?: string;
  }): NodeJS.ProcessEnv {
    const env = buildCodexChildEnv(process.env, {
      reminderToolContext: input.reminderToolContext,
      gatewayRootDir: this.gatewayRootDir,
      gatewayPublicBaseUrl: input.gatewayPublicBaseUrl ?? this.gatewayPublicBaseUrl,
      gatewayUserId: input.gatewayUserId,
    });
    delete env.GATEWAY_BROWSER_API_BASE;
    delete env.GATEWAY_INTERNAL_API_BASE;
    delete env.GATEWAY_INTERNAL_API_TOKEN;
    if (this.codexHomeDir?.trim()) {
      const resolvedHome = this.codexHomeDir.trim();
      env.HOME = resolvedHome;
      env.XDG_CONFIG_HOME = `${resolvedHome}/.config`;
      env.XDG_CACHE_HOME = `${resolvedHome}/.cache`;
      env.XDG_DATA_HOME = `${resolvedHome}/.local/share`;
    }
    return env;
  }

  private resolveAppServerCwd(workdir?: string): string {
    if (this.workdirIsolation === 'bwrap') {
      return '/workspace';
    }
    return workdir?.trim() || this.workdir;
  }

  private assertExecutableAvailable(env: NodeJS.ProcessEnv): void {
    if (isExecutableAvailable(this.codexBin, env.PATH)) {
      return;
    }
    const providerLabel = getCliProviderSpec(this.provider).label.toLowerCase();
    throw new Error(`${providerLabel} executable not found: ${this.codexBin}. Check CODEX_BIN or PATH.`);
  }

  private resolveTimeoutMs(prompt: string): number {
    if (typeof this.timeoutMs === 'number' && Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
      return this.timeoutMs;
    }
    const min = Math.max(1, this.timeoutMinMs);
    const max = Math.max(min, this.timeoutMaxMs);
    const byPrompt = min + Math.max(0, prompt.length) * Math.max(0, this.timeoutPerCharMs);
    return Math.min(max, byPrompt);
  }

  private async listOpenCodeModels(): Promise<{ fetchedAt?: string; models: Array<{ slug: string; visibility: 'list' | 'hide' | string; supportedInApi: boolean }> }> {
    try {
      const env = buildCodexChildEnv(process.env, {});
      if (this.codexHomeDir?.trim()) {
        const resolvedHome = this.codexHomeDir.trim();
        env.HOME = resolvedHome;
        env.XDG_CONFIG_HOME = `${resolvedHome}/.config`;
        env.XDG_CACHE_HOME = `${resolvedHome}/.cache`;
        env.XDG_DATA_HOME = `${resolvedHome}/.local/share`;
      }
      const { stdout } = await execFileAsync(this.codexBin, ['models', '--format', 'json'], {
        cwd: this.workdir,
        env,
        maxBuffer: 1024 * 1024,
      });
      return parseOpenCodeModels(stdout);
    } catch (error) {
      log.warn('OpenCode models 查询失败，回退为空模型列表', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { models: [] };
    }
  }
}

export function buildCodexArgs(
  input: Pick<CodexRunInput, 'prompt' | 'threadId' | 'model' | 'search' | 'workdir' | 'reminderToolContext'>,
  sandbox: 'full-auto' | 'none',
  provider: CliProvider = 'codex',
): string[] {
  const promptAttachments = extractPromptAttachments(input.prompt);
  if (provider === 'opencode') {
    const args: string[] = ['run', '--format', 'json'];
    if (input.threadId?.trim()) {
      args.push('--session', input.threadId.trim());
    }
    if (input.model?.trim()) {
      args.push('--model', input.model.trim());
    }
    for (const filePath of promptAttachments.filePaths) {
      args.push('--file', filePath);
    }
    args.push(promptAttachments.sanitizedPrompt);
    return args;
  }
  const sandboxFlag = sandbox === 'none'
    ? '--dangerously-bypass-approvals-and-sandbox'
    : '--full-auto';

  const args: string[] = input.threadId
    ? ['exec', 'resume', input.threadId, '--json', sandboxFlag, '--skip-git-repo-check']
    : ['exec', '--json', sandboxFlag, '--skip-git-repo-check'];

  for (const imagePath of promptAttachments.imagePaths) {
    args.push('--image', imagePath);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  if (input.workdir?.trim()) {
    args.unshift(input.workdir.trim());
    args.unshift('--cd');
  }
  if (input.search) {
    args.unshift('--search');
  }
  args.push(promptAttachments.sanitizedPrompt);
  return args;
}

function extractPromptAttachments(prompt: string): {
  sanitizedPrompt: string;
  imagePaths: string[];
  filePaths: string[];
} {
  const seenImages = new Set<string>();
  const seenFiles = new Set<string>();
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const keptLines: string[] = [];

  for (const line of prompt.split('\n')) {
    const imageMatch = line.match(/\blocal_image_path=([^\n\r]+)/);
    if (imageMatch?.[1]) {
      const filePath = imageMatch[1].trim();
      if (filePath && !seenImages.has(filePath)) {
        seenImages.add(filePath);
        imagePaths.push(filePath);
      }
      if (filePath && !seenFiles.has(filePath)) {
        seenFiles.add(filePath);
        filePaths.push(filePath);
      }
      continue;
    }

    const fileMatch = line.match(/\blocal_(?:file|audio|media|sticker)_path=([^\n\r]+)/);
    if (fileMatch?.[1]) {
      const filePath = fileMatch[1].trim();
      if (filePath && !seenFiles.has(filePath)) {
        seenFiles.add(filePath);
        filePaths.push(filePath);
      }
      continue;
    }

    keptLines.push(line);
  }

  return {
    sanitizedPrompt: keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    imagePaths,
    filePaths,
  };
}

export function buildCodexReviewArgs(
  input: Pick<CodexReviewInput, 'mode' | 'target' | 'prompt' | 'model' | 'search' | 'workdir'>,
  sandbox: 'full-auto' | 'none',
  provider: CliProvider = 'codex',
): string[] {
  if (provider === 'opencode') {
    const args: string[] = ['run', '--format', 'json'];
    if (input.model?.trim()) {
      args.push('--model', input.model.trim());
    }
    args.push(buildOpenCodeReviewPrompt(input));
    return args;
  }
  const sandboxFlag = sandbox === 'none'
    ? '--dangerously-bypass-approvals-and-sandbox'
    : '--full-auto';

  const args: string[] = ['exec', 'review', '--json', sandboxFlag, '--skip-git-repo-check'];
  if (input.mode === 'uncommitted') {
    args.push('--uncommitted');
  } else if (input.mode === 'base' && input.target) {
    args.push('--base', input.target);
  } else if (input.mode === 'commit' && input.target) {
    args.push('--commit', input.target);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  if (input.workdir?.trim()) {
    args.unshift(input.workdir.trim());
    args.unshift('--cd');
  }
  if (input.search) {
    args.unshift('--search');
  }
  if (input.prompt) {
    args.push(input.prompt);
  }
  return args;
}

export function buildCodexChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  input: {
    reminderToolContext?: CodexRunInput['reminderToolContext'];
    browserAutomation?: BrowserAutomationRuntimeConfig;
    gatewayRootDir?: string;
    gatewayPublicBaseUrl?: string;
    gatewayUserId?: string;
    internalApiToken?: string;
    internalApiBaseUrl?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
  };

  const hostHome = baseEnv.HOME?.trim();
  if (hostHome) {
    env.CODEX_WORKDIR_ISOLATION_HOST_HOME = hostHome;
  }

  if (input.reminderToolContext) {
    env.GATEWAY_REMINDER_DB_PATH = input.reminderToolContext.dbPath;
    env.GATEWAY_REMINDER_CHANNEL = input.reminderToolContext.channel;
    env.GATEWAY_REMINDER_USER_ID = input.reminderToolContext.userId;
    env.GATEWAY_REMINDER_AGENT_ID = input.reminderToolContext.agentId;
  }

  if (input.browserAutomation?.apiBaseUrl) {
    env.GATEWAY_BROWSER_API_BASE = input.browserAutomation.apiBaseUrl;
  }
  if (input.browserAutomation?.internalApiToken) {
    env.GATEWAY_INTERNAL_API_TOKEN = input.browserAutomation.internalApiToken;
  } else if (input.internalApiToken?.trim()) {
    env.GATEWAY_INTERNAL_API_TOKEN = input.internalApiToken.trim();
  }
  if (input.gatewayRootDir?.trim()) {
    env.GATEWAY_ROOT_DIR = input.gatewayRootDir.trim();
  }
  if (input.gatewayPublicBaseUrl?.trim()) {
    env.GATEWAY_PUBLIC_BASE_URL = input.gatewayPublicBaseUrl.trim();
  }
  if (input.gatewayUserId?.trim()) {
    env.GATEWAY_USER_ID = input.gatewayUserId.trim();
  }
  if (input.internalApiBaseUrl?.trim()) {
    env.GATEWAY_INTERNAL_API_BASE = input.internalApiBaseUrl.trim();
  }

  return env;
}

function redactArgsForLog(args: string[]): string[] {
  if (args.length === 0) {
    return [];
  }
  const output = [...args];
  output[output.length - 1] = '<prompt omitted>';
  for (let i = 0; i < output.length; i++) {
    if (output[i] === 'resume' && i + 1 < output.length) {
      output[i + 1] = maskThreadId(output[i + 1]);
    }
  }
  return output;
}

function maskThreadId(threadId?: string): string {
  if (!threadId) {
    return '(新)';
  }
  if (threadId.length <= 8) {
    return '****';
  }
  return `${threadId.slice(0, 4)}...${threadId.slice(-4)}`;
}

function parseCodexThreadGoal(value: unknown): CodexThreadGoal | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const goal = value as Record<string, unknown>;
  if (typeof goal.threadId !== 'string' || typeof goal.objective !== 'string' || typeof goal.status !== 'string') {
    return undefined;
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status as CodexThreadGoal['status'],
    tokenBudget: typeof goal.tokenBudget === 'number' ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : 0,
    timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : 0,
    createdAt: typeof goal.createdAt === 'number' ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : 0,
  };
}

function formatCodexGoalUpdatedMessage(goal: CodexThreadGoal): string {
  const budget = goal.tokenBudget === null ? '不限制' : String(goal.tokenBudget);
  return [
    `✅ 已更新 Codex 目标：${goal.objective}`,
    `状态：${formatCodexGoalStatus(goal.status)}`,
    `Token 预算：${budget}`,
  ].join('\n');
}

function formatCodexGoalStatus(status: CodexThreadGoal['status']): string {
  switch (status) {
    case 'active':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'budgetLimited':
      return '预算受限';
    case 'complete':
      return '已完成';
    default:
      return status;
  }
}

function handleCodexLine(
  line: string,
  onMessage: CodexRunInput['onMessage'],
  onEvent: () => void,
  onThreadStarted?: (threadId: string) => void,
): void {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    onEvent();
    const item = event.item as Record<string, unknown> | undefined;
    log.debug('Codex 事件', {
      type: event.type,
      itemType: item?.type,
    });

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      onThreadStarted?.(event.thread_id);
      log.info('Codex thread.started', { threadId: event.thread_id });
    }

    if (typeof event.sessionID === 'string') {
      onThreadStarted?.(event.sessionID);
      log.info('OpenCode session event', { threadId: event.sessionID, type: event.type });
    }

    if ((event.type === 'item.started' || event.type === 'item.completed') && item?.type === 'mcp_tool_call') {
      log.info(`Codex ${String(event.type)} mcp_tool_call`, summarizeCodexItem(item));
    }

    if (event.type === 'item.completed') {
      if (item?.type === 'agent_message' && typeof item.text === 'string' && onMessage) {
        log.info('Codex item.completed agent_message', {
          textLength: item.text.length,
          textPreview: item.text.substring(0, 200),
        });
        onMessage(item.text);
      }
    }

    if (event.type === 'text' && onMessage) {
      if (typeof event.text === 'string' && event.text) {
        onMessage(event.text);
        return;
      }
      const part = event.part as Record<string, unknown> | undefined;
      if (typeof part?.text === 'string' && part.text) {
        onMessage(part.text);
      }
    }
  } catch {
    log.debug('Codex stdout 非 JSON 行', { line: line.substring(0, 100) });
  }
}

function buildCodexTurnInputItems(prompt: string): CodexTurnInputItem[] {
  const seenImages = new Set<string>();
  const imagePaths: string[] = [];
  const keptLines: string[] = [];

  for (const line of prompt.split('\n')) {
    const imageMatch = line.match(/\blocal_image_path=([^\n\r]+)/);
    if (imageMatch?.[1]) {
      const filePath = imageMatch[1].trim();
      if (filePath && !seenImages.has(filePath)) {
        seenImages.add(filePath);
        imagePaths.push(filePath);
      }
      continue;
    }
    keptLines.push(line);
  }

  const items: CodexTurnInputItem[] = [];
  const text = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text) {
    items.push({
      type: 'text',
      text,
    });
  }
  for (const imagePath of imagePaths) {
    items.push({
      type: 'localImage',
      path: imagePath,
    });
  }
  return items;
}

function buildOpenCodeReviewPrompt(
  input: Pick<CodexReviewInput, 'mode' | 'target' | 'prompt'>,
): string {
  const lines = ['Review this code carefully. Focus on bugs, regressions, risks, and missing tests.'];
  if (input.mode === 'uncommitted') {
    lines.push('Review the current uncommitted changes in the repository.');
  } else if (input.mode === 'base' && input.target) {
    lines.push(`Review the current branch against base branch ${input.target}.`);
  } else if (input.mode === 'commit' && input.target) {
    lines.push(`Review commit ${input.target}.`);
  }
  if (input.prompt?.trim()) {
    lines.push(input.prompt.trim());
  }
  return lines.join('\n');
}

function parseProviderJsonl(provider: CliProvider, raw: string): ParsedCodexOutput {
  if (provider === 'opencode') {
    return parseOpenCodeJsonl(raw);
  }
  return parseCodexJsonl(raw);
}

function parseOpenCodeJsonl(raw: string): ParsedCodexOutput {
  let threadId: string | undefined;
  let answer = '';
  for (const event of iterateCodexEvents(raw)) {
    if (typeof event.sessionID === 'string') {
      threadId = event.sessionID;
    }
    if (event.type === 'text') {
      if (typeof event.text === 'string') {
        answer += event.text;
        continue;
      }
      const part = event.part as Record<string, unknown> | undefined;
      if (typeof part?.text === 'string') {
        answer += part.text;
      }
    }
  }
  return {
    threadId,
    answer: answer || '（OpenCode 未返回可解析内容）',
  };
}

function repairLegacyOpenCodeConfig(codexHomeDir: string | undefined): void {
  const trimmedHome = codexHomeDir?.trim();
  if (!trimmedHome) {
    return;
  }
  const configPath = path.join(trimmedHome, '.config', 'opencode', 'opencode.json');
  if (!fs.existsSync(configPath)) {
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      model?: unknown;
      provider?: Record<string, unknown>;
    };
    const configuredModel = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    const [providerId, ...modelParts] = configuredModel.split('/');
    if (!providerId || modelParts.length === 0) {
      return;
    }
    const modelId = modelParts.join('/').trim();
    if (!modelId) {
      return;
    }
    const provider = parsed.provider?.[providerId];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      return;
    }
    const providerRecord = provider as Record<string, unknown>;
    const existingModels = providerRecord.models;
    if (existingModels && typeof existingModels === 'object' && !Array.isArray(existingModels) && modelId in (existingModels as Record<string, unknown>)) {
      return;
    }
    providerRecord.models = {
      ...(existingModels && typeof existingModels === 'object' && !Array.isArray(existingModels) ? existingModels as Record<string, unknown> : {}),
      [modelId]: {},
    };
    fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    log.info('已修补旧版 OpenCode 配置中的 models 注册', {
      configPath,
      providerId,
      modelId,
    });
  } catch (error) {
    log.warn('修补 OpenCode 配置失败，继续按原配置执行', {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseOpenCodeModels(raw: string): { fetchedAt?: string; models: Array<{ slug: string; visibility: 'list' | 'hide' | string; supportedInApi: boolean }> } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object'
        ? (Array.isArray((parsed as Record<string, unknown>).models) ? (parsed as Record<string, unknown>).models as unknown[] : [])
        : []);
    const models = values
      .map((item) => normalizeOpenCodeModelEntry(item))
      .filter((item): item is { slug: string; visibility: 'list'; supportedInApi: true } => !!item);
    return {
      fetchedAt: new Date().toISOString(),
      models,
    };
  } catch {
    return { models: [] };
  }
}

function normalizeOpenCodeModelEntry(input: unknown): { slug: string; visibility: 'list'; supportedInApi: true } | undefined {
  if (typeof input === 'string' && input.trim()) {
    return { slug: input.trim(), visibility: 'list', supportedInApi: true };
  }
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const data = input as Record<string, unknown>;
  const providerId = typeof data.providerID === 'string' ? data.providerID.trim() : '';
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const slug = id || name;
  if (!slug) {
    return undefined;
  }
  return {
    slug: providerId && !slug.includes('/') ? `${providerId}/${slug}` : slug,
    visibility: 'list',
    supportedInApi: true,
  };
}

function loadCodexModelsFromHome(codexHomeDir: string | undefined): { fetchedAt?: string; models: Array<{ slug: string; visibility: 'list' | 'hide' | string; supportedInApi: boolean }> } {
  const cachePath = codexHomeDir?.trim() ? `${codexHomeDir.trim()}/models_cache.json` : undefined;
  if (!cachePath) {
    return { models: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { fetched_at?: string; models?: unknown[] };
    const models = (raw.models ?? [])
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return undefined;
        }
        const data = item as Record<string, unknown>;
        const slug = typeof data.slug === 'string' ? data.slug : '';
        if (!slug) {
          return undefined;
        }
        return {
          slug,
          visibility: typeof data.visibility === 'string' ? data.visibility : 'list',
          supportedInApi: data.supported_in_api !== false,
        };
      })
      .filter((item): item is { slug: string; visibility: 'list' | 'hide' | string; supportedInApi: boolean } => !!item);
    return {
      fetchedAt: raw.fetched_at,
      models,
    };
  } catch {
    return { models: [] };
  }
}

export function summarizeCodexItem(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!item) {
    return undefined;
  }
  const toolName = item.tool_name ?? item.name ?? item.toolName;
  const args = item.arguments ?? item.args ?? item.input;
  return {
    type: item.type,
    server: item.server ?? item.server_name ?? item.serverName,
    toolName: typeof toolName === 'string' ? toolName : undefined,
    argumentsPreview: summarizeCodexArguments(args),
  };
}

function summarizeCodexArguments(args: unknown): string | undefined {
  if (args === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(args);
    if (!serialized) {
      return undefined;
    }
    return serialized.length > 300 ? `${serialized.slice(0, 300)}...` : serialized;
  } catch {
    return String(args);
  }
}

/** 移除终端输出中的 ANSI 控制（颜色）字符 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}
