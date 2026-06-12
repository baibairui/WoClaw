import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { buildCodexSpawnSpec } from './codex-bwrap.js';
import type { CodexWorkdirIsolationMode, SkillRuntimePolicy } from './codex-bwrap.js';
import type { CliProvider } from './cli-provider.js';

const log = createLogger('CodexAppServerClient');

type JsonRpcId = string | number;

interface JsonRpcSuccess<T> {
  id: JsonRpcId;
  result: T;
}

interface JsonRpcFailure {
  id: JsonRpcId;
  error: {
    code?: number;
    message?: string;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexServerRequest {
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export type CodexDynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export interface CodexDynamicToolCallResponse {
  contentItems: CodexDynamicToolCallOutputContentItem[];
  success: boolean;
}

export type CodexServerRequestHandler = (
  request: CodexServerRequest,
) => Promise<unknown | undefined> | unknown | undefined;

interface CodexAppServerClientOptions {
  provider: CliProvider;
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  codexHomeDir?: string;
  workdirIsolation?: CodexWorkdirIsolationMode;
  skillPolicy?: SkillRuntimePolicy;
  onNotification?: (notification: JsonRpcNotification) => void;
  onServerRequest?: CodexServerRequestHandler;
}

export interface CodexThreadConfig {
  cwd?: string;
  model?: string;
  approvalPolicy?: 'never' | 'untrusted' | 'on-failure' | 'on-request';
  personality?: 'none' | 'friendly' | 'pragmatic';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface CodexTurnInputItem {
  type: 'text' | 'localImage';
  text?: string;
  path?: string;
}

export interface CodexTurnCompletion {
  status: string;
  turnId: string;
}

export type CodexThreadGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete';

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onNotification?: (notification: JsonRpcNotification) => void;
  private readonly onServerRequest?: CodexServerRequestHandler;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private nextRequestId = 1;
  private lineBuf = '';
  private closed = false;

  constructor(options: CodexAppServerClientOptions) {
    const spawnSpec = buildCodexSpawnSpec({
      provider: options.provider,
      codexBin: options.codexBin,
      args: ['app-server', '--listen', 'stdio://', '--enable', 'goals'],
      cwd: options.cwd,
      env: options.env,
      isolationMode: options.workdirIsolation ?? 'bwrap',
      codexHomeDir: options.codexHomeDir,
      skillPolicy: options.skillPolicy,
    });

    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.lineBuf += chunk;
      const lines = this.lineBuf.split('\n');
      this.lineBuf = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        this.handleLine(line);
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      log.warn('app-server stderr 输出', { text: chunk.toString('utf8').slice(0, 500) });
    });

    this.child.on('error', (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });

    this.child.on('close', (code) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.failAll(new Error(`codex app-server exited with code ${code}`));
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'AgentClaw',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  startThread(config: CodexThreadConfig): Promise<{ thread: { id: string } }> {
    return this.request('thread/start', buildThreadConfig(config)) as Promise<{ thread: { id: string } }>;
  }

  resumeThread(threadId: string, config: CodexThreadConfig): Promise<{ thread: { id: string } }> {
    return this.request('thread/resume', {
      threadId,
      ...buildThreadConfig(config),
    }) as Promise<{ thread: { id: string } }>;
  }

  startTurn(input: {
    threadId: string;
    items: CodexTurnInputItem[];
    cwd?: string;
    model?: string;
  }): Promise<{ turn: { id: string; status: string } }> {
    return this.request('turn/start', {
      threadId: input.threadId,
      cwd: input.cwd ?? null,
      model: input.model ?? null,
      input: input.items.map((item) => (
        item.type === 'localImage'
          ? { type: 'localImage', path: item.path }
          : { type: 'text', text: item.text ?? '' }
      )),
    }) as Promise<{ turn: { id: string; status: string } }>;
  }

  interruptTurn(threadId: string, turnId: string): Promise<void> {
    return this.request('turn/interrupt', { threadId, turnId }).then(() => undefined);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.kill('SIGKILL');
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcSuccess<unknown> | JsonRpcFailure | JsonRpcNotification | CodexServerRequest;
    try {
      message = JSON.parse(line) as JsonRpcSuccess<unknown> | JsonRpcFailure | JsonRpcNotification;
    } catch {
      log.debug('app-server stdout 非 JSON 行', { line: line.slice(0, 200) });
      return;
    }

    if (isCodexServerRequest(message)) {
      void this.handleServerRequest(message);
      return;
    }

    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if ('error' in message) {
        pending.reject(new Error(message.error?.message ?? `app-server request failed: ${message.id}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    this.onNotification?.(message);
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    try {
      const response = await this.onServerRequest?.(request);
      if (response !== undefined) {
        this.writeResult(request.id, response);
        return;
      }

      if (request.method === 'item/tool/call') {
        this.writeResult(request.id, buildDynamicToolFailureResponse(
          `Unsupported native tool call: ${describeNativeToolCall(request)}`,
        ));
        return;
      }

      this.writeError(request.id, -32601, `Unsupported app-server request: ${request.method}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request.method === 'item/tool/call') {
        this.writeResult(request.id, buildDynamicToolFailureResponse(message));
        return;
      }
      this.writeError(request.id, -32603, message || `app-server request failed: ${request.method}`);
    }
  }

  private writeResult(id: JsonRpcId, result: unknown): void {
    if (this.closed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    if (this.closed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    })}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function buildDynamicToolFailureResponse(message: string): CodexDynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: message || 'Native tool call failed.',
      },
    ],
    success: false,
  };
}

function isCodexServerRequest(
  message: JsonRpcSuccess<unknown> | JsonRpcFailure | JsonRpcNotification | CodexServerRequest,
): message is CodexServerRequest {
  return 'id' in message
    && (typeof message.id === 'number' || typeof message.id === 'string')
    && 'method' in message
    && typeof message.method === 'string';
}

function describeNativeToolCall(request: CodexServerRequest): string {
  const params = request.params;
  const namespace = typeof params?.namespace === 'string' ? params.namespace : undefined;
  const tool = typeof params?.tool === 'string' ? params.tool : undefined;
  return [namespace, tool].filter(Boolean).join('.') || request.method;
}

function buildThreadConfig(config: CodexThreadConfig): Record<string, unknown> {
  return {
    cwd: config.cwd ?? null,
    model: config.model ?? null,
    approvalPolicy: config.approvalPolicy ?? 'never',
    personality: config.personality ?? 'pragmatic',
    sandbox: config.sandbox ?? 'workspace-write',
  };
}
