import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { CodexRunner, buildCodexArgs, buildCodexChildEnv, buildCodexReviewArgs, parseCodexJsonl, resolveServiceWorkdirIsolation, summarizeCodexItem } from '../src/services/codex-runner.js';
import { buildCodexSpawnSpec } from '../src/services/codex-bwrap.js';

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: {
      write: ReturnType<typeof vi.fn>;
    };
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write: vi.fn(),
  };
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

function createMockCodexExecutable(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const codexScript = path.join(tempRoot, 'codex.js');
  fs.writeFileSync(codexScript, '#!/usr/bin/env node\nconsole.log("ok");\n', { mode: 0o755 });
  return codexScript;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('parseCodexJsonl', () => {
  it('parses thread id and latest agent message', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 't_123' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
    ].join('\n');

    const result = parseCodexJsonl(raw);
    expect(result.threadId).toBe('t_123');
    expect(result.answer).toBe('second');
  });

  it('ignores invalid lines and falls back when no answer', () => {
    const raw = '{not-json}\n' + JSON.stringify({ type: 'thread.started', thread_id: 't_456' });
    const result = parseCodexJsonl(raw);

    expect(result.threadId).toBe('t_456');
    expect(result.answer).toContain('未返回可解析内容');
  });
});

describe('summarizeCodexItem', () => {
  it('keeps key mcp tool call fields for logging', () => {
    expect(summarizeCodexItem({
      type: 'mcp_tool_call',
      server: 'tool_bridge',
      tool_name: 'navigate',
      arguments: { url: 'https://example.com' },
    })).toEqual({
      type: 'mcp_tool_call',
      server: 'tool_bridge',
      toolName: 'navigate',
      argumentsPreview: '{"url":"https://example.com"}',
    });
  });

  it('returns undefined for missing items', () => {
    expect(summarizeCodexItem(undefined)).toBeUndefined();
  });
});

describe('buildCodexArgs', () => {
  it('includes --model when model is provided', () => {
    const args = buildCodexArgs(
      { prompt: 'hello', model: 'gpt-5-codex', workdir: '/tmp/agent-a' },
      'full-auto',
    );
    expect(args).toEqual([
      '--cd',
      '/tmp/agent-a',
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--model',
      'gpt-5-codex',
      'hello',
    ]);
  });

  it('builds resume args without --model when model is empty', () => {
    const args = buildCodexArgs(
      { prompt: 'hello', threadId: 'thread_123', workdir: '/tmp/agent-a' },
      'none',
    );
    expect(args).toEqual([
      '--cd',
      '/tmp/agent-a',
      'exec',
      'resume',
      'thread_123',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      'hello',
    ]);
  });

  it('puts --search before exec when enabled', () => {
    const args = buildCodexArgs(
      { prompt: 'hello', model: 'gpt-5.4', search: true, workdir: '/tmp/agent-b' },
      'full-auto',
    );
    expect(args).toEqual([
      '--search',
      '--cd',
      '/tmp/agent-b',
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.4',
      'hello',
    ]);
  });

  it('attaches local images to codex exec when prompt contains staged image paths', () => {
    const args = buildCodexArgs(
      {
        prompt: `[飞书图片] image_key=img_1
message_id=om_1
[飞书附件元数据]
local_image_path=/tmp/workspace/.gateway-inbox/img-1.png`,
        workdir: '/tmp/agent-image',
      },
      'full-auto',
    );

    expect(args).toEqual([
      '--cd',
      '/tmp/agent-image',
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--image',
      '/tmp/workspace/.gateway-inbox/img-1.png',
      `[飞书图片] image_key=img_1
message_id=om_1
[飞书附件元数据]`,
    ]);
  });

  it('deduplicates repeated local image paths in the prompt', () => {
    const args = buildCodexArgs(
      {
        prompt: `first
local_image_path=/tmp/a.png
second
local_image_path=/tmp/a.png
local_image_path=/tmp/b.png`,
      },
      'full-auto',
    );

    expect(args).toContain('--image');
    expect(args.filter((item) => item === '--image')).toHaveLength(2);
    expect(args).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--image',
      '/tmp/a.png',
      '--image',
      '/tmp/b.png',
      `first
second`,
    ]);
  });

  it('does not modify args when reminder skill context is provided', () => {
    const args = buildCodexArgs(
      {
        prompt: 'remind me later',
        workdir: '/tmp/agent-d',
        reminderToolContext: {
          dbPath: '/tmp/reminders.db',
          channel: 'wecom',
          userId: 'u1',
          agentId: 'assistant',
        },
      },
      'full-auto',
    );

    expect(args).toEqual([
      '--cd',
      '/tmp/agent-d',
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      'remind me later',
    ]);
  });

  it('builds opencode run args with session and model', () => {
    const args = buildCodexArgs(
      { prompt: 'hello', threadId: 'sess_123', model: 'openai/gpt-5' },
      'full-auto',
      'opencode',
    );

    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--session',
      'sess_123',
      '--model',
      'openai/gpt-5',
      'hello',
    ]);
  });

  it('attaches local files to opencode run and strips local path lines from the prompt', () => {
    const args = buildCodexArgs(
      {
        prompt: `[飞书图片] image_key=img_1
message_id=om_1
[飞书附件元数据]
local_image_path=/tmp/workspace/.gateway-inbox/img-1.png`,
        model: 'openai/gpt-5',
      },
      'full-auto',
      'opencode',
    );

    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'openai/gpt-5',
      '--file',
      '/tmp/workspace/.gateway-inbox/img-1.png',
      `[飞书图片] image_key=img_1
message_id=om_1
[飞书附件元数据]`,
    ]);
  });
});

