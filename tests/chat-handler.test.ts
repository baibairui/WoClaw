import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createChatHandler } from '../src/services/chat-handler.js';
import { buildFeishuRunCardMessage } from '../src/services/feishu-command-cards.js';

type FeishuCardElement = Record<string, unknown>;
type FeishuCardButton = {
  tag?: string;
  type?: string;
  text?: { content?: string };
  value?: Record<string, unknown>;
  multi_url?: { url?: string };
};

function getFeishuCardElements(payload: string): FeishuCardElement[] {
  const parsed = JSON.parse(payload) as {
    content?: {
      schema?: string;
      body?: {
        elements?: FeishuCardElement[];
      };
    };
  };
  expect(parsed.content?.schema).toBe('2.0');
  return parsed.content?.body?.elements ?? [];
}

function getFeishuCardHeaderTitle(payload: string): string | undefined {
  const parsed = JSON.parse(payload) as {
    content?: {
      header?: {
        title?: {
          content?: string;
        };
      };
    };
  };
  return parsed.content?.header?.title?.content;
}

function extractFeishuButtons(elements: FeishuCardElement[]): FeishuCardButton[] {
  return elements.flatMap((item) => {
    if (item.tag === 'button') {
      return [item as FeishuCardButton];
    }
    if (item.tag === 'form') {
      return extractFeishuButtons(Array.isArray(item.elements) ? item.elements as FeishuCardElement[] : []);
    }
    if (item.tag === 'column_set') {
      const columns = Array.isArray(item.columns) ? item.columns as FeishuCardElement[] : [];
      return columns.flatMap((column) => extractFeishuButtons(Array.isArray(column.elements) ? column.elements as FeishuCardElement[] : []));
    }
    return [];
  });
}

function createSessionStore() {
  const currentAgent = new Map<string, string>();
  const threads = new Map<string, string>();
  const modelOverrides = new Map<string, string>();
  const providerOverrides = new Map<string, 'codex' | 'opencode'>();
  const activities: Array<{ threadId: string; role: 'user' | 'assistant'; text?: string }> = [];
  const agents = new Map<string, Array<{
    agentId: string;
    name: string;
    workspaceDir: string;
    createdAt: number;
    updatedAt: number;
    current: boolean;
    isDefault: boolean;
  }>>();

  function ensureAgents(userId: string) {
    if (!agents.has(userId)) {
      agents.set(userId, [
        {
          agentId: 'default',
          name: '默认Agent',
          workspaceDir: '/repo/default',
          createdAt: 0,
          updatedAt: 0,
          current: true,
          isDefault: true,
        },
      ]);
    }
    return agents.get(userId)!;
  }

  return {
    getCurrentAgent(userId: string) {
      const list = ensureAgents(userId);
      const agentId = currentAgent.get(userId) ?? 'default';
      return list.find((item) => item.agentId === agentId) ?? list[0]!;
    },
    listAgents(userId: string) {
      const list = ensureAgents(userId);
      const agentId = currentAgent.get(userId) ?? 'default';
      return list.map((item) => ({ ...item, current: item.agentId === agentId }));
    },
    createAgent(userId: string, input: { agentId: string; name: string; workspaceDir: string }) {
      const list = ensureAgents(userId);
      const record = {
        agentId: input.agentId,
        name: input.name,
        workspaceDir: input.workspaceDir,
        createdAt: 1,
        updatedAt: 1,
        current: false,
        isDefault: false,
      };
      list.push(record);
      return record;
    },
    setCurrentAgent(userId: string, agentId: string) {
      currentAgent.set(userId, agentId);
      return true;
    },
    resolveAgentTarget(userId: string, target: string) {
      const list = ensureAgents(userId);
      if (/^\d+$/.test(target)) {
        return list[Number(target) - 1]?.agentId;
      }
      return list.find((item) => item.agentId === target)?.agentId;
    },
    getSession(userId: string, agentId: string) {
      return threads.get(`${userId}:${agentId}`);
    },
    setSession(userId: string, agentId: string, threadId: string) {
      threads.set(`${userId}:${agentId}`, threadId);
    },
    clearSession(userId: string, agentId: string) {
      return threads.delete(`${userId}:${agentId}`);
    },
    getModelOverride(userId: string, agentId: string) {
      return modelOverrides.get(`${userId}:${agentId}`);
    },
    setModelOverride(userId: string, agentId: string, model: string) {
      modelOverrides.set(`${userId}:${agentId}`, model);
    },
    clearModelOverride(userId: string, agentId: string) {
      return modelOverrides.delete(`${userId}:${agentId}`);
    },
    getProviderOverride(userId: string, agentId: string) {
      return providerOverrides.get(`${userId}:${agentId}`);
    },
    setProviderOverride(userId: string, agentId: string, provider: 'codex' | 'opencode') {
      providerOverrides.set(`${userId}:${agentId}`, provider);
    },
    clearProviderOverride(userId: string, agentId: string) {
      return providerOverrides.delete(`${userId}:${agentId}`);
    },
    listDetailed() {
      return [];
    },
    resolveSwitchTarget(_userId: string, _agentId: string, target: string) {
      return target;
    },
    renameSession() {
      return true;
    },
    recordSessionActivity(threadId: string, input: { role: 'user' | 'assistant'; text?: string }) {
      activities.push({ threadId, role: input.role, text: input.text });
    },
    __activities: activities,
  };
}

async function withMockModelsCache(
  payload: { fetched_at: string; models: Array<{ slug: string; visibility: string; supported_in_api: boolean }> },
  run: () => Promise<void>,
) {
  const cacheDir = path.join(os.homedir(), '.codex');
  const cachePath = path.join(cacheDir, 'models_cache.json');
  const hadOriginal = fs.existsSync(cachePath);
  const original = hadOriginal ? fs.readFileSync(cachePath, 'utf8') : '';
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(payload));
  try {
    await run();
  } finally {
    if (hadOriginal) {
      fs.writeFileSync(cachePath, original);
    } else {
      fs.rmSync(cachePath, { force: true });
    }
  }
}

