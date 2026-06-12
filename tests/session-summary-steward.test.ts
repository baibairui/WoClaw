import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SessionSummarySteward } from '../src/services/session-summary-steward.js';
import { SessionStore } from '../src/stores/session-store.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-store-'));
  return new SessionStore(path.join(dir, 'sessions.db'), {
    defaultWorkspaceDir: '/repo/default-workdir',
  });
}

describe('SessionSummarySteward', () => {
  it('summarizes dirty sessions and writes stable summary back', async () => {
    const store = makeStore();
    store.setSession('u1', 'default', 'thread_1', '修复飞书 session 卡片展示问题');
    store.recordSessionActivity('thread_1', {
      role: 'user',
      text: '继续补充后台巡检、状态机和会话列表展示逻辑',
      timestamp: Date.now() - 120_000,
    });
    store.recordSessionActivity('thread_1', {
      role: 'user',
      text: '还要让 /sessions 优先展示摘要而不是最后一条消息',
      timestamp: Date.now() - 119_000,
    });

    const runForSystem = vi.fn(async () => ({
      threadId: 'thread_summary',
      rawOutput: '飞书 session 摘要',
    }));

    const steward = new SessionSummarySteward({
      sessionStore: store,
      codexRunner: { runForSystem },
      enabled: true,
      intervalMs: 60_000,
      model: 'gpt-5-codex',
    });

    await steward.runCycle();

    const session = store.listDetailed('u1', 'default')[0];
    expect(runForSystem).toHaveBeenCalledTimes(1);
    expect(session?.summary).toBe('飞书 session 摘要');
    expect(session?.summaryState).toBe('stable');
    expect(session?.summarySource).toBe('llm');
    expect(session?.userTurnsSinceSummary).toBe(0);
    expect(session?.charsSinceSummary).toBe(0);
  });

  it('skips sessions still inside quiet window', async () => {
    const store = makeStore();
    store.setSession('u1', 'default', 'thread_1', '修复飞书 session 卡片展示问题');
    store.recordSessionActivity('thread_1', {
      role: 'user',
      text: '继续补充后台巡检、状态机和会话列表展示逻辑',
      timestamp: Date.now(),
    });
    store.recordSessionActivity('thread_1', {
      role: 'user',
      text: '还要让 /sessions 优先展示摘要而不是最后一条消息',
      timestamp: Date.now(),
    });

    const runForSystem = vi.fn(async () => ({
      threadId: 'thread_summary',
      rawOutput: '飞书 session 摘要',
    }));

    const steward = new SessionSummarySteward({
      sessionStore: store,
      codexRunner: { runForSystem },
      enabled: true,
      intervalMs: 60_000,
    });

    await steward.runCycle();

    expect(runForSystem).not.toHaveBeenCalled();
    expect(store.listDetailed('u1', 'default')[0]?.summaryState).toBe('dirty');
  });
});