describe('CodexRunner active control', () => {
  it('starts app-server with the goals feature and without the removed session-source flag', () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new CodexRunner({ codexBin: 'codex' });
    runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-app-server-flags' });

    const spawnArgs = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined;
    expect(spawnArgs).toEqual(expect.arrayContaining(['app-server', '--listen', 'stdio://', '--enable', 'goals']));
    expect(spawnArgs).not.toContain('--session-source');
  });

  it('does not configure native app-server tools through the legacy browser API env', () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new CodexRunner({
      codexBin: 'codex',
      browserApiBaseUrl: 'http://127.0.0.1:3000/internal/browser',
      internalApiBaseUrl: 'http://127.0.0.1:3000/internal',
      internalApiToken: 'token-123',
      workdirIsolation: 'off',
    });
    runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-native-env' });

    const spawnOptions = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(spawnOptions?.env?.GATEWAY_BROWSER_API_BASE).toBeUndefined();
    expect(spawnOptions?.env?.GATEWAY_INTERNAL_API_BASE).toBeUndefined();
    expect(spawnOptions?.env?.GATEWAY_INTERNAL_API_TOKEN).toBeUndefined();
  });

  it('returns a stop handle for an active run', () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new CodexRunner({ codexBin: 'codex' });
    const active = runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-active-control' });

    expect(typeof active.stop).toBe('function');
    expect(child.stdin.write).toHaveBeenCalled();
  });

  it('interrupts the active turn through app-server and rejects the run', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new CodexRunner({ codexBin: 'codex', timeoutMs: 1_000 });
    const active = runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-active-control' });

    await tick();
    expect(String(child.stdin.write.mock.calls[0]?.[0] ?? '')).toContain('"method":"initialize"');
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);

    await tick();
    expect(child.stdin.write.mock.calls.some((call) => String(call[0]).includes('"method":"thread/start"'))).toBe(true);
    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;

    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_active' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_active' } } })}\n`);

    await tick();
    expect(child.stdin.write.mock.calls.some((call) => String(call[0]).includes('"method":"turn/start"'))).toBe(true);
    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;

    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_active', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread_active', turn: { id: 'turn_active', status: 'inProgress' } } })}\n`);

    const stopPromise = active.stop('user_stop');
    const interruptRequest = String(child.stdin.write.mock.calls.at(-1)?.[0] ?? '');
    expect(interruptRequest).toContain('"method":"turn/interrupt"');
    expect(interruptRequest).toContain('"threadId":"thread_active"');
    expect(interruptRequest).toContain('"turnId":"turn_active"');

    const interruptRequestId = JSON.parse(interruptRequest).id;
    child.stdout.write(`${JSON.stringify({ id: interruptRequestId, result: {} })}\n`);
    await expect(stopPromise).resolves.toBe(true);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_active', turn: { id: 'turn_active', status: 'interrupted' } } })}\n`);

    await expect(active.result).rejects.toThrow(/stopped by user/i);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('emits the final app-server agent message once after deltas are aggregated', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const onMessage = vi.fn();

    const runner = new CodexRunner({ codexBin: 'codex', timeoutMs: 1_000 });
    const active = runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-active-control', onMessage });

    await tick();
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await tick();
    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_active' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_active' } } })}\n`);

    await tick();
    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_active', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread_active', turn: { id: 'turn_active', status: 'inProgress' } } })}\n`);

    child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread_active', turnId: 'turn_active', itemId: 'msg_1', delta: '收到' } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread_active', turnId: 'turn_active', itemId: 'msg_1', delta: '，正常。' } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: 'thread_active', turnId: 'turn_active', item: { type: 'agentMessage', id: 'msg_1', text: '收到，正常。' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_active', turn: { id: 'turn_active', status: 'completed' } } })}\n`);

    await expect(active.result).resolves.toMatchObject({ threadId: 'thread_active' });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('收到，正常。');
  });

  it('uses the real agent cwd for app-server runs when workdir isolation is off', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new CodexRunner({
      codexBin: 'codex',
      timeoutMs: 1_000,
      workdirIsolation: 'off',
    });
    const active = runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-direct-appserver' });

    await tick();
    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall?.[0]).not.toBe('bwrap');

    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await tick();

    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    expect(threadStartRequest).toContain('"cwd":"/tmp/agent-direct-appserver"');
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;

    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_active' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_active' } } })}\n`);
    await tick();

    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    expect(turnStartRequest).toContain('"cwd":"/tmp/agent-direct-appserver"');
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;

    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_active', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_active', turn: { id: 'turn_active', status: 'completed' } } })}\n`);
    await expect(active.result).resolves.toMatchObject({ threadId: 'thread_active' });
  });

  it('rewrites app-server cwd to /workspace for bwrap-isolated agent runs', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);

    const runner = new CodexRunner({
      codexBin: 'codex',
      timeoutMs: 1_000,
      workdirIsolation: 'bwrap',
    });
    const active = runner.runWithControl({ prompt: 'hello', workdir: '/tmp/agent-bwrap-appserver' });

    await tick();
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await tick();

    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    expect(threadStartRequest).toContain('"cwd":"/workspace"');
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;

    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_active' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_active' } } })}\n`);
    await tick();

    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    expect(turnStartRequest).toContain('"cwd":"/workspace"');
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_active', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_active', turn: { id: 'turn_active', status: 'completed' } } })}\n`);
    await expect(active.result).resolves.toMatchObject({ threadId: 'thread_active' });
  });

  it('passes native /goal commands through turn/start and emits goal updates', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const onMessage = vi.fn();

    const runner = new CodexRunner({
      codexBin: 'codex',
      timeoutMs: 1_000,
      workdirIsolation: 'bwrap',
    });
    const active = runner.runWithControl({
      prompt: '/goal improve benchmark coverage',
      model: 'gpt-5-codex',
      workdir: '/tmp/agent-goal',
      onMessage,
    });

    await tick();
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await tick();

    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    expect(threadStartRequest).toContain('"cwd":"/workspace"');
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_goal' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_goal' } } })}\n`);

    await tick();
    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    expect(turnStartRequest).toContain('"text":"/goal improve benchmark coverage"');
    expect(child.stdin.write.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('"method":"thread/goal/set"');
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_goal', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({
      method: 'thread/goal/updated',
      params: {
        threadId: 'thread_goal',
        turnId: 'turn_goal',
        goal: {
          threadId: 'thread_goal',
          objective: 'improve benchmark coverage',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_goal', turn: { id: 'turn_goal', status: 'completed' } } })}\n`);

    await expect(active.result).resolves.toMatchObject({
      threadId: 'thread_goal',
    });
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('已更新 Codex 目标'));
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('improve benchmark coverage'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('emits native goal clear notifications', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const onMessage = vi.fn();

    const runner = new CodexRunner({
      codexBin: 'codex',
      timeoutMs: 1_000,
      workdirIsolation: 'off',
    });
    const active = runner.runWithControl({
      prompt: '/goal clear',
      workdir: '/tmp/agent-goal-direct',
      onMessage,
    });

    await tick();
    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall?.[0]).not.toBe('bwrap');

    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await tick();

    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    expect(threadStartRequest).toContain('"cwd":"/tmp/agent-goal-direct"');
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_goal_direct' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_goal_direct' } } })}\n`);

    await tick();
    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    expect(turnStartRequest).toContain('"text":"/goal clear"');
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_goal_clear', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/goal/cleared', params: { threadId: 'thread_goal_direct' } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_goal_direct', turn: { id: 'turn_goal_clear', status: 'completed' } } })}\n`);

    await expect(active.result).resolves.toMatchObject({
      threadId: 'thread_goal_direct',
    });
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('已清除当前 Codex 目标'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('responds to native dynamic tool calls with the official response format', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const nativeToolHandler = vi.fn(async () => ({
      contentItems: [
        { type: 'inputText' as const, text: 'browser snapshot ok' },
      ],
      success: true,
    }));

    const runner = new CodexRunner({
      codexBin: 'codex',
      timeoutMs: 1_000,
      workdirIsolation: 'off',
      nativeToolHandler,
    });
    const active = runner.runWithControl({
      prompt: 'inspect the page',
      workdir: '/tmp/agent-native-tool',
    });

    await tick();
    child.stdout.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await tick();

    const threadStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"thread/start"'));
    const threadStartRequestId = JSON.parse(threadStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: threadStartRequestId, result: { thread: { id: 'thread_native_tool' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread_native_tool' } } })}\n`);

    await tick();
    const turnStartRequest = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"method":"turn/start"'));
    const turnStartRequestId = JSON.parse(turnStartRequest ?? '{}').id;
    child.stdout.write(`${JSON.stringify({ id: turnStartRequestId, result: { turn: { id: 'turn_native_tool', status: 'inProgress' } } })}\n`);
    child.stdout.write(`${JSON.stringify({
      id: 77,
      method: 'item/tool/call',
      params: {
        threadId: 'thread_native_tool',
        turnId: 'turn_native_tool',
        callId: 'call_browser',
        namespace: 'gateway-browser',
        tool: 'snapshot',
        arguments: {},
      },
    })}\n`);

    await tick();
    const toolResponse = child.stdin.write.mock.calls
      .map((call) => String(call[0]))
      .find((payload) => payload.includes('"id":77'));
    expect(nativeToolHandler).toHaveBeenCalledWith(expect.objectContaining({
      method: 'item/tool/call',
      params: expect.objectContaining({
        callId: 'call_browser',
        tool: 'snapshot',
      }),
    }));
    expect(toolResponse).toContain('"result"');
    expect(toolResponse).toContain('"contentItems":[{"type":"inputText","text":"browser snapshot ok"}]');
    expect(toolResponse).toContain('"success":true');

    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_native_tool', turn: { id: 'turn_native_tool', status: 'completed' } } })}\n`);
    await expect(active.result).resolves.toMatchObject({
      threadId: 'thread_native_tool',
    });
  });
});

describe('buildCodexReviewArgs', () => {
  it('builds uncommitted review args', () => {
    const args = buildCodexReviewArgs(
      { mode: 'uncommitted', model: 'gpt-5.4', search: true, workdir: '/tmp/agent-b' },
      'full-auto',
    );
    expect(args).toEqual([
      '--search',
      '--cd',
      '/tmp/agent-b',
      'exec',
      'review',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--uncommitted',
      '--model',
      'gpt-5.4',
    ]);
  });

  it('builds base review args with prompt', () => {
    const args = buildCodexReviewArgs(
      { mode: 'base', target: 'main', prompt: 'focus on regressions', workdir: '/tmp/agent-c' },
      'none',
    );
    expect(args).toEqual([
      '--cd',
      '/tmp/agent-c',
      'exec',
      'review',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--base',
      'main',
      'focus on regressions',
    ]);
  });

  it('builds opencode review as a run prompt', () => {
    const args = buildCodexReviewArgs(
      { mode: 'base', target: 'master', prompt: 'focus on auth regressions', model: 'openai/gpt-5' },
      'none',
      'opencode',
    );
    expect(args.slice(0, 5)).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'openai/gpt-5',
    ]);
    expect(args.at(-1)).toContain('base branch master');
    expect(args.at(-1)).toContain('focus on auth regressions');
  });

});