describe('createChatHandler', () => {
  it('renders a feishu run card with stop button while running', () => {
    const payload = buildFeishuRunCardMessage({
      runId: 'run_1',
      agentName: '默认助手',
      provider: 'codex',
      status: 'running',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    const elements = getFeishuCardElements(payload);
    const buttons = extractFeishuButtons(elements);
    const stopButton = buttons.find((button) => button.value?.gateway_cmd === '/run stop run_1');
    const parsed = JSON.parse(payload) as {
      content?: {
        header?: {
          template?: string;
        };
      };
    };
    expect(getFeishuCardHeaderTitle(payload)).toBe('处理中');
    expect(parsed.content?.header?.template).toBe('turquoise');
    expect(stopButton?.text?.content).toBe('停止本次任务');
    expect(stopButton?.type).toBe('danger');
    const serialized = JSON.stringify(elements);
    expect(serialized).toContain('**当前阶段**');
    expect(serialized).toContain('**下一步**');
    expect(serialized).toContain('正在为你处理当前请求');
    expect(serialized).not.toContain('Agent');
    expect(serialized).not.toContain('框架');
    expect(serialized).not.toContain('Run ID');
    expect(serialized).not.toContain('开始时间');
    expect(serialized).not.toContain('最近活动');
    expect(serialized).not.toContain('Thread');
  });

  it('builds feishu run cards with update_multi enabled', () => {
    const payload = buildFeishuRunCardMessage({
      runId: 'run_1',
      agentName: '默认助手',
      provider: 'codex',
      status: 'running',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    const parsed = JSON.parse(payload) as {
      content?: {
        config?: {
          update_multi?: boolean;
        };
      };
    };
    expect(parsed.content?.config?.update_multi).toBe(true);
  });

  it('renders a completed feishu run card with useful next actions', () => {
    const payload = buildFeishuRunCardMessage({
      runId: 'run_1',
      agentName: '默认助手',
      provider: 'codex',
      status: 'completed',
      startedAt: Date.now() - 30_000,
      lastActivityAt: Date.now(),
      threadId: 'thread_1',
    });
    const elements = getFeishuCardElements(payload);
    const buttons = extractFeishuButtons(elements);
    const serialized = JSON.stringify(elements);

    expect(serialized).toContain('已处理完成');
    expect(buttons.some((button) => button.text?.content === '查看会话' && button.value?.gateway_cmd === '/session')).toBe(true);
    expect(buttons.some((button) => button.text?.content === '查看目标' && button.value?.gateway_cmd === '/goal')).toBe(true);
  });

  it('keeps sessions isolated per real user id', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const run = vi
      .fn(async (input: { threadId?: string; onMessage?: (text: string) => void }) => {
        input.onMessage?.('ok');
        return {
          threadId: input.threadId ?? `thread_${run.mock.calls.length}`,
          rawOutput: '',
        };
      });
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });
    await handler({ channel: 'wecom', userId: 'u2', content: 'hello' });

    expect(sessionStore.getSession('u1', 'default')).toBe('thread_1');
    expect(sessionStore.getSession('u2', 'default')).toBe('thread_2');
  });

  it('prefers resolved default model over service fallback when no session override exists', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const run = vi.fn(async () => ({ threadId: 'thread_1', rawOutput: '' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'service-fallback-model',
      resolveDefaultModel: () => 'user-config-model',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      model: 'user-config-model',
    }));
  });

  it('uses ensured default workspace for the built-in default agent', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const run = vi.fn(async () => ({ threadId: 'thread_default_ws', rawOutput: '' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        ensureDefaultWorkspace: () => ({ agentId: 'default', workspaceDir: '/tmp/user-default' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workdir: '/tmp/user-default',
    }));
  });

  it('repairs a missing custom agent workspace before running', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'test',
      name: '测试Agent',
      workspaceDir: '/tmp/missing-agent-workspace',
    });
    sessionStore.setCurrentAgent('u1', 'test');
    const run = vi.fn(async () => ({ threadId: 'thread_custom_ws', rawOutput: '' }));
    const repairWorkspaceScaffold = vi.fn(() => undefined);

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        ensureDefaultWorkspace: () => ({ agentId: 'default', workspaceDir: '/tmp/user-default' }),
        repairWorkspaceScaffold,
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(repairWorkspaceScaffold).toHaveBeenCalledWith('/tmp/missing-agent-workspace');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workdir: '/tmp/missing-agent-workspace',
    }));
  });

  it('runs agent again when reminder trigger arrives', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'test',
      name: '测试Agent',
      workspaceDir: '/tmp/test',
    });
    const run = vi.fn(async (input: {
      prompt: string;
      onMessage?: (text: string) => void;
      workdir?: string;
    }) => {
      input.onMessage?.('提醒时间到了，我来继续跟进。');
      return { threadId: 'thread_reminder', rawOutput: '' };
    });
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({
      channel: 'wecom',
      userId: 'u1',
      content: '喝水',
      reminderTrigger: {
        reminderId: 'r1',
        message: '喝水',
        sourceAgentId: 'test',
      },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workdir: '/tmp/test',
      search: false,
      reminderToolContext: expect.objectContaining({
        channel: 'wecom',
        userId: 'u1',
        agentId: 'test',
      }),
    }));
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '测试Agent ·\n提醒时间到了，我来继续跟进。');
    expect(sessionStore.getSession('u1', 'test')).toBe('thread_reminder');
  });

  it('does not hijack /help when an opencode auth session exists but is not waiting for manual input', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: vi.fn(async () => ({ threadId: 'thread_1', rawOutput: '' })),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      openCodeAuthFlowManager: {
        has: () => true,
        isAwaitingInput: () => false,
        stop: vi.fn(() => true),
        sendInput: vi.fn(async () => true),
      },
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/help' });

    expect(sendText).not.toHaveBeenCalledWith('feishu', 'u1', '已收到，正在继续处理授权流程。');
    expect(sendText).toHaveBeenCalled();
    const helpPayload = String(sendText.mock.calls.at(-1)?.[2] ?? '');
    expect(helpPayload).toContain('命令帮助');
  });

  it('sends a visible error message when codex run fails', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => {
          throw new Error('boom');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '❌ 这次处理没完成，请稍后重试。');
    expect(sessionStore.getSession('u1', 'default')).toBeUndefined();
  });

  it('renders actionable feishu recovery actions when codex run fails', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => {
          throw new Error('boom');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: 'hello' });

    const payload = String(sendText.mock.calls.at(-1)?.[2] ?? '');
    const buttons = extractFeishuButtons(getFeishuCardElements(payload));

    expect(payload).toContain('这次处理没完成');
    expect(buttons.some((button) => button.text?.content === '查看帮助' && button.value?.gateway_cmd === '/help')).toBe(true);
    expect(buttons.some((button) => button.text?.content === '登录授权' && button.value?.gateway_cmd === '/login')).toBe(true);
    expect(buttons.some((button) => button.text?.content === '当前会话' && button.value?.gateway_cmd === '/session')).toBe(true);
    expect(sessionStore.getSession('u1', 'default')).toBeUndefined();
  });

  it('passes current agent skill policy into codex runs', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const run = vi.fn(async () => ({ threadId: 'thread_policy', rawOutput: '' }));
    const skillManager = {
      listEffectiveSkills: vi.fn(() => []),
      listGlobalSkills: vi.fn(() => []),
      listAgentLocalSkills: vi.fn(() => []),
      disableGlobalSkill: vi.fn(() => ({ ok: true })),
      enableGlobalSkill: vi.fn(() => ({ ok: true })),
      disableAgentSkill: vi.fn(() => ({ ok: true })),
      getPolicy: vi.fn(() => ({
        disabledGlobalSkills: ['using-superpowers'],
        disabledAgentSkills: ['reminder-tool'],
      })),
    };
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      skillManager,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(skillManager.getPolicy).toHaveBeenCalledWith('/repo/default');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      skillPolicy: {
        disabledGlobalSkills: ['using-superpowers'],
        disabledAgentSkills: ['reminder-tool'],
      },
    }));
  });

  it('passes /goal to Codex as a native slash command and persists the resulting thread', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const run = vi.fn(async (input: { prompt: string; onMessage?: (text: string) => void }) => {
      input.onMessage?.('✅ 已更新 Codex 目标：improve benchmark coverage');
      return {
        threadId: 'thread_goal',
        rawOutput: '',
      };
    });
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/goal improve benchmark coverage' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '/goal improve benchmark coverage',
      threadId: undefined,
      model: 'gpt-5-codex',
      workdir: '/repo/default',
    }));
    expect(sessionStore.getSession('u1', 'default')).toBe('thread_goal');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('已更新 Codex 目标'));
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('improve benchmark coverage'));
  });

  it('does not expose raw timeout errors after partial agent output', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input) => {
          input.onMessage?.('先给你一个阶段性结论。');
          throw new Error('codex timeout after 1000ms');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '默认助手 ·\n先给你一个阶段性结论。');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '默认助手 ·\n⚠️ 本次回复中断了，你可以直接回复“继续”让我接着处理。');
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('codex timeout after'))).toBe(false);
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('❌ 请求执行失败'))).toBe(false);
  });

  it('treats non-timeout failures after partial agent output as interruptions', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input) => {
          input.onMessage?.('先给你一个阶段性结论。');
          throw new Error('boom-after-output');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '默认助手 ·\n先给你一个阶段性结论。');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '默认助手 ·\n⚠️ 本次回复中断了，你可以直接回复“继续”让我接着处理。');
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('❌ 这次处理没完成'))).toBe(false);
  });

  it('shows login guidance when the active model channel is misconfigured', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => {
          throw new Error('invalid api_key');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '⚠️ 当前模型通道暂时不可用。请先发送 /login，或联系管理员检查配置。');
  });

  it('shows a retry-later hint when the execution environment cannot start', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => {
          throw new Error('spawn codex ENOENT');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '⚠️ 执行环境暂时不可用，请稍后重试。');
  });

  it('persists a new session as soon as thread.started is observed', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input) => {
          input.onThreadStarted?.('thread_started_1');
          throw new Error('boom-after-thread');
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sessionStore.getSession('u1', 'default')).toBe('thread_started_1');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '❌ 这次处理没完成，请稍后重试。');
  });

  it('sends ack when receiving normalized non-text inbound message', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 't1', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '[飞书图片] image_key=img_xxx' });

    expect(sendText).toHaveBeenCalledWith('feishu', 'u1', '✅ 已收到飞书图片消息，正在分析处理。');
    expect(run).toHaveBeenCalled();
  });

  it('does not send ack when receiving normalized feishu rich text inbound message', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 't1', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '[飞书富文本]\n1. 第一项\n2. 第二项' });

    expect(sendText).not.toHaveBeenCalledWith('feishu', 'u1', '✅ 已收到飞书富文本消息，正在分析处理。');
    expect(run).toHaveBeenCalled();
  });

  it('does not send ack when receiving normalized feishu post message with metadata', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 't1', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: '[飞书富文本]\n1. 第一项\n[飞书消息元数据]\nfeishu_message_type=post',
    });

    expect(sendText).not.toHaveBeenCalledWith('feishu', 'u1', '✅ 已收到飞书富文本消息，正在分析处理。');
    expect(run).toHaveBeenCalled();
  });

  it('prefixes plain agent replies with the current agent name', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input) => {
          input.onMessage?.('你好，我来处理。');
          return { threadId: 'thread_existing', rawOutput: '' };
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '默认助手 ·\n你好，我来处理。');
  });

  it('keeps gateway structured replies unchanged when labeling agent output', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');
    const structured = '{"__gateway_message__":true,"msg_type":"post","content":"多段说明"}';
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input) => {
          input.onMessage?.(structured);
          return { threadId: 'thread_existing', rawOutput: '' };
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', structured);
  });

  it('rewrites sandbox local file paths in structured replies back to host workspace paths', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');
    const structured = '{"__gateway_message__":true,"msg_type":"image","content":{"local_image_path":"/workspace/out/result.png","caption":"done"}}';
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input) => {
          input.onMessage?.(structured);
          return { threadId: 'thread_existing', rawOutput: '' };
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith(
      'feishu',
      'u1',
      '{"__gateway_message__":true,"msg_type":"image","content":{"local_image_path":"/repo/default/out/result.png","caption":"done"}}',
    );
  });

  it('stages inbound local attachment paths into the current agent workspace before running codex', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-inbound-attachment-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const sourceDir = path.join(tempDir, 'gateway-cache');
    const sourcePath = path.join(sourceDir, 'sample.jpg');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('fake-image'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({ threadId: 'thread_1', rawOutput: '' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: `[飞书图片] image_key=img_v3_demo
message_id=om_1
[飞书附件元数据]
local_image_path=${sourcePath}`,
    });

    const runInput = run.mock.calls[0]?.[0];
    expect(runInput).toBeTruthy();
    const prompt = String(runInput?.prompt ?? '');
    expect(prompt).not.toContain(sourcePath);
    const match = prompt.match(/local_image_path=([^\n]+)/);
    expect(match?.[1]).toBeTruthy();
    expect(match?.[1]?.startsWith(workspaceDir)).toBe(true);
    expect(fs.readFileSync(match![1], 'utf8')).toBe('fake-image');
  });

  it('stages inbound image attachments when the source path contains spaces', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-inbound-image-space-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const sourceDir = path.join(tempDir, 'gateway cache');
    const sourcePath = path.join(sourceDir, 'sample image.png');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('fake-image-space'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({ threadId: 'thread_space_1', rawOutput: '' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: `[飞书图片] image_key=img_v3_demo
message_id=om_1
[飞书附件元数据]
local_image_path=${sourcePath}`,
    });

    const runInput = run.mock.calls[0]?.[0];
    expect(runInput).toBeTruthy();
    const prompt = String(runInput?.prompt ?? '');
    expect(prompt).not.toContain(sourcePath);
    const match = prompt.match(/local_image_path=([^\n]+)/);
    expect(match?.[1]).toBeTruthy();
    expect(match?.[1]?.startsWith(workspaceDir)).toBe(true);
    expect(fs.readFileSync(match![1], 'utf8')).toBe('fake-image-space');
  });

  it('uses transcript text as the effective query when speech service continues inbound audio', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-inbound-audio-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const sourceDir = path.join(tempDir, 'gateway-cache');
    const sourcePath = path.join(sourceDir, 'sample.ogg');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('fake-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({ threadId: 'thread_audio_1', rawOutput: '' }));
    const processInboundAudio = vi.fn(async () => ({
      type: 'continue' as const,
      prompt: '你好，帮我总结一下',
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      speechService: {
        processInboundAudio,
      },
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: `[飞书语音] file_key=file_1 duration=3200 file_name=voice.ogg mime_type=audio/ogg
message_id=om_1
[飞书附件元数据]
local_audio_path=${sourcePath}`,
    });

    expect(processInboundAudio).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'feishu',
      userId: 'u1',
      workspaceDir,
    }));

    const runInput = run.mock.calls[0]?.[0];
    const prompt = String(runInput?.prompt ?? '');
    expect(prompt).toContain('你好，帮我总结一下');
    expect(prompt).not.toContain('[语音输入转写]');
    expect(prompt).not.toContain(sourcePath);
  });

  it('replies immediately and skips codex when speech service returns a direct reply', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-inbound-audio-reply-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const sourceDir = path.join(tempDir, 'gateway-cache');
    const sourcePath = path.join(sourceDir, 'sample.ogg');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('fake-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({ threadId: 'thread_audio_1', rawOutput: '' }));
    const processInboundAudio = vi.fn(async () => ({
      type: 'reply' as const,
      message: '你好，帮我总结一下',
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      speechService: {
        processInboundAudio,
      },
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: `[飞书语音] file_key=file_1 duration=3200 file_name=voice.ogg mime_type=audio/ogg
message_id=om_1
[飞书附件元数据]
local_audio_path=${sourcePath}`,
    });

    expect(run).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('feishu', 'u1', '测试Agent ·\n你好，帮我总结一下');
  });

  it('sends a final weixin audio file reply after inbound audio', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-weixin-voice-reply-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const sourceDir = path.join(tempDir, 'gateway-cache');
    const sourcePath = path.join(sourceDir, 'sample.mp3');
    const synthesizedPath = path.join(workspaceDir, 'reply.mp3');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, Buffer.from('fake-audio'));
    fs.writeFileSync(synthesizedPath, Buffer.from('reply-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({
      threadId: 'thread_audio_2',
      rawOutput: `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '好的，我来总结一下今天的重点。',
        },
      })}\n`,
    }));
    const processInboundAudio = vi.fn(async () => ({
      type: 'continue' as const,
      prompt: '帮我总结今天重点',
    }));
    const synthesize = vi.fn(async () => ({
      filePath: synthesizedPath,
      mimeType: 'audio/mpeg',
      format: 'mp3' as const,
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      speechService: {
        processInboundAudio,
      },
      ttsService: {
        synthesize,
      },
    });

    await handler({
      channel: 'weixin',
      userId: 'u1',
      content: `[微信语音] duration=3200 mime_type=audio/mpeg
[微信附件元数据]
local_audio_path=${sourcePath}`,
    });

    expect(processInboundAudio).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith({
      text: '好的，我来总结一下今天的重点。',
      workspaceDir,
    });
    const lastCall = sendText.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('weixin');
    expect(lastCall?.[1]).toBe('u1');
    expect(JSON.parse(String(lastCall?.[2]))).toEqual({
      __gateway_message__: true,
      msg_type: 'file',
      content: {
        local_file_path: synthesizedPath,
      },
    });
  });
  it('sends a final weixin audio file reply for text without speech service', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-weixin-text-tts-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const synthesizedPath = path.join(tempDir, 'reply-weixin-text.mp3');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(synthesizedPath, Buffer.from('reply-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({
      threadId: 'thread_text_tts',
      rawOutput: `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '这是直接走 TTS 的微信回复。',
        },
      })}\n`,
    }));
    const synthesize = vi.fn(async () => ({
      filePath: synthesizedPath,
      mimeType: 'audio/mpeg',
      format: 'mp3' as const,
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      ttsService: {
        synthesize,
      },
    });

    await handler({
      channel: 'weixin',
      userId: 'u1',
      content: '把今天的会议总结成一段语音发给我',
    });

    expect(run).toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith({
      text: '这是直接走 TTS 的微信回复。',
      workspaceDir,
    });
    const lastCall = sendText.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('weixin');
    expect(lastCall?.[1]).toBe('u1');
    expect(JSON.parse(String(lastCall?.[2]))).toEqual({
      __gateway_message__: true,
      msg_type: 'file',
      content: {
        local_file_path: synthesizedPath,
      },
    });
  });

  it('sends a final feishu audio reply when model requests reply_mode=audio', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-feishu-text-tts-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const synthesizedPath = path.join(tempDir, 'reply-feishu-text.mp3');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(synthesizedPath, Buffer.from('reply-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const run = vi.fn(async () => ({
      threadId: 'thread_feishu_tts',
      rawOutput: `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '晚安宝贝\nreply_mode=audio',
        },
      })}\n`,
    }));
    const synthesize = vi.fn(async () => ({
      filePath: synthesizedPath,
      mimeType: 'audio/mpeg',
      format: 'mp3' as const,
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      ttsService: {
        synthesize,
      },
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: '用语音说一句晚安宝贝',
    });

    expect(run).toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith({
      text: '晚安宝贝',
      workspaceDir,
    });
    const lastCall = sendText.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('feishu');
    expect(lastCall?.[1]).toBe('u1');
    expect(JSON.parse(String(lastCall?.[2]))).toEqual({
      __gateway_message__: true,
      msg_type: 'audio',
      content: {
        local_audio_path: synthesizedPath,
      },
    });
  });

  it('sends a final feishu audio reply when only the streamed final answer carries reply_mode=audio', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-feishu-streamed-tts-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const synthesizedPath = path.join(tempDir, 'reply-feishu-streamed.mp3');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(synthesizedPath, Buffer.from('reply-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    const runWithControl = vi.fn((input: {
      onMessage?: (text: string) => void;
    }) => {
      input.onMessage?.('晚安宝贝\nreply_mode=audio');
      return {
        result: Promise.resolve({
          threadId: 'thread_feishu_streamed_tts',
          rawOutput: `${JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: '晚安宝贝',
            },
          })}\n`,
        }),
        stop: async () => false,
      };
    });
    const synthesize = vi.fn(async () => ({
      filePath: synthesizedPath,
      mimeType: 'audio/mpeg',
      format: 'mp3' as const,
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'unused', rawOutput: '' }),
        runWithControl,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      ttsService: {
        synthesize,
      },
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: '用语音说一句晚安宝贝',
    });

    expect(runWithControl).toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith({
      text: '晚安宝贝',
      workspaceDir,
    });
    const audioCall = sendText.mock.calls.find((call) => {
      if (call[0] !== 'feishu' || call[1] !== 'u1') {
        return false;
      }
      try {
        return JSON.parse(String(call[2])).msg_type === 'audio';
      } catch {
        return false;
      }
    });
    expect(audioCall).toBeTruthy();
  });

  it('keeps feishu run cards while suppressing visible text when the model emits reply_mode=audio', async () => {
    const sendText = vi.fn(async () => undefined);
    const sendTextWithResult = vi.fn(async () => 'om_run_1');
    const sendStreamingText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-handler-feishu-audio-only-'));
    const workspaceDir = path.join(tempDir, 'workspace');
    const synthesizedPath = path.join(tempDir, 'reply-feishu-audio-only.mp3');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(synthesizedPath, Buffer.from('reply-audio'));
    sessionStore.createAgent('u1', {
      agentId: 'a1',
      name: '测试Agent',
      workspaceDir,
    });
    sessionStore.setCurrentAgent('u1', 'a1');
    sessionStore.setSession('u1', 'a1', 'thread_existing');
    sessionStore.setProviderOverride?.('u1', 'a1', 'codex');
    const runWithControl = vi.fn((input: {
      onMessage?: (text: string) => void;
    }) => {
      input.onMessage?.('晚安宝贝\nreply_mode=audio');
      return {
        result: Promise.resolve({
          threadId: 'thread_feishu_audio_only',
          rawOutput: `${JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: '晚安宝贝',
            },
          })}\n`,
        }),
        stop: async () => false,
      };
    });
    const synthesize = vi.fn(async () => ({
      filePath: synthesizedPath,
      mimeType: 'audio/mpeg',
      format: 'mp3' as const,
    }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'unused', rawOutput: '' }),
        runWithControl,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      sendTextWithResult,
      sendStreamingText,
      ttsService: {
        synthesize,
      },
    });

    await handler({
      channel: 'feishu',
      userId: 'u1',
      content: '晚安宝贝',
    });

    expect(sendTextWithResult).toHaveBeenCalledTimes(1);
    expect(sendStreamingText).not.toHaveBeenCalled();
    const audioCalls = sendText.mock.calls.filter((call) => {
      if (call[0] !== 'feishu' || call[1] !== 'u1') {
        return false;
      }
      try {
        return JSON.parse(String(call[2])).msg_type === 'audio';
      } catch {
        return false;
      }
    });
    expect(audioCalls).toHaveLength(1);
    const plainTextCalls = sendText.mock.calls.filter((call) => {
      const payload = String(call[2]);
      return payload.includes('晚安宝贝') && !payload.includes('"msg_type":"audio"');
    });
    expect(plainTextCalls).toHaveLength(0);
    expect(synthesize).toHaveBeenCalledWith({
      text: '晚安宝贝',
      workspaceDir,
    });
  });

  it('sends progress status before running a normal agent task', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_existing', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenNthCalledWith(1, 'wecom', 'u1', '默认助手 ·\n⏳ 已接收请求，正在处理...');
    expect(sendText).toHaveBeenNthCalledWith(2, 'wecom', 'u1', '默认助手 ·\n✅ 已处理完成。');
  });

  it('does not send received or done progress status in weixin channel', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async (input: { onMessage?: (text: string) => void }) => {
          input.onMessage?.('开始处理。');
          return { threadId: 'thread_existing', rawOutput: '' };
        },
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'weixin', userId: 'u1', content: 'hello' });

    expect(sendText).not.toHaveBeenCalledWith('weixin', 'u1', '默认助手 ·\n⏳ 已接收请求，正在处理...');
    expect(sendText).not.toHaveBeenCalledWith('weixin', 'u1', '默认助手 ·\n✅ 已处理完成。');
    expect(sendText).toHaveBeenCalledWith('weixin', 'u1', '默认助手 ·\n开始处理。');
  });

  it('patches the same feishu run card to stopped after stop', async () => {
    const sendText = vi.fn(async () => undefined);
    const sendTextWithResult = vi.fn(async (_channel: 'wecom' | 'feishu' | 'weixin', _userId: string, content: string) => {
      if (content.includes('停止本次任务')) {
        return 'om_run_1';
      }
      return undefined;
    });
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');

    let rejectRun: ((error: Error) => void) | undefined;
    const runResult = new Promise<{ threadId: string; rawOutput: string }>((_resolve, reject) => {
      rejectRun = reject;
    });
    const stop = vi.fn(async () => {
      rejectRun?.(new Error('codex exited with code 143'));
      return true;
    });

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_existing', rawOutput: '' }),
        runWithControl: () => ({
          result: runResult,
          stop,
        }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      sendTextWithResult,
    });

    const firstRun = handler({ channel: 'feishu', userId: 'u1', content: 'hello' });
    await new Promise((resolve) => setImmediate(resolve));

    const initialPayload = String(sendTextWithResult.mock.calls[0]?.[2] ?? '');
    const stopCmd = extractFeishuButtons(getFeishuCardElements(initialPayload))
      .find((button) => typeof button.value?.gateway_cmd === 'string')
      ?.value?.gateway_cmd;
    expect(stopCmd).toBeTruthy();

    await handler({ channel: 'feishu', userId: 'u1', content: String(stopCmd) });
    await firstRun;

    expect(stop).toHaveBeenCalledWith('user_stop');
    const updates = sendText.mock.calls
      .map((call) => String(call[2] ?? ''))
      .filter((payload) => payload.includes('"op":"update"'));
    expect(updates.some((payload) => payload.includes('"message_id":"om_run_1"') && payload.includes('正在停止'))).toBe(true);
    expect(updates.some((payload) => payload.includes('"message_id":"om_run_1"') && payload.includes('当前任务已停止'))).toBe(true);
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('"op":"recall"'))).toBe(false);
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('本次回复中断了'))).toBe(false);
  });

  it('does not append interruption warning after visible feishu output', async () => {
    const sendText = vi.fn(async () => undefined);
    const sendTextWithResult = vi.fn(async () => 'om_run_1');
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        runWithControl: (input) => ({
          result: (async () => {
            input.onMessage?.('收到，正常。');
            throw new Error('boom-after-output');
          })(),
          stop: async () => false,
        }),
        run: async () => ({ threadId: 'thread_existing', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      sendTextWithResult,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenCalledWith('feishu', 'u1', '默认助手 ·\n收到，正常。');
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('"op":"update"') && String(call[2] ?? '').includes('当前任务已处理完成'))).toBe(true);
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('"op":"recall"'))).toBe(false);
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('本次回复中断了'))).toBe(false);
  });

  it('does not send a not-running warning when stop arrives after a completed feishu run', async () => {
    const sendText = vi.fn(async () => undefined);
    const sendTextWithResult = vi.fn(async (_channel: 'wecom' | 'feishu' | 'weixin', _userId: string, content: string) => {
      if (content.includes('结束')) {
        return 'om_run_1';
      }
      if (content.includes('当前任务已处理完成')) {
        return 'om_done_1';
      }
      return undefined;
    });
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        runWithControl: (input) => ({
          result: (async () => {
            input.onMessage?.('收到，正常。');
            return { threadId: 'thread_existing', rawOutput: '' };
          })(),
          stop: async () => false,
        }),
        run: async () => ({ threadId: 'thread_existing', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      sendTextWithResult,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: 'hello' });
    const initialPayload = String(sendTextWithResult.mock.calls[0]?.[2] ?? '');
    const stopCmd = extractFeishuButtons(getFeishuCardElements(initialPayload))
      .find((button) => typeof button.value?.gateway_cmd === 'string')
      ?.value?.gateway_cmd;
    expect(stopCmd).toBeTruthy();

    await handler({ channel: 'feishu', userId: 'u1', content: String(stopCmd) });

    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('未找到正在运行的任务'))).toBe(false);
  });

  it('pushes help card automatically when a new feishu session starts', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async (input: { onMessage?: (text: string) => void }) => {
      input.onMessage?.('你好，我已开始处理。');
      return { threadId: 'thread_new', rawOutput: '' };
    });
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '你好' });

    const providerPayload = String(sendText.mock.calls[0]?.[2] ?? '');
    const helpPayload = String(sendText.mock.calls[1]?.[2] ?? '');
    const providerParsed = JSON.parse(providerPayload) as {
      __gateway_message__?: boolean;
      msg_type?: string;
      content?: { header?: { title?: { content?: string } } };
    };
    const helpParsed = JSON.parse(helpPayload) as {
      __gateway_message__?: boolean;
      msg_type?: string;
      content?: {
        header?: { title?: { content?: string } };
      };
    };
    expect(providerParsed.__gateway_message__).toBe(true);
    expect(providerParsed.msg_type).toBe('interactive');
    expect(providerParsed.content?.header?.title?.content).toBe('框架管理');
    expect(helpParsed.__gateway_message__).toBe(true);
    expect(helpParsed.msg_type).toBe('interactive');
    expect(helpParsed.content?.header?.title?.content).toBe('命令帮助');
    const helpButtons = extractFeishuButtons(getFeishuCardElements(helpPayload))
      .map((item) => item.text?.content ?? '');
    expect(helpButtons).not.toContain('运行器切换');
    expect(helpButtons).not.toContain('⬅️ 上一页');
    expect(helpButtons).not.toContain('下一页 ➡️');
    expect(sendText).toHaveBeenCalledWith('feishu', 'u1', '默认助手 ·\n你好，我已开始处理。');
  });

  it('recommends provider selection on the first message when current agent has no explicit provider choice', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_new', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
        getProvider: () => 'codex',
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultProvider: 'codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '你好' });

    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('建议首轮先发送'))).toBe(true);
    expect(sendText.mock.calls.some((call) => String(call[2] ?? '').includes('/provider opencode'))).toBe(true);
  });

  it('allows ordinary feishu messages through', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_new', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '你好' });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pushes help text automatically when a new wecom session starts', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async (input: { onMessage?: (text: string) => void }) => {
      input.onMessage?.('开始处理。');
      return { threadId: 'thread_new', rawOutput: '' };
    });
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
        isWorkspaceIdentityEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '你好' });

    expect(sendText).toHaveBeenNthCalledWith(1, 'wecom', 'u1', expect.stringContaining('当前 agent 尚未显式选择模型通道'));
    expect(sendText).toHaveBeenNthCalledWith(2, 'wecom', 'u1', expect.stringContaining('可用命令（按功能分组，帮助页 1/3）：'));
    expect(sendText).toHaveBeenNthCalledWith(3, 'wecom', 'u1', '默认助手 ·\n⏳ 已接收请求，正在处理...');
    expect(sendText).toHaveBeenNthCalledWith(4, 'wecom', 'u1', '默认助手 ·\n开始处理。');
  });

  it('keeps running when the progress status push fails', async () => {
    const sendText = vi
      .fn<(
        channel: 'wecom' | 'feishu',
        userId: string,
        content: string
      ) => Promise<void>>()
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValue(undefined);
    const run = vi.fn(async (input: { onMessage?: (text: string) => void }) => {
      input.onMessage?.('第一条回复');
      return { threadId: 't1', rawOutput: '' };
    });
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'existing-thread');
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(sendText).toHaveBeenNthCalledWith(1, 'wecom', 'u1', '默认助手 ·\n⏳ 已接收请求，正在处理...');
    expect(sendText).toHaveBeenNthCalledWith(2, 'wecom', 'u1', '默认助手 ·\n第一条回复');
  });

  it('drops an invalid persisted thread id and starts a fresh session instead of failing', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async (input: { threadId?: string; onMessage?: (text: string) => void }) => {
      input.onMessage?.('重新开始处理。');
      return { threadId: 'thread_recovered', rawOutput: '' };
    });
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', '<编号|threadId>');

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '继续' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: undefined,
      prompt: expect.stringContaining('继续'),
    }));
    expect(sessionStore.getSession('u1', 'default')).toBe('thread_recovered');
    expect(sendText).not.toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('这次处理没完成'));
  });

  it('rejects placeholder switch targets instead of persisting them as sessions', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/switch <编号|threadId>' });

    expect(sessionStore.getSession('u1', 'default')).toBeUndefined();
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('无效的会话标识'));
  });

  it('creates and switches agent by command', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const createWorkspace = vi.fn(() => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace,
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/agent create 前端工作区' });

    expect(createWorkspace).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      'wecom',
      'u1',
      expect.stringContaining('已创建并切换到 agent：前端工作区 (frontend)'),
    );
    expect(sessionStore.getCurrentAgent('u1').agentId).toBe('frontend');
  });

  it('formats built-in command response as feishu interactive card', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/help' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const parsed = JSON.parse(payload) as {
      __gateway_message__?: boolean;
      msg_type?: string;
      content?: unknown;
    };
    expect(parsed.__gateway_message__).toBe(true);
    expect(parsed.msg_type).toBe('interactive');
    expect(typeof parsed.content).toBe('object');
    const card = parsed.content as {
      header?: { title?: { content?: string } };
    };
    const elements = getFeishuCardElements(payload);
    expect(card.header?.title?.content).toBe('命令帮助');
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const merged = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String(item.content ?? ''))
      .join('\n');
    expect(merged).toContain('**当前重点**');
    expect(merged).toContain('会话与 Agent · 1/3');
    expect(merged).toContain('**下一步**');
    expect(elements.some((item) => item.tag === 'note')).toBe(false);
    expect(merged).not.toContain('按功能分组浏览可用命令，并直接点击执行常用操作。');
    const fieldGrid = elements.find((item) => (item as { tag?: string }).tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**当前分组**'))).toBe(true);
    const buttons = extractFeishuButtons(elements);
    const cmds = buttons.map((button) => button.value?.gateway_cmd);
    const labels = buttons.map((button) => button.text?.content);
    expect(labels).toContain('框架管理');
    expect(cmds).toContain('/provider');
    expect(cmds).toContain('/sessions');
    expect(cmds).toContain('/agents');
    expect(cmds).toContain('/help 1');
    expect(cmds).toContain('/help 2');
  });

  it('renders third help page commands in feishu interactive card', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
      },
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/help 3' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const parsed = JSON.parse(payload) as {
      content?: {
        header?: { title?: { content?: string } };
      };
    };
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const merged = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String(item.content ?? ''))
      .join('\n');
    expect(merged).toContain('工作区与运维 · 3/3');
    expect(merged).not.toContain('/deploy-workspace - 发布当前 agent 工作区');
    expect(merged).not.toContain('/publish-workspace - 发布当前 agent 工作区');
    const cmds = extractFeishuButtons(elements).map((button) => button.value?.gateway_cmd);
    expect(cmds).toContain('/help 2');
    expect(cmds).toContain('/help 3');
  });

  it('formats short command response as feishu interactive card', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/search' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const parsed = JSON.parse(payload) as {
      __gateway_message__?: boolean;
      msg_type?: string;
      content?: unknown;
    };
    expect(parsed.__gateway_message__).toBe(true);
    expect(parsed.msg_type).toBe('interactive');
    const card = parsed.content as {
      header?: { title?: { content?: string } };
    };
    const elements = getFeishuCardElements(payload);
    expect(card.header?.title?.content).toBe('联网搜索');
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const markdownContents = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String(item.content ?? ''));
    expect(markdownContents.join('\n')).toContain('**当前状态**');
    expect(markdownContents.join('\n')).toContain('**下一步**');
    const fieldGrid = elements.find((item) => item.tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**联网搜索**'))).toBe(true);
    const buttons = extractFeishuButtons(elements);
    const cmds = buttons.map((button) => button.value?.gateway_cmd);
    expect(cmds).toContain('/search on');
    expect(cmds).toContain('/search off');
  });

  it('returns a login choice card for feishu /login without starting device auth', async () => {
    const sendText = vi.fn(async () => undefined);
    const login = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
        login,
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/login' });

    expect(login).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const parsed = JSON.parse(payload) as {
      __gateway_message__?: boolean;
      msg_type?: string;
      content?: {
        header?: { title?: { content?: string } };
      };
    };
    expect(parsed.__gateway_message__).toBe(true);
    expect(parsed.msg_type).toBe('interactive');
    expect(parsed.content?.header?.title?.content).toBe('登录授权');
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const buttons = extractFeishuButtons(elements);
    const labels = buttons.map((button) => String(button.text?.content ?? ''));
    expect(labels).toContain('设备授权登录');
    expect(labels).toContain('API URL / Key 登录');
    expect(buttons.some((button) => button.value?.gateway_action === 'codex_login.start_device_auth')).toBe(true);
    expect(buttons.some((button) => button.value?.gateway_action === 'codex_login.open_api_form')).toBe(true);
  });

  it('includes current cli auth state in the feishu /login card', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-login-state-'));
    fs.writeFileSync(path.join(codexHomeDir, 'config.toml'), 'model = "gpt-5.4"\n', 'utf8');
    fs.writeFileSync(path.join(codexHomeDir, 'auth.json'), '{"OPENAI_API_KEY":"sk-test"}\n', 'utf8');
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
        login: async () => undefined,
      },
      codexHomeDir,
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/login' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const serialized = JSON.stringify(getFeishuCardElements(payload));
    expect(serialized).toContain('配置状态');
    expect(serialized).toContain('已写入');
    expect(serialized).toContain('授权状态');
    expect(serialized).toContain('已发现');
    expect(serialized).toContain('gpt-5.4');
  });

  it('treats /feishu-auth as an unknown command in feishu channel', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/feishu-auth' });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String(sendText.mock.calls[0]?.[2] ?? '')).toContain('未识别命令');
  });

  it('treats /feishu-auth as an unknown command outside feishu channel', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/feishu-auth' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('未识别命令'));
  });

  it('renders search toggle card with dynamic button emphasis', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/search on' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const offAction = extractFeishuButtons(elements)
      .find((item) => item.value?.gateway_cmd === '/search off');
    expect(offAction?.type).toBe('danger');
  });

  it('renders skills command card with quick action buttons', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const skillManager = {
      listEffectiveSkills: vi.fn(() => ([
        { name: 'using-superpowers', source: 'global' as const, skillDir: '/root/.agents/skills/using-superpowers' },
      ])),
      listGlobalSkills: vi.fn(() => []),
      listAgentLocalSkills: vi.fn(() => []),
      disableGlobalSkill: vi.fn(() => ({ ok: true })),
      enableGlobalSkill: vi.fn(() => ({ ok: true })),
      disableAgentSkill: vi.fn(() => ({ ok: true })),
    };
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      skillManager,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/skills' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const parsed = JSON.parse(payload) as { content?: { header?: { template?: string }; elements?: Array<Record<string, unknown>> } };
    const elements = getFeishuCardElements(payload);
    expect(parsed.content?.header?.template).toBe('turquoise');
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const markdownContents = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String((item as { content?: unknown }).content ?? ''));
    expect(markdownContents.join('\n')).toContain('**当前重点**');
    expect(markdownContents.join('\n')).toContain('**生效技能**');
    expect(markdownContents.join('\n')).toContain('**下一步**');
    const fieldGrid = elements.find((item) => item.tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**范围**'))).toBe(true);
    const cmds = extractFeishuButtons(elements).map((button) => button.value?.gateway_cmd);
    expect(cmds).toContain('/skills');
    expect(cmds).toContain('/skills global');
    expect(cmds).toContain('/skills agent');
  });

  it('renders sessions command card with switch buttons', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_1');
    sessionStore.listDetailed = () => ([
      {
        threadId: 'thread_1',
        name: '当前会话',
        summary: '修复飞书 session 卡片',
        lastPrompt: 'hello',
        updatedAt: Date.now(),
      },
      {
        threadId: 'thread_2',
        summary: '补充 README 文档',
        lastPrompt: 'world',
        updatedAt: Date.now() - 1,
      },
    ]);
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/sessions' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const markdownContents = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String((item as { content?: unknown }).content ?? ''));
    expect(markdownContents.join('\n')).toContain('**当前重点**');
    expect(markdownContents.join('\n')).toContain('**下一步**');
    const fieldGrid = elements.find((item) => item.tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**会话数量**'))).toBe(true);
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**当前会话**'))).toBe(true);
    const buttons = extractFeishuButtons(elements);
    const switchCurrent = buttons
      .find((action) => action.value?.gateway_cmd === '/switch 1');
    const switchOther = buttons
      .find((action) => action.value?.gateway_cmd === '/switch 2');
    expect(switchCurrent?.type).toBe('primary');
    expect(switchCurrent?.text?.content).toContain('当前会话');
    expect(switchCurrent?.text?.content).toContain('hello');
    expect(switchOther?.text?.content).toContain('补充 README 文档');
    expect(switchOther?.text?.content).toContain('world');
  });

  it('records assistant activity after a normal reply completes', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_existing');
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_existing', rawOutput: '最终回复内容' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '继续修复 session summary' });

    expect(sessionStore.__activities).toContainEqual(expect.objectContaining({
      threadId: 'thread_existing',
      role: 'user',
      text: '继续修复 session summary',
    }));
    expect(sessionStore.__activities).toContainEqual(expect.objectContaining({
      threadId: 'thread_existing',
      role: 'assistant',
      text: '最终回复内容',
    }));
  });

  it('renders agents command card with switch buttons', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'frontend',
      name: '前端工作区',
      workspaceDir: '/repo/frontend',
    });
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/agents' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const markdownContents = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String((item as { content?: unknown }).content ?? ''));
    expect(markdownContents.join('\n')).toContain('**当前重点**');
    expect(markdownContents.join('\n')).toContain('**下一步**');
    const fieldGrid = elements.find((item) => item.tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**Agent 数量**'))).toBe(true);
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**当前 Agent**'))).toBe(true);
    const buttons = extractFeishuButtons(elements);
    const useDefault = buttons
      .find((action) => action.value?.gateway_cmd === '/agent use 1');
    const useFrontend = buttons
      .find((action) => action.value?.gateway_cmd === '/agent use 2');
    expect(useDefault?.type).toBe('primary');
    expect(useDefault?.text?.content).toContain('默认');
    expect(useFrontend?.text?.content).toContain('前端工作区');
    expect(useFrontend?.text?.content).toContain('frontend');
  });

  it('renders agent command card with agent status sections', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/agent' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const markdownContents = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String((item as { content?: unknown }).content ?? ''));
    expect(markdownContents.join('\n')).toContain('**当前重点**');
    expect(markdownContents.join('\n')).toContain('**下一步**');
    const fieldGrid = elements.find((item) => item.tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**工作区**'))).toBe(true);
    const cmds = extractFeishuButtons(elements).map((button) => button.value?.gateway_cmd);
    expect(cmds).toContain('/agents');
    expect(cmds).toContain('/sessions');
  });

  it('renders model command card with current model section', async () => {
    await withMockModelsCache({
      fetched_at: '2026-03-08T11:00:00Z',
      models: [
        { slug: 'gpt-5-codex', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5', visibility: 'list', supported_in_api: true },
        { slug: 'legacy-hidden', visibility: 'hide', supported_in_api: true },
      ],
    }, async () => {
      const sendText = vi.fn(async () => undefined);
      const sessionStore = createSessionStore();
      const handler = createChatHandler({
        sessionStore,
        rateLimitStore: { allow: () => true },
        codexRunner: {
          run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
          review: async () => ({ rawOutput: '' }),
        },
        agentWorkspaceManager: {
          createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
          isSharedMemoryEmpty: () => false,
        },
        runnerEnabled: true,
        defaultModel: 'gpt-5-codex',
        defaultSearch: false,
        reminderDbPath: '/tmp/reminders.db',
        sendText,
      });

      await handler({ channel: 'feishu', userId: 'u1', content: '/model' });

      const payload = String(sendText.mock.calls[0]?.[2] ?? '');
      const elements = getFeishuCardElements(payload);
      expect(elements.some((item) => item.tag === 'action')).toBe(false);
      const markdownContents = elements
        .filter((item) => item.tag === 'markdown')
        .map((item) => String((item as { content?: unknown }).content ?? ''));
      expect(markdownContents.join('\n')).toContain('**当前重点**');
      expect(markdownContents.join('\n')).toContain('**下一步**');
      expect(markdownContents.join('\n')).toContain('**可选模型**');
      const buttons = extractFeishuButtons(elements);
      const cmds = buttons.map((button) => button.value?.gateway_cmd);
      expect(cmds.some((cmd) => typeof cmd === 'string' && cmd.startsWith('/model ') && cmd !== '/model gpt-5-codex')).toBe(true);
      const currentModelAction = buttons
        .find((action) => String(action.text?.content ?? '').includes('当前 ·'));
      expect(currentModelAction?.text?.content).toBe('当前 · gpt-5-codex');
      expect(currentModelAction?.type).toBe('primary');
    });
  });

  it('keeps model switch card interactive after changing model', async () => {
    await withMockModelsCache({
      fetched_at: '2026-03-08T11:00:00Z',
      models: [
        { slug: 'gpt-5-codex', visibility: 'list', supported_in_api: true },
        { slug: 'gpt-5', visibility: 'list', supported_in_api: true },
      ],
    }, async () => {
      const sendText = vi.fn(async () => undefined);
      const sessionStore = createSessionStore();
      const handler = createChatHandler({
        sessionStore,
        rateLimitStore: { allow: () => true },
        codexRunner: {
          run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
          review: async () => ({ rawOutput: '' }),
        },
        agentWorkspaceManager: {
          createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
          isSharedMemoryEmpty: () => false,
        },
        runnerEnabled: true,
        defaultModel: 'gpt-5-codex',
        defaultSearch: false,
        reminderDbPath: '/tmp/reminders.db',
        sendText,
      });

      await handler({ channel: 'feishu', userId: 'u1', content: '/model gpt-5' });

      const payload = String(sendText.mock.calls[0]?.[2] ?? '');
      const elements = getFeishuCardElements(payload);
      expect(elements.some((item) => item.tag === 'action')).toBe(false);
      const markdownContents = elements
        .filter((item) => item.tag === 'markdown')
        .map((item) => String((item as { content?: unknown }).content ?? ''));
      expect(markdownContents.join('\n')).toContain('**当前重点**');
      expect(markdownContents.join('\n')).toContain('**当前状态**');
      expect(markdownContents.join('\n')).toContain('✅ 已切换模型为：gpt-5');
      expect(markdownContents.join('\n')).toContain('**可选模型**');
      const currentModelAction = extractFeishuButtons(elements)
        .find((action) => action.value?.gateway_cmd === '/model');
      expect(currentModelAction?.type).toBe('primary');
    });
  });

  it('reads persisted model selection per agent when switching agents', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'frontend',
      name: '前端Agent',
      workspaceDir: '/tmp/frontend',
    });
    sessionStore.setModelOverride('u1', 'default', 'gpt-5');
    sessionStore.setModelOverride('u1', 'frontend', 'gpt-5-codex');

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'fallback-model',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/model' });
    await handler({ channel: 'wecom', userId: 'u1', content: '/agent use frontend' });
    await handler({ channel: 'wecom', userId: 'u1', content: '/model' });

    expect(String(sendText.mock.calls[0]?.[2] ?? '')).toContain('当前模型：gpt-5');
    expect(String(sendText.mock.calls[2]?.[2] ?? '')).toContain('当前模型：gpt-5-codex');
  });

  it('truncates long model list and adds full-list entry', async () => {
    await withMockModelsCache({
      fetched_at: '2026-03-08T11:00:00Z',
      models: Array.from({ length: 12 }, (_, index) => ({
        slug: `model-${index + 1}`,
        visibility: 'list',
        supported_in_api: true,
      })),
    }, async () => {
      const sendText = vi.fn(async () => undefined);
      const sessionStore = createSessionStore();
      const handler = createChatHandler({
        sessionStore,
        rateLimitStore: { allow: () => true },
        codexRunner: {
          run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
          review: async () => ({ rawOutput: '' }),
        },
        agentWorkspaceManager: {
          createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
          isSharedMemoryEmpty: () => false,
        },
        runnerEnabled: true,
        defaultModel: 'model-1',
        defaultSearch: false,
        reminderDbPath: '/tmp/reminders.db',
        sendText,
      });

      await handler({ channel: 'feishu', userId: 'u1', content: '/model' });

      const payload = String(sendText.mock.calls[0]?.[2] ?? '');
      const elements = getFeishuCardElements(payload);
      expect(elements.some((item) => item.tag === 'action')).toBe(false);
      expect(elements.some((item) => item.tag === 'note')).toBe(false);
      const markdownContents = elements
        .filter((item) => item.tag === 'markdown')
        .map((item) => String((item as { content?: unknown }).content ?? ''));
      expect(markdownContents.join('\n')).toContain('还有更多可见模型，点击下方按钮继续查看。');
      const cmds = extractFeishuButtons(elements).map((button) => button.value?.gateway_cmd);
      expect(cmds).toContain('/model page 2');
    });
  });

  it('renders paginated models card with page navigation buttons', async () => {
    await withMockModelsCache({
      fetched_at: '2026-03-08T11:00:00Z',
      models: Array.from({ length: 12 }, (_, index) => ({
        slug: `page-model-${index + 1}`,
        visibility: 'list',
        supported_in_api: true,
      })),
    }, async () => {
      const sendText = vi.fn(async () => undefined);
      const sessionStore = createSessionStore();
      const handler = createChatHandler({
        sessionStore,
        rateLimitStore: { allow: () => true },
        codexRunner: {
          run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
          review: async () => ({ rawOutput: '' }),
        },
        agentWorkspaceManager: {
          createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
          isSharedMemoryEmpty: () => false,
        },
        runnerEnabled: true,
        defaultModel: 'page-model-1',
        defaultSearch: false,
        reminderDbPath: '/tmp/reminders.db',
        sendText,
      });

      await handler({ channel: 'feishu', userId: 'u1', content: '/model page 2' });

      const payload = String(sendText.mock.calls[0]?.[2] ?? '');
      const elements = getFeishuCardElements(payload);
      expect(elements.some((item) => item.tag === 'action')).toBe(false);
      const markdownContents = elements
        .filter((item) => item.tag === 'markdown')
        .map((item) => String((item as { content?: unknown }).content ?? ''));
      expect(markdownContents.join('\n')).toContain('模型翻页');
      expect(markdownContents.join('\n')).toContain('模型翻页');
      const buttons = extractFeishuButtons(elements);
      const cmds = buttons.map((button) => button.value?.gateway_cmd);
      expect(cmds).toContain('/model page 1');
      expect(cmds).toContain('/model page 2');
      const pageModelAction = buttons
        .find((action) => action.value?.gateway_cmd === '/model page-model-10');
      expect(pageModelAction?.text?.content).toBe('page-model-10');
    });
  });

  it('renders status change response as structured feishu card', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const skillManager = {
      listEffectiveSkills: vi.fn(() => []),
      listGlobalSkills: vi.fn(() => []),
      listAgentLocalSkills: vi.fn(() => []),
      disableGlobalSkill: vi.fn(() => ({ ok: true })),
      enableGlobalSkill: vi.fn(() => ({ ok: true })),
      disableAgentSkill: vi.fn(() => ({ ok: true })),
    };
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      skillManager,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: '/skills disable global using-superpowers' });

    const payload = String(sendText.mock.calls[0]?.[2] ?? '');
    const elements = getFeishuCardElements(payload);
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    const markdownContents = elements
      .filter((item) => item.tag === 'markdown')
      .map((item) => String((item as { content?: unknown }).content ?? ''));
    expect(markdownContents.join('\n')).toContain('**结论**');
    expect(markdownContents.join('\n')).toContain('**下一步**');
    const fieldGrid = elements.find((item) => item.tag === 'div') as {
      fields?: Array<{ text?: { content?: string } }>;
    } | undefined;
    expect(fieldGrid?.fields?.some((field) => String(field.text?.content ?? '').includes('**状态**'))).toBe(true);
  });

  it('lists merged skills for current agent by /skills command', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const skillManager = {
      listEffectiveSkills: vi.fn(() => ([
        { name: 'using-superpowers', source: 'global' as const, skillDir: '/root/.agents/skills/using-superpowers' },
        { name: 'reminder-tool', source: 'agent-local' as const, skillDir: '/tmp/agent/.codex/skills/reminder-tool' },
      ])),
      listGlobalSkills: vi.fn(() => []),
      listAgentLocalSkills: vi.fn(() => []),
      disableGlobalSkill: vi.fn(() => ({ ok: true })),
      enableGlobalSkill: vi.fn(() => ({ ok: true })),
      disableAgentSkill: vi.fn(() => ({ ok: true })),
    };
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      skillManager,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/skills' });

    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('当前会话可用 skill'));
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('using-superpowers [global]'));
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('reminder-tool [agent-local]'));
  });

  it('disables global skill for current agent by /skills command', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const skillManager = {
      listEffectiveSkills: vi.fn(() => []),
      listGlobalSkills: vi.fn(() => []),
      listAgentLocalSkills: vi.fn(() => []),
      disableGlobalSkill: vi.fn(() => ({ ok: true })),
      enableGlobalSkill: vi.fn(() => ({ ok: true })),
      disableAgentSkill: vi.fn(() => ({ ok: true })),
    };
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      skillManager,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/skills disable global using-superpowers' });

    expect(skillManager.disableGlobalSkill).toHaveBeenCalledWith('/repo/default', 'using-superpowers');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('已禁用全局 skill'));
  });

  it('creates skill onboarding agent by command and switches to it', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    const createWorkspace = vi.fn(() => ({ agentId: 'skill-onboarding', workspaceDir: '/tmp/skill-onboarding' }));
    const run = vi.fn(async () => ({ threadId: 'thread_skill', rawOutput: '' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace,
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/skill-agent' });

    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      template: 'skill-onboarding',
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workdir: '/tmp/skill-onboarding',
      search: false,
    }));
    expect(sessionStore.getCurrentAgent('u1').agentId).toBe('skill-onboarding');
    expect(sessionStore.getSession('u1', 'skill-onboarding')).toBe('thread_skill');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('技能扩展助手'));
  });

  it('reuses existing skill onboarding session when already initialized', async () => {
    const sendText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'skill-onboarding',
      name: '技能扩展助手',
      workspaceDir: '/tmp/skill-onboarding',
    });
    sessionStore.setSession('u1', 'skill-onboarding', 'thread_skill');
    const createWorkspace = vi.fn(() => ({ agentId: 'skill-onboarding', workspaceDir: '/tmp/skill-onboarding' }));
    const run = vi.fn(async () => ({ threadId: 'thread_skill', rawOutput: '' }));
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace,
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/skill-agent' });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(sessionStore.getCurrentAgent('u1').agentId).toBe('skill-onboarding');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('已有进行中的会话'));
  });

  it('runs codex in the current agent workspace', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_new', rawOutput: '' }));
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'frontend',
      name: '前端工作区',
      workspaceDir: '/tmp/frontend',
    });
    sessionStore.setCurrentAgent('u1', 'frontend');

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workdir: '/tmp/frontend',
    }));
    expect(sessionStore.getSession('u1', 'frontend')).toBe('thread_new');
  });

  it('uses channel-specific outbound prompt for wecom', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_new', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }),
        isSharedMemoryEmpty: () => false,
      },
      browserOpenEnabled: false,
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: 'hello' });

    const prompt = run.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('你必须遵循以下企微回发协议：');
    expect(prompt).toContain('企微常用 msg_type：text、markdown、image、voice、video、file。');
    expect(prompt).toContain('简单一句话优先 text；多段说明或列表优先 markdown');
    expect(prompt).toContain('若是在汇报浏览器执行中的阶段性进度、阻塞原因、用户接管请求或完成态总结');
    expect(prompt).toContain('优先使用 markdown');
    expect(prompt).toContain('浏览器人工接管触发条件包括但不限于');
    expect(prompt).toContain('登录、验证码、扫码、支付确认、权限弹窗、高风险提交、页面目标歧义');
    expect(prompt).toContain('如果不确定该用哪种类型，优先退回 text');
    expect(prompt).not.toContain('飞书常用 msg_type');
  });

  it('uses channel-specific outbound prompt for weixin', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_new', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }),
        isSharedMemoryEmpty: () => false,
      },
      browserOpenEnabled: false,
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'weixin', userId: 'u1', content: 'hello' });

    const prompt = run.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('你必须遵循以下个人微信回发协议：');
    expect(prompt).toContain('个人微信常用 msg_type：text、image、voice、video、file。');
    expect(prompt).toContain('若明确需要回发个人微信非文本消息');
    expect(prompt).toContain('image/voice/video/file 仅在用户明确要求发送对应类型');
    expect(prompt).not.toContain('企微常用 msg_type');
  });

  it('includes message type selection rules in feishu prompt', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_new', rawOutput: '' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }),
        isSharedMemoryEmpty: () => false,
      },
      browserOpenEnabled: false,
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'feishu', userId: 'u1', content: 'hello' });

    const prompt = run.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('简单一句话优先 text；多段说明/列表/摘要、浏览器阶段性进度、阻塞说明和完成总结优先 interactive。');
    expect(prompt).toContain('若是在汇报浏览器执行中的阶段性进度');
    expect(prompt).toContain('Action/Evidence/Result/Next step');
    expect(prompt).toContain('若是在请求用户接管浏览器步骤');
    expect(prompt).toContain('阻塞原因、风险点、待确认项');
    expect(prompt).toContain('若是在汇报浏览器任务已完成');
    expect(prompt).toContain('最终结果、产出物和后续建议');
    expect(prompt).toContain('浏览器人工接管触发条件包括但不限于');
    expect(prompt).toContain('登录、验证码、扫码、支付确认、权限弹窗、高风险提交、页面目标歧义');
    expect(prompt).toContain('若要更新已发送的飞书消息，可输出 op=update');
    expect(prompt).toContain('若要撤回已发送的飞书消息，可输出 op=recall');
    expect(prompt).toContain('"message_id":"<飞书消息ID>"');
    expect(prompt).toContain('若使用飞书 interactive 自定义 schema 2.0 卡片，禁止使用 `tag:"action"` 或 `tag:\'action\'`。');
    expect(prompt).toContain('需要按钮行时，改用 `column_set` + `column` + `button`，表单提交继续使用 `form` + `button` + `action_type:"form_submit"`。');
    expect(prompt).not.toContain('回发飞书 post 时，若只是普通富文本段落，可直接把 content 写成字符串');
    expect(prompt).not.toContain('多段说明/列表/摘要优先 post');
    expect(prompt).toContain('如果不确定该用哪种类型，优先退回 text');
  });

  it('teaches feishu model to emit reply_mode=audio only when tts is enabled', async () => {
    const sendText = vi.fn(async () => undefined);
    const runWithTts = vi.fn(async () => ({ threadId: 'thread_tts', rawOutput: '' }));
    const runWithoutTts = vi.fn(async () => ({ threadId: 'thread_plain', rawOutput: '' }));
    const sessionStore = createSessionStore();

    const handlerWithTts = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: runWithTts,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      ttsService: {
        synthesize: async () => ({
          filePath: '/tmp/reply.mp3',
          mimeType: 'audio/mpeg',
          format: 'mp3' as const,
        }),
      },
    });

    await handlerWithTts({ channel: 'feishu', userId: 'u1', content: 'hello' });

    const handlerWithoutTts = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: runWithoutTts,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'frontend', workspaceDir: '/tmp/frontend' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handlerWithoutTts({ channel: 'feishu', userId: 'u1', content: 'hello' });

    const promptWithTts = runWithTts.mock.calls[0]?.[0]?.prompt as string;
    const promptWithoutTts = runWithoutTts.mock.calls[0]?.[0]?.prompt as string;
    expect(promptWithTts).toContain('reply_mode=audio');
    expect(promptWithTts).toContain('仅在用户明确要求语音回复');
    expect(promptWithoutTts).not.toContain('reply_mode=audio');
  });

  it('publishes workspace for /deploy-workspace command', async () => {
    const sendText = vi.fn(async () => undefined);
    const publish = vi.fn(async () => ({ output: 'publish ok' }));
    const sessionStore = createSessionStore();
    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: async () => ({ threadId: 'thread_new', rawOutput: '' }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      workspacePublisher: { publish },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '/deploy-workspace' });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', '⏳ 正在发布 workspace，请稍候...');
    expect(sendText).toHaveBeenCalledWith('wecom', 'u1', expect.stringContaining('workspace 发布完成'));
  });

  it('keeps normal conversation on visible agent even when onboarding session exists', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_onboarding', rawOutput: '' }));
    const sessionStore = createSessionStore();
    sessionStore.createAgent('u1', {
      agentId: 'memory-onboarding',
      name: '记忆初始化引导',
      workspaceDir: '/tmp/memory-onboarding',
    });
    sessionStore.setSession('u1', 'memory-onboarding', 'thread_onboarding');

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'memory-onboarding', workspaceDir: '/tmp/memory-onboarding' }),
        isSharedMemoryEmpty: () => true,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '我叫 Alice' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('我叫 Alice'),
      workdir: '/repo/default',
    }));
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread_onboarding',
    }));
    expect(sessionStore.getCurrentAgent('u1').agentId).toBe('default');
  });

  it('shows onboarding suggestion only on the first message of the current agent', async () => {
    const sendText = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ threadId: 'thread_default', rawOutput: '' }));
    const sessionStore = createSessionStore();
    sessionStore.setSession('u1', 'default', 'thread_default');

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run,
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'memory-onboarding', workspaceDir: '/tmp/memory-onboarding' }),
        isSharedMemoryEmpty: () => true,
      },
      runnerEnabled: true,
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
    });

    await handler({ channel: 'wecom', userId: 'u1', content: '继续做当前任务' });

    const suggestionCalls = sendText.mock.calls.filter((call) => String(call[2] ?? '').includes('/agent init-memory'));
    expect(suggestionCalls).toHaveLength(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread_default',
      prompt: expect.stringContaining('继续做当前任务'),
    }));
  });

  it('streams feishu agent messages as separate card snapshots and skips a duplicate final flush', async () => {
    const sendText = vi.fn(async () => undefined);
    const sendStreamingText = vi.fn(async () => undefined);
    const sessionStore = createSessionStore();
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1000;
      return now;
    });

    const handler = createChatHandler({
      sessionStore,
      rateLimitStore: { allow: () => true },
      codexRunner: {
        run: vi.fn(async (input: { onMessage?: (text: string) => void }) => {
          input.onMessage?.('第一段');
          input.onMessage?.('第二段');
          return { threadId: 'thread_1', rawOutput: '' };
        }),
        review: async () => ({ rawOutput: '' }),
      },
      agentWorkspaceManager: {
        createWorkspace: () => ({ agentId: 'a1', workspaceDir: '/tmp/a1' }),
        isSharedMemoryEmpty: () => false,
      },
      runnerEnabled: true,
      defaultModel: 'gpt-5-codex',
      defaultSearch: false,
      reminderDbPath: '/tmp/reminders.db',
      sendText,
      sendStreamingText,
    });

    try {
      await handler({ channel: 'feishu', userId: 'u1', content: 'hello' });
    } finally {
      nowSpy.mockRestore();
    }

    expect(sendStreamingText).toHaveBeenCalledTimes(2);
    expect(sendStreamingText.mock.calls[0]?.[0]).toBe('feishu');
    expect(sendStreamingText.mock.calls[0]?.[1]).toBe('u1');
    expect(sendStreamingText.mock.calls[0]?.[2]).toBe(sendStreamingText.mock.calls[1]?.[2]);
    expect(sendStreamingText.mock.calls[0]?.[3]).toBe('默认助手 ·\n第一段');
    expect(sendStreamingText.mock.calls[0]?.[4]).toBe(false);
    expect(sendStreamingText.mock.calls[1]?.[3]).toBe('默认助手 ·\n第二段');
    expect(sendStreamingText.mock.calls[1]?.[4]).toBe(false);
    expect(sendText).not.toHaveBeenCalledWith('feishu', 'u1', '默认助手 ·\n第一段');
    expect(sendText).not.toHaveBeenCalledWith('feishu', 'u1', '默认助手 ·\n第二段');
  });
});
