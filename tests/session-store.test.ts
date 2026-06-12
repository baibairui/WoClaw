import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

let SessionStore: any;
try {
  await import('node:sqlite');
  ({ SessionStore } = await import('../src/stores/session-store.js'));
} catch {
  SessionStore = undefined;
}

const describeIfSqlite = SessionStore ? describe : describe.skip;

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  return new SessionStore(path.join(dir, 'sessions.db'), {
    defaultWorkspaceDir: '/repo/default-workdir',
  });
}

function makeStorePair(): { filePath: string; createStore: () => any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  const filePath = path.join(dir, 'sessions.db');
  return {
    filePath,
    createStore: () => new SessionStore(filePath, {
      defaultWorkspaceDir: '/repo/default-workdir',
    }),
  };
}

describeIfSqlite('SessionStore', () => {
  it('defaults to the built-in default agent', () => {
    const store = makeStore();
    const agent = store.getCurrentAgent('u1');

    expect(agent.agentId).toBe('default');
    expect(agent.workspaceDir).toBe('/repo/default-workdir');
    expect(store.listAgents('u1')[0]?.isDefault).toBe(true);
  });

  it('creates agents and resolves numeric targets', () => {
    const store = makeStore();
    store.createAgent('u1', {
      agentId: 'frontend',
      name: '前端Agent',
      workspaceDir: '/tmp/frontend',
    });
    store.createAgent('u1', {
      agentId: 'backend',
      name: '后端Agent',
      workspaceDir: '/tmp/backend',
    });

    const listed = store.listAgents('u1');
    expect(listed).toHaveLength(3);
    expect(store.resolveAgentTarget('u1', '2')).toBeTruthy();
    expect(store.resolveAgentTarget('u1', 'frontend')).toBe('frontend');

    expect(store.setCurrentAgent('u1', 'frontend')).toBe(true);
    expect(store.getCurrentAgent('u1').agentId).toBe('frontend');
  });

  it('keeps session history isolated per agent', () => {
    const store = makeStore();
    store.createAgent('u1', {
      agentId: 'frontend',
      name: '前端Agent',
      workspaceDir: '/tmp/frontend',
    });

    store.setSession('u1', 'default', 'thread_default_1', 'first prompt');
    store.setSession('u1', 'frontend', 'thread_front_1', 'second prompt');
    store.setSession('u1', 'frontend', 'thread_front_2', 'third prompt');

    expect(store.getSession('u1', 'default')).toBe('thread_default_1');
    expect(store.getSession('u1', 'frontend')).toBe('thread_front_2');
    expect(store.resolveSwitchTarget('u1', 'frontend', '2')).toBe('thread_front_1');
    expect(store.listDetailed('u1', 'default')).toHaveLength(1);
    expect(store.listDetailed('u1', 'frontend')).toHaveLength(2);

    store.renameSession('thread_front_1', '发布修复');
    expect(store.listDetailed('u1', 'frontend')[1]?.name).toBe('发布修复');
  });

  it('stores seed summary and pending state for new sessions', () => {
    const store = makeStore();

    store.setSession('u1', 'default', 'thread_default_1', '修复飞书 session 卡片展示问题');

    const session = store.listDetailed('u1', 'default')[0];
    expect(session?.summary).toContain('修复飞书');
    expect(session?.summaryState).toBe('pending_init');
    expect(session?.summarySource).toBe('seed');
  });

  it('marks sessions dirty after enough new activity', () => {
    const store = makeStore();

    store.setSession('u1', 'default', 'thread_default_1', '修复飞书 session 卡片展示问题');
    store.recordSessionActivity('thread_default_1', {
      role: 'user',
      text: '继续补充 session summary 的状态字段和后台巡检策略',
      timestamp: 1_000,
    });
    store.recordSessionActivity('thread_default_1', {
      role: 'user',
      text: '还要把 /sessions 和飞书卡片展示优先级切到 name summary lastPrompt',
      timestamp: 2_000,
    });

    const session = store.listDetailed('u1', 'default')[0];
    expect(session?.summaryState).toBe('dirty');
    expect(session?.userTurnsSinceSummary).toBeGreaterThanOrEqual(2);
    expect(session?.charsSinceSummary).toBeGreaterThan(0);
  });

  it('locks auto summary after manual rename', () => {
    const store = makeStore();

    store.setSession('u1', 'default', 'thread_default_1', '修复飞书 session 卡片展示问题');
    store.renameSession('thread_default_1', '飞书 session 摘要');

    const session = store.listDetailed('u1', 'default')[0];
    expect(session?.name).toBe('飞书 session 摘要');
    expect(session?.summaryState).toBe('manual_locked');
    expect(session?.summarySource).toBe('manual');
  });

  it('keeps placeholder thread ids in storage for stable original ordering', () => {
    const store = makeStore();

    store.setSession('u1', 'default', 'thread_valid_1', '正常会话');
    store.setSession('u1', 'default', '<编号|threadId>', '脏历史会话');

    const sessions = store.listDetailed('u1', 'default');

    expect(sessions.map((session) => session.threadId)).toEqual(['<编号|threadId>', 'thread_valid_1']);
  });

  it('lists known users across session and agent tables', () => {
    const store = makeStore();
    store.setSession('u1', 'default', 'thread_default_1', 'first prompt');
    store.createAgent('u2', {
      agentId: 'assistant',
      name: '助理',
      workspaceDir: '/tmp/assistant',
    });

    expect(store.listKnownUsers()).toEqual(['u1', 'u2']);
  });

  it('hides system agents from list but can include them for internal logic', () => {
    const store = makeStore();
    store.createAgent('u1', {
      agentId: 'memory-onboarding',
      name: '记忆初始化引导',
      workspaceDir: '/tmp/memory-onboarding',
    });
    store.createAgent('u1', {
      agentId: 'memory-onboarding-2',
      name: '记忆初始化引导-2',
      workspaceDir: '/tmp/memory-onboarding-2',
    });
    store.createAgent('u1', {
      agentId: 'assistant',
      name: '助理',
      workspaceDir: '/tmp/assistant',
    });
    store.createAgent('u1', {
      agentId: 'agent-legacy',
      name: '记忆初始化引导',
      workspaceDir: '/tmp/legacy-onboarding',
    });

    const visible = store.listAgents('u1');
    const all = store.listAgents('u1', { includeHidden: true });
    expect(visible.some((item) => item.agentId.startsWith('memory-onboarding'))).toBe(false);
    expect(visible.some((item) => item.name === '记忆初始化引导')).toBe(false);
    expect(all.some((item) => item.agentId === 'memory-onboarding')).toBe(true);
    expect(all.some((item) => item.agentId === 'memory-onboarding-2')).toBe(true);
    expect(all.some((item) => item.agentId === 'agent-legacy')).toBe(true);
    expect(store.resolveAgentTarget('u1', 'memory-onboarding')).toBeUndefined();
    expect(store.resolveAgentTarget('u1', 'agent-legacy')).toBeUndefined();
  });

  it('persists model overrides per agent across restarts', () => {
    const pair = makeStorePair();
    const store = pair.createStore();
    store.createAgent('u1', {
      agentId: 'frontend',
      name: '前端Agent',
      workspaceDir: '/tmp/frontend',
    });

    store.setModelOverride('u1', 'default', 'gpt-5');
    store.setModelOverride('u1', 'frontend', 'gpt-5-codex');

    const reopened = pair.createStore();
    expect(reopened.getModelOverride('u1', 'default')).toBe('gpt-5');
    expect(reopened.getModelOverride('u1', 'frontend')).toBe('gpt-5-codex');

    reopened.clearModelOverride('u1', 'frontend');

    const reopenedAgain = pair.createStore();
    expect(reopenedAgain.getModelOverride('u1', 'default')).toBe('gpt-5');
    expect(reopenedAgain.getModelOverride('u1', 'frontend')).toBeUndefined();
  });

  it('persists provider overrides per agent across restarts', () => {
    const pair = makeStorePair();
    const store = pair.createStore();
    store.createAgent('u1', {
      agentId: 'frontend',
      name: '前端Agent',
      workspaceDir: '/tmp/frontend',
    });

    store.setProviderOverride('u1', 'default', 'codex');
    store.setProviderOverride('u1', 'frontend', 'opencode');

    const reopened = pair.createStore();
    expect(reopened.getProviderOverride('u1', 'default')).toBe('codex');
    expect(reopened.getProviderOverride('u1', 'frontend')).toBe('opencode');

    reopened.clearProviderOverride('u1', 'frontend');

    const reopenedAgain = pair.createStore();
    expect(reopenedAgain.getProviderOverride('u1', 'default')).toBe('codex');
    expect(reopenedAgain.getProviderOverride('u1', 'frontend')).toBeUndefined();
  });

  it('backfills seed summaries for legacy sessions after schema upgrade', () => {
    const pair = makeStorePair();
    const rawDb = new DatabaseSync(pair.filePath);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS user_session (
        user_id TEXT PRIMARY KEY,
        current_thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_history (
        user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS session_meta (
        thread_id TEXT PRIMARY KEY,
        name TEXT,
        last_prompt TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    rawDb.prepare('INSERT INTO user_history(user_id, thread_id, updated_at) VALUES(?, ?, ?)').run('u1', 'legacy_thread', 1);
    rawDb
      .prepare('INSERT INTO session_meta(thread_id, name, last_prompt, updated_at) VALUES(?, ?, ?, ?)')
      .run('legacy_thread', null, '修复飞书 session 卡片展示问题', 1);
    rawDb.close();

    const store = pair.createStore();
    const session = store.listDetailed('u1', 'default')[0];

    expect(session?.summary).toContain('修复飞书');
    expect(session?.summarySource).toBe('seed');
    expect(session?.summaryState).toBe('stable');
  });
});