describe('buildCodexChildEnv', () => {
  it('injects reminder and browser skill runtime env vars without desktop gateway env', () => {
    const env = buildCodexChildEnv(
      { PATH: '/usr/bin', HOME: '/root' },
      {
        reminderToolContext: {
          dbPath: '/tmp/reminders.db',
          channel: 'wecom',
          userId: 'u1',
          agentId: 'assistant',
        },
        browserAutomation: {
          apiBaseUrl: 'http://127.0.0.1:3000/internal/browser',
          internalApiToken: 'token-123',
        },
        gatewayRootDir: '/opt/gateway',
        gatewayPublicBaseUrl: 'https://gateway.example.com',
        gatewayUserId: 'u1',
        internalApiBaseUrl: 'http://127.0.0.1:3000/internal',
      },
    );

    expect(env.GATEWAY_REMINDER_DB_PATH).toBe('/tmp/reminders.db');
    expect(env.GATEWAY_REMINDER_CHANNEL).toBe('wecom');
    expect(env.GATEWAY_REMINDER_USER_ID).toBe('u1');
    expect(env.GATEWAY_REMINDER_AGENT_ID).toBe('assistant');
    expect(env.GATEWAY_BROWSER_API_BASE).toBe('http://127.0.0.1:3000/internal/browser');
    expect(env.GATEWAY_DESKTOP_API_BASE).toBeUndefined();
    expect(env.GATEWAY_INTERNAL_API_TOKEN).toBe('token-123');
    expect(env.GATEWAY_INTERNAL_API_BASE).toBe('http://127.0.0.1:3000/internal');
    expect(env.GATEWAY_ROOT_DIR).toBe('/opt/gateway');
    expect(env.GATEWAY_PUBLIC_BASE_URL).toBe('https://gateway.example.com');
    expect(env.GATEWAY_USER_ID).toBe('u1');
  });
});

describe('resolveServiceWorkdirIsolation', () => {
  it('defaults to direct spawn on macOS where bubblewrap is unavailable', () => {
    expect(resolveServiceWorkdirIsolation({}, 'darwin')).toBe('off');
  });

  it('keeps bubblewrap as the Linux default', () => {
    expect(resolveServiceWorkdirIsolation({}, 'linux')).toBe('bwrap');
  });

  it('honors explicit CODEX_WORKDIR_ISOLATION override', () => {
    expect(resolveServiceWorkdirIsolation({ CODEX_WORKDIR_ISOLATION: 'off' }, 'linux')).toBe('off');
    expect(resolveServiceWorkdirIsolation({ CODEX_WORKDIR_ISOLATION: 'bwrap' }, 'darwin')).toBe('bwrap');
  });
});

describe('buildCodexSpawnSpec', () => {
  it('keeps direct codex spawn when isolation is off', () => {
    const codexScript = createMockCodexExecutable('codex-direct-launch-');

    const spec = buildCodexSpawnSpec({
      codexBin: codexScript,
      args: ['exec', '--json', 'hello'],
      cwd: '/tmp/agent-direct',
      env: { HOME: '/root', PATH: '/usr/bin' },
      isolationMode: 'off',
      codexHomeDir: '/tmp/instance-home',
    });

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([codexScript, 'exec', '--json', 'hello']);
    expect(spec.cwd).toBe('/tmp/agent-direct');
    expect(spec.env.HOME).toBe('/root');
    expect(spec.env.CODEX_HOME).toBe('/tmp/instance-home');
    expect(spec.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(spec.env.XDG_CACHE_HOME).toBeUndefined();
  });

  it('uses the current node executable for node-shebang codex scripts', () => {
    const codexScript = createMockCodexExecutable('codex-script-launch-');

    const spec = buildCodexSpawnSpec({
      codexBin: codexScript,
      args: ['exec', '--json', 'hello'],
      cwd: '/tmp/agent-direct',
      env: { HOME: '/root', PATH: '/usr/bin:/bin' },
      isolationMode: 'off',
      codexHomeDir: '/tmp/instance-home',
    });

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([codexScript, 'exec', '--json', 'hello']);
  });

  it('points direct opencode runs at the instance XDG home so tool env stays stable', () => {
    const instanceHome = '/tmp/opencode-instance-home';
    const spec = buildCodexSpawnSpec({
      provider: 'opencode',
      codexBin: '/usr/bin/opencode',
      args: ['run', '--format', 'json', 'hello'],
      cwd: '/tmp/agent-opencode-direct',
      env: {
        HOME: '/root',
        PATH: '/usr/bin',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'sec_test',
      },
      isolationMode: 'off',
      codexHomeDir: instanceHome,
    });

    expect(spec.env.HOME).toBe(instanceHome);
    expect(spec.env.CODEX_HOME).toBe(instanceHome);
    expect(spec.env.XDG_CONFIG_HOME).toBe(`${instanceHome}/.config`);
    expect(spec.env.XDG_CACHE_HOME).toBe(`${instanceHome}/.cache`);
    expect(spec.env.XDG_DATA_HOME).toBe(`${instanceHome}/.local/share`);
    expect(spec.env.FEISHU_APP_ID).toBe('cli_test');
    expect(spec.env.FEISHU_APP_SECRET).toBe('sec_test');
  });

  it('wraps codex in bubblewrap and rewrites --cd to /workspace', () => {
    const workspaceDir = '/tmp/agent-bwrap';
    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['--cd', workspaceDir, 'exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: '/root',
        PATH: '/usr/bin:/bin',
        USER: 'root',
        LOGNAME: 'root',
      },
      isolationMode: 'bwrap',
      codexHomeDir: '/tmp/instance-home-bwrap',
    });

    expect(spec.command).toBe('bwrap');
    expect(spec.cwd).toBe(workspaceDir);
    expect(spec.args).toContain('/workspace');
    expect(spec.args).toContain('--bind');
    expect(spec.args).toContain('/workspace/.codex-runtime/home');
    expect(spec.env.HOME).toBe(`${workspaceDir}/.codex-runtime/home`);
    const cdIndex = spec.args.indexOf('--cd');
    expect(cdIndex).toBeGreaterThan(-1);
    expect(spec.args[cdIndex + 1]).toBe('/workspace');
  });

  it('mounts the configured host shell into bubblewrap and exposes SHELL', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-shell-'));
    const shellDir = path.join(tempRoot, 'custom-bin');
    const shellPath = path.join(shellDir, 'zsh');
    const workspaceDir = path.join(tempRoot, 'workspace');
    fs.mkdirSync(shellDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(shellPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: '/root',
        PATH: '/usr/bin:/bin',
        SHELL: shellPath,
      },
      isolationMode: 'bwrap',
      codexHomeDir: path.join(tempRoot, 'instance-home'),
    });

    expect(spec.args).toContain(shellPath);
    const shellEnvIndex = spec.args.indexOf('SHELL');
    expect(shellEnvIndex).toBeGreaterThan(-1);
    expect(spec.args[shellEnvIndex + 1]).toBe(shellPath);
    expect(spec.env.SHELL).toBe(shellPath);
  });

  it('uses the current node executable inside bubblewrap for node-shebang codex scripts', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-script-bwrap-'));
    const codexScript = path.join(tempRoot, 'bin', 'codex.js');
    const workspaceDir = path.join(tempRoot, 'workspace');
    fs.mkdirSync(path.dirname(codexScript), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(codexScript, '#!/usr/bin/env node\nconsole.log("ok");\n', { mode: 0o755 });

    const spec = buildCodexSpawnSpec({
      codexBin: codexScript,
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: { HOME: '/root', PATH: '/usr/bin:/bin' },
      isolationMode: 'bwrap',
      codexHomeDir: path.join(tempRoot, 'instance-home'),
    });

    const commandIndex = spec.args.lastIndexOf(process.execPath);
    expect(spec.args[commandIndex]).toBe(process.execPath);
    expect(spec.args[commandIndex + 1]).toBe(codexScript);
  });

  it('sets XDG data home for isolated opencode runs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bwrap-xdg-data-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const spec = buildCodexSpawnSpec({
      provider: 'opencode',
      codexBin: '/usr/bin/opencode',
      args: ['run', '--format', 'json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.env.XDG_DATA_HOME).toBe(`${workspaceDir}/.codex-runtime/home/.local/share`);
    const dataHomeIndex = spec.args.indexOf('XDG_DATA_HOME');
    expect(dataHomeIndex).toBeGreaterThan(-1);
    expect(spec.args[dataHomeIndex + 1]).toBe('/workspace/.codex-runtime/home/.local/share');
  });

  it('preserves nested workdir paths inside the mounted workspace', () => {
    const workspaceDir = '/tmp/agent-bwrap-nested';
    const nestedDir = '/tmp/agent-bwrap-nested/sub/task';
    fs.mkdirSync(nestedDir, { recursive: true });

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['--cd', nestedDir, 'exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: { HOME: '/root', PATH: '/usr/bin:/bin' },
      isolationMode: 'bwrap',
      codexHomeDir: '/tmp/instance-home-bwrap-nested',
    });

    const cdIndex = spec.args.indexOf('--cd');
    expect(cdIndex).toBeGreaterThan(-1);
    expect(spec.args[cdIndex + 1]).toBe('/workspace/sub/task');
  });

  it('syncs instance codex auth into workspace runtime home for bwrap runs', () => {
    const instanceHome = '/tmp/instance-home-sync';
    const workspaceDir = '/tmp/agent-bwrap-sync';
    const authFile = `${instanceHome}/auth.json`;
    const configFile = `${instanceHome}/config.toml`;
    const runtimeAuthFile = `${workspaceDir}/.codex-runtime/home/auth.json`;
    const runtimeConfigFile = `${workspaceDir}/.codex-runtime/home/config.toml`;

    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(authFile, '{"token":"abc"}');
    fs.writeFileSync(configFile, 'model = "gpt-5"');

    buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: { HOME: '/root', PATH: '/usr/bin:/bin' },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(fs.readFileSync(runtimeAuthFile, 'utf8')).toBe('{"token":"abc"}');
    expect(fs.readFileSync(runtimeConfigFile, 'utf8')).toBe('model = "gpt-5"');
  });

  it('syncs managed global skills into the canonical Codex runtime skill root for bwrap runs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-global-skills-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const homeAgentsSkillFile = path.join(
      instanceHome,
      '.agents',
      'skills',
      'using-superpowers',
      'SKILL.md',
    );
    const homeCodexSkillFile = path.join(
      instanceHome,
      '.codex',
      'skills',
      'playwright',
      'SKILL.md',
    );
    const runtimeAgentsSkillFile = path.join(
      workspaceDir,
      '.codex-runtime',
      'home',
      '.codex',
      'skills',
      'using-superpowers',
      'SKILL.md',
    );
    const runtimeCodexSkillFile = path.join(
      workspaceDir,
      '.codex-runtime',
      'home',
      '.codex',
      'skills',
      'playwright',
      'SKILL.md',
    );

    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.dirname(homeAgentsSkillFile), { recursive: true });
    fs.mkdirSync(path.dirname(homeCodexSkillFile), { recursive: true });
    fs.writeFileSync(homeAgentsSkillFile, 'name: using-superpowers\n', 'utf8');
    fs.writeFileSync(homeCodexSkillFile, 'name: playwright\n', 'utf8');

    buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(fs.readFileSync(runtimeAgentsSkillFile, 'utf8')).toBe('name: using-superpowers\n');
    expect(fs.readFileSync(runtimeCodexSkillFile, 'utf8')).toBe('name: playwright\n');
    expect(fs.existsSync(path.join(workspaceDir, '.codex-runtime', 'home', '.agents', 'skills'))).toBe(false);
  });

  it('applies disabled skill policy to runtime global syncs and workspace-local skill mounts', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-skill-policy-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const enabledGlobalSkillFile = path.join(instanceHome, '.codex', 'skills', 'global-on', 'SKILL.md');
    const disabledGlobalSkillFile = path.join(instanceHome, '.codex', 'skills', 'global-off-dir', 'SKILL.md');
    const disabledCodexLocalSkillFile = path.join(workspaceDir, '.codex', 'skills', 'local-off-dir', 'SKILL.md');
    const disabledAgentsLocalSkillFile = path.join(workspaceDir, '.agents', 'skills', 'legacy-off-dir', 'SKILL.md');

    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(path.dirname(enabledGlobalSkillFile), { recursive: true });
    fs.mkdirSync(path.dirname(disabledGlobalSkillFile), { recursive: true });
    fs.mkdirSync(path.dirname(disabledCodexLocalSkillFile), { recursive: true });
    fs.mkdirSync(path.dirname(disabledAgentsLocalSkillFile), { recursive: true });
    fs.writeFileSync(enabledGlobalSkillFile, ['---', 'name: global-on', '---', ''].join('\n'), 'utf8');
    fs.writeFileSync(disabledGlobalSkillFile, ['---', 'name: global-off', '---', ''].join('\n'), 'utf8');
    fs.writeFileSync(disabledCodexLocalSkillFile, ['---', 'name: local-off', '---', ''].join('\n'), 'utf8');
    fs.writeFileSync(disabledAgentsLocalSkillFile, ['---', 'name: legacy-off', '---', ''].join('\n'), 'utf8');

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
      skillPolicy: {
        disabledGlobalSkills: ['global-off'],
        disabledAgentSkills: ['local-off', 'legacy-off'],
      },
    });

    expect(fs.existsSync(path.join(
      workspaceDir,
      '.codex-runtime',
      'home',
      '.codex',
      'skills',
      'global-on',
      'SKILL.md',
    ))).toBe(true);
    expect(fs.existsSync(path.join(
      workspaceDir,
      '.codex-runtime',
      'home',
      '.codex',
      'skills',
      'global-off-dir',
      'SKILL.md',
    ))).toBe(false);
    expect(spec.args).toEqual(expect.arrayContaining([
      '--tmpfs',
      '/workspace/.codex/skills/local-off-dir',
      '--tmpfs',
      '/workspace/.agents/skills/legacy-off-dir',
    ]));
  });

  it('propagates FEISHU env vars into isolated runs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-feishu-env-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
        FEISHU_ENABLED: 'true',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'sec_test',
        FEISHU_DOC_BASE_URL: 'https://example.feishu.cn/docx',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.env.FEISHU_ENABLED).toBe('true');
    expect(spec.env.FEISHU_APP_ID).toBe('cli_test');
    expect(spec.env.FEISHU_APP_SECRET).toBe('sec_test');
    expect(spec.env.FEISHU_DOC_BASE_URL).toBe('https://example.feishu.cn/docx');
  });

  it('propagates GATEWAY env vars into isolated runs', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-gateway-env-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
        GATEWAY_BROWSER_API_BASE: 'http://127.0.0.1:3000/internal/browser',
        GATEWAY_INTERNAL_API_TOKEN: 'token-123',
        GATEWAY_REMINDER_DB_PATH: '/tmp/reminders.db',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.env.GATEWAY_BROWSER_API_BASE).toBe('http://127.0.0.1:3000/internal/browser');
    expect(spec.env.GATEWAY_DESKTOP_API_BASE).toBeUndefined();
    expect(spec.env.GATEWAY_INTERNAL_API_TOKEN).toBe('token-123');
    expect(spec.env.GATEWAY_REMINDER_DB_PATH).toBe('/tmp/reminders.db');
  });

  it('mounts absolute cli bin and its symlink target into bwrap', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-bin-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const realBinDir = path.join(hostHome, '.opencode', 'bin');
    const linkBinDir = path.join(hostHome, '.local', 'bin');
    const realBin = path.join(realBinDir, 'opencode');
    const linkBin = path.join(linkBinDir, 'opencode');

    fs.mkdirSync(realBinDir, { recursive: true });
    fs.mkdirSync(linkBinDir, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(realBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(realBin, 0o755);
    fs.symlinkSync(realBin, linkBin);
    const resolvedRealBin = fs.realpathSync(linkBin);

    const spec = buildCodexSpawnSpec({
      provider: 'opencode',
      codexBin: linkBin,
      args: ['run', '--format', 'json', 'hello'],
      cwd: workspaceDir,
      env: { HOME: hostHome, PATH: '/usr/bin:/bin' },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.args).toContain(linkBin);
    expect(spec.args).toContain(resolvedRealBin);
    expect(spec.args).toContain('--ro-bind');
  });

  it('bridges gateway root node_modules into isolated runs for skill scripts', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-gateway-root-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const gatewayRootDir = path.join(tempRoot, 'gateway-root');
    const nodeModulesDir = path.join(gatewayRootDir, 'node_modules');

    fs.mkdirSync(hostHome, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
        GATEWAY_ROOT_DIR: gatewayRootDir,
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.args).toContain(nodeModulesDir);
    expect(spec.args).toContain('/workspace/.codex-runtime/gateway-root/node_modules');
    expect(spec.env.NODE_PATH).toBe('/workspace/.codex-runtime/gateway-root/node_modules');
  });

  it('bridges host git and ssh config into isolated runtime home', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-host-home-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(path.join(hostHome, '.ssh'), { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(hostHome, '.gitconfig'), '[safe]\n\tdirectory = /repo\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'agentclaw-deploy'), 'PRIVATE KEY\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'config'), 'Host github\n  HostName github.com\n  IdentityFile ~/.ssh/agentclaw-deploy\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAA\n', 'utf8');

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.args).toContain(path.join(hostHome, '.gitconfig'));
    expect(spec.args).toContain('/workspace/.codex-runtime/home/.gitconfig');
    expect(spec.args).toContain(path.join(hostHome, '.ssh', 'config'));
    expect(spec.args).toContain('/workspace/.codex-runtime/home/.ssh/config');
    expect(spec.args).toContain(path.join(hostHome, '.ssh', 'known_hosts'));
    expect(spec.args).toContain('/workspace/.codex-runtime/home/.ssh/known_hosts');
    expect(spec.args).toContain(path.join(hostHome, '.ssh', 'agentclaw-deploy'));
    expect(spec.args).toContain('/workspace/.codex-runtime/home/.ssh/agentclaw-deploy');
    expect(fs.readFileSync(path.join(workspaceDir, '.codex-runtime', 'home', '.ssh', 'config'), 'utf8')).toContain('Host github');
    expect(fs.readFileSync(path.join(workspaceDir, '.codex-runtime', 'home', '.ssh', 'known_hosts'), 'utf8')).toContain('github.com');
    expect(fs.readFileSync(path.join(workspaceDir, '.codex-runtime', 'home', '.ssh', 'agentclaw-deploy'), 'utf8')).toBe('PRIVATE KEY\n');
  });

  it('prefers the explicit host HOME when codexHomeDir overrides child HOME', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-explicit-host-home-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(path.join(hostHome, '.ssh'), { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(hostHome, '.gitconfig'), '[user]\n\tname = baibairui\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'config'), 'Host github.com\n  HostName github.com\n  IdentityFile ~/.ssh/id_ed25519\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAA\n', 'utf8');

    buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: instanceHome,
        CODEX_WORKDIR_ISOLATION_HOST_HOME: hostHome,
        PATH: '/usr/bin:/bin',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(fs.readFileSync(path.join(workspaceDir, '.codex-runtime', 'home', '.gitconfig'), 'utf8')).toContain('name = baibairui');
    expect(fs.readFileSync(path.join(workspaceDir, '.codex-runtime', 'home', '.ssh', 'config'), 'utf8')).toContain('IdentityFile ~/.ssh/id_ed25519');
    expect(fs.readFileSync(path.join(workspaceDir, '.codex-runtime', 'home', '.ssh', 'id_ed25519'), 'utf8')).toBe('PRIVATE KEY\n');
  });

  it('removes stale repo-level core.sshCommand that points at old runtime ssh paths', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-stale-git-ssh-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const repoDir = path.join(workspaceDir, 'fyp-backend');

    fs.mkdirSync(path.join(hostHome, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(instanceHome), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(hostHome, '.ssh', 'config'), 'Host github-fyp\n  HostName github.com\n  IdentityFile ~/.ssh/id_ed25519\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n', 'utf8');
    fs.writeFileSync(path.join(hostHome, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAA\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.git', 'config'), [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tfilemode = true',
      '\tbare = false',
      '\tlogallrefupdates = true',
      '\tsshCommand = ssh -i /workspace/.codex-runtime/home/.ssh/codex-gateway-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/workspace/.codex-runtime/home/.ssh/known_hosts',
      '[remote "origin"]',
      '\turl = git@github-fyp:baibairui/fyp.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '',
    ].join('\n'), 'utf8');

    buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    const config = fs.readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
    expect(config).not.toContain('codex-gateway-deploy');
    expect(config).not.toContain('UserKnownHostsFile=/workspace/.codex-runtime/home/.ssh/known_hosts');
  });

  it('bridges extra home-relative config paths into isolated runtime home', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-extra-read-'));
    const hostHome = path.join(tempRoot, 'host-home');
    const workspaceDir = path.join(tempRoot, 'workspace');
    const instanceHome = path.join(tempRoot, 'instance-home');
    const vpnDir = path.join(hostHome, '.config', 'mihomo');

    fs.mkdirSync(vpnDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(instanceHome, { recursive: true });
    fs.writeFileSync(path.join(vpnDir, 'config.yaml'), 'mixed-port: 7890\n', 'utf8');

    const spec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: hostHome,
        PATH: '/usr/bin:/bin',
        CODEX_WORKDIR_ISOLATION_EXTRA_READS: '~/.config/mihomo',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(spec.args).toContain(vpnDir);
    expect(spec.args).toContain('/workspace/.codex-runtime/home/.config/mihomo');
  });

  it('removes stale runtime auth files when instance codex home no longer has them', () => {
    const instanceHome = '/tmp/instance-home-prune';
    const workspaceDir = '/tmp/agent-bwrap-prune';
    const runtimeAuthFile = `${workspaceDir}/.codex-runtime/home/auth.json`;

    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceHome, 'auth.json'), '{"token":"abc"}');

    buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: { HOME: '/root', PATH: '/usr/bin:/bin' },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });
    expect(fs.existsSync(runtimeAuthFile)).toBe(true);

    fs.rmSync(path.join(instanceHome, 'auth.json'), { force: true });
    buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: { HOME: '/root', PATH: '/usr/bin:/bin' },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(fs.existsSync(runtimeAuthFile)).toBe(false);
  });

  it('prefers codex-home config over OPENAI_BASE_URL env when config.toml exists', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-config-priority-'));
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceHome, 'config.toml'), 'model = "gpt-5-codex"\n');

    const directSpec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: '/root',
        PATH: '/usr/bin:/bin',
        OPENAI_BASE_URL: 'https://env.example/v1',
      },
      isolationMode: 'off',
      codexHomeDir: instanceHome,
    });

    expect(directSpec.env.OPENAI_BASE_URL).toBeUndefined();

    const isolatedSpec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: '/root',
        PATH: '/usr/bin:/bin',
        OPENAI_BASE_URL: 'https://env.example/v1',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(isolatedSpec.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it('prefers codex-home auth over OPENAI_API_KEY env when auth.json exists', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bwrap-auth-priority-'));
    const instanceHome = path.join(tempRoot, 'instance-home');
    const workspaceDir = path.join(tempRoot, 'workspace');

    fs.mkdirSync(instanceHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceHome, 'auth.json'), '{"OPENAI_API_KEY":"from-file"}\n');

    const directSpec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: '/root',
        PATH: '/usr/bin:/bin',
        OPENAI_API_KEY: 'from-env',
      },
      isolationMode: 'off',
      codexHomeDir: instanceHome,
    });

    expect(directSpec.env.OPENAI_API_KEY).toBeUndefined();

    const isolatedSpec = buildCodexSpawnSpec({
      codexBin: '/usr/bin/codex',
      args: ['exec', '--json', 'hello'],
      cwd: workspaceDir,
      env: {
        HOME: '/root',
        PATH: '/usr/bin:/bin',
        OPENAI_API_KEY: 'from-env',
      },
      isolationMode: 'bwrap',
      codexHomeDir: instanceHome,
    });

    expect(isolatedSpec.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('CodexRunner opencode config repair', () => {
  it('repairs legacy opencode config before spawning run', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-repair-'));
    const opencodeHome = path.join(tempRoot, 'opencode-home');
    const opencodeBin = path.join(tempRoot, 'bin', 'opencode');
    const configDir = path.join(opencodeHome, '.config', 'opencode');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeBin), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        gateway: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Gateway',
          options: {
            baseURL: 'https://codex.ai02.cn/v1',
            apiKey: 'sk-test',
          },
        },
      },
      model: 'gateway/gpt-5.2',
    }, null, 2));

    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValueOnce(child as never);

    const runner = new CodexRunner({
      provider: 'opencode',
      codexBin: opencodeBin,
      codexHomeDir: opencodeHome,
      timeoutMs: 1_000,
    });

    const resultPromise = runner.runForSystem({ prompt: 'hello' });
    child.stdout.write(`${JSON.stringify({ type: 'text', sessionID: 'sess_123', text: 'ok' })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({
      threadId: 'sess_123',
      rawOutput: `${JSON.stringify({ type: 'text', sessionID: 'sess_123', text: 'ok' })}\n`,
    });

    const repaired = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      provider?: { gateway?: { models?: Record<string, unknown> } };
    };
    expect(repaired.provider?.gateway?.models).toEqual({
      'gpt-5.2': {},
    });
  });
});

describe('CodexRunner', () => {
  it('rejects agent runs without an explicit workspaceDir', async () => {
    vi.mocked(spawn).mockReset();
    const runner = new CodexRunner({
      codexBin: 'codex',
      workdir: '/tmp/agents-root',
    });

    expect(() => runner.run({
      prompt: 'hello',
    })).toThrow(/requires an explicit agent workspaceDir/i);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects agent reviews without an explicit workspaceDir', async () => {
    vi.mocked(spawn).mockReset();
    const runner = new CodexRunner({
      codexBin: 'codex',
      workdir: '/tmp/agents-root',
    });

    expect(() => runner.review({
      mode: 'uncommitted',
    })).toThrow(/requires an explicit agent workspaceDir/i);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('allows system runs to inherit the configured global workdir', async () => {
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const codexScript = createMockCodexExecutable('codex-system-run-');

    const runner = new CodexRunner({
      codexBin: codexScript,
      workdir: '/tmp/agents-root',
      timeoutMs: 50,
    });

    const runPromise = runner.runForSystem({
      prompt: 'hello',
      search: true,
    });

    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread_system' })}\n`);
    child.emit('close', 0);

    await expect(runPromise).resolves.toEqual({
      threadId: 'thread_system',
      rawOutput: `${JSON.stringify({ type: 'thread.started', thread_id: 'thread_system' })}\n`,
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cwd: '/tmp/agents-root' }),
    );
  });

  it('fails before spawn when the configured codex binary is unavailable', async () => {
    vi.mocked(spawn).mockReset();
    const runner = new CodexRunner({
      codexBin: '/definitely/missing/codex',
      workdir: '/tmp/agent-a',
    });

    await expect(runner.run({
      prompt: 'hello',
      workdir: '/tmp/agent-a',
      search: true,
    })).rejects.toThrow(/codex executable not found/i);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not kill an active run when stdout activity keeps arriving before the idle timeout', async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const codexScript = createMockCodexExecutable('codex-active-timeout-');

    const runner = new CodexRunner({
      codexBin: codexScript,
      workdir: '/tmp/agent-active-timeout',
      timeoutMs: 50,
    });

    const runPromise = runner.run({
      prompt: 'hello',
      workdir: '/tmp/agent-active-timeout',
      search: true,
      onMessage: vi.fn(),
    });

    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread_active' })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40);

    child.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'still working' },
    })}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40);

    child.emit('close', 0);

    await expect(runPromise).resolves.toEqual({
      threadId: 'thread_active',
      rawOutput: [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread_active' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'still working' } }),
        '',
      ].join('\n'),
    });
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
