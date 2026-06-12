import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SessionStore');
const DEFAULT_AGENT_ID = 'default';
const HIDDEN_AGENT_ID_PREFIXES = ['memory-onboarding'];
const HIDDEN_AGENT_NAMES = new Set(['记忆初始化引导']);

export interface SessionListItem {
  threadId: string;
  name?: string;
  summary?: string;
  summaryState?: string;
  summarySource?: string;
  lastPrompt?: string;
  userTurnsSinceSummary?: number;
  charsSinceSummary?: number;
  updatedAt: number;
}

export interface SessionSummaryCandidate {
  threadId: string;
  summary?: string;
  lastPrompt?: string;
  summaryState: string;
  lastUserMsgAt?: number;
  userTurnsSinceSummary: number;
  charsSinceSummary: number;
}

export interface SessionState {
  threadId?: string;
  boundIdentityVersion?: string;
}

export interface AgentRecord {
  agentId: string;
  name: string;
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentListItem extends AgentRecord {
  current: boolean;
  isDefault: boolean;
}

interface SessionStoreOptions {
  defaultWorkspaceDir: string;
}

export class SessionStore {
  private readonly filePath: string;
  private readonly db: DatabaseSync;
  private readonly defaultWorkspaceDir: string;
  private lastTs = 0;

  constructor(filePath: string, options: SessionStoreOptions) {
    this.filePath = filePath;
    this.defaultWorkspaceDir = path.resolve(options.defaultWorkspaceDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);

    this.ensureSchema();

    const row = this.db.prepare('SELECT COUNT(*) AS count FROM user_session').get() as { count: number };
    log.info('SessionStore 已加载(SQLite)', {
      filePath: this.filePath,
      sessionCount: row.count,
    });
  }

  getCurrentAgent(userId: string): AgentRecord {
    const selected = this.db
      .prepare('SELECT agent_id AS agentId FROM user_current_agent WHERE user_id = ?')
      .get(userId) as { agentId?: string } | undefined;
    const agentId = selected?.agentId ?? DEFAULT_AGENT_ID;
    const custom = this.getCustomAgent(userId, agentId);
    return custom ?? this.getDefaultAgent();
  }

  listAgents(userId: string, options: { includeHidden?: boolean } = {}): AgentListItem[] {
    const includeHidden = options.includeHidden ?? false;
    const currentAgentId = this.getCurrentAgent(userId).agentId;
    const rows = this.db
      .prepare(`
        SELECT
          agent_id AS agentId,
          name,
          workspace_dir AS workspaceDir,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM user_agent
        WHERE user_id = ?
        ORDER BY updated_at DESC, created_at DESC
      `)
      .all(userId) as Array<Record<string, unknown>>;

    const customAgents = rows
      .map((row) => ({
      agentId: String(row.agentId ?? ''),
      name: String(row.name ?? ''),
      workspaceDir: String(row.workspaceDir ?? ''),
      createdAt: numberRow(row.createdAt),
      updatedAt: numberRow(row.updatedAt),
      current: currentAgentId === row.agentId,
      isDefault: false,
      }))
      .filter((agent) => includeHidden || !isHiddenAgent(agent));

    return [
      {
        ...this.getDefaultAgent(),
        current: currentAgentId === DEFAULT_AGENT_ID,
        isDefault: true,
      },
      ...customAgents,
    ];
  }

  listKnownUsers(): string[] {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT user_id AS userId FROM (
          SELECT user_id FROM user_session
          UNION
          SELECT user_id FROM user_history
          UNION
          SELECT user_id FROM user_current_agent
          UNION
          SELECT user_id FROM user_agent
          UNION
          SELECT user_id FROM user_agent_settings
          UNION
          SELECT user_id FROM user_agent_session
          UNION
          SELECT user_id FROM user_agent_history
        )
        ORDER BY user_id ASC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.userId ?? '')).filter(Boolean);
  }

  createAgent(userId: string, input: { agentId: string; name: string; workspaceDir: string }): AgentRecord {
    const now = this.nextTimestamp();
    this.db
      .prepare(`
        INSERT INTO user_agent(user_id, agent_id, name, workspace_dir, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `)
      .run(userId, input.agentId, input.name.trim(), path.resolve(input.workspaceDir), now, now);

    return {
      agentId: input.agentId,
      name: input.name.trim(),
      workspaceDir: path.resolve(input.workspaceDir),
      createdAt: now,
      updatedAt: now,
    };
  }

  setCurrentAgent(userId: string, agentId: string): boolean {
    if (agentId !== DEFAULT_AGENT_ID && !this.getCustomAgent(userId, agentId)) {
      return false;
    }
    this.db
      .prepare(`
        INSERT INTO user_current_agent(user_id, agent_id, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          updated_at = excluded.updated_at
      `)
      .run(userId, agentId, this.nextTimestamp());
    return true;
  }

  resolveAgentTarget(userId: string, target: string): string | undefined {
    const raw = target.trim();
    if (!raw) {
      return undefined;
    }
    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      if (index <= 0) {
        return undefined;
      }
      return this.listAgents(userId)[index - 1]?.agentId;
    }
    if (raw === DEFAULT_AGENT_ID) {
      return DEFAULT_AGENT_ID;
    }
    if (isHiddenAgentId(raw)) {
      return undefined;
    }
    const custom = this.getCustomAgent(userId, raw);
    if (!custom) {
      return undefined;
    }
    if (isHiddenAgent(custom)) {
      return undefined;
    }
    return custom.agentId;
  }

  getSession(userId: string, agentId: string): string | undefined {
    return this.getSessionState(userId, agentId).threadId;
  }

  getSessionState(userId: string, agentId: string): SessionState {
    const row = this.db
      .prepare(`
        SELECT current_thread_id AS threadId, bound_identity_version AS boundIdentityVersion
        FROM user_agent_session
        WHERE user_id = ? AND agent_id = ?
      `)
      .get(userId, agentId) as { threadId?: string; boundIdentityVersion?: string } | undefined;
    if (row?.threadId) {
      return {
        threadId: row.threadId,
        boundIdentityVersion: typeof row.boundIdentityVersion === 'string' && row.boundIdentityVersion
          ? row.boundIdentityVersion
          : undefined,
      };
    }
    if (agentId === DEFAULT_AGENT_ID) {
      return this.getLegacySessionState(userId);
    }
    return {};
  }

  getModelOverride(userId: string, agentId: string): string | undefined {
    const row = this.db
      .prepare(`
        SELECT model_override AS modelOverride
        FROM user_agent_settings
        WHERE user_id = ? AND agent_id = ?
      `)
      .get(userId, agentId) as { modelOverride?: string | null } | undefined;
    return typeof row?.modelOverride === 'string' && row.modelOverride ? row.modelOverride : undefined;
  }

  getProviderOverride(userId: string, agentId: string): 'codex' | 'opencode' | undefined {
    const row = this.db
      .prepare(`
        SELECT provider_override AS providerOverride
        FROM user_agent_settings
        WHERE user_id = ? AND agent_id = ?
      `)
      .get(userId, agentId) as { providerOverride?: string | null } | undefined;
    return row?.providerOverride === 'codex' || row?.providerOverride === 'opencode'
      ? row.providerOverride
      : undefined;
  }

  setModelOverride(userId: string, agentId: string, model: string): void {
    this.db
      .prepare(`
        INSERT INTO user_agent_settings(user_id, agent_id, model_override, provider_override, updated_at)
        VALUES(?, ?, ?, COALESCE((SELECT provider_override FROM user_agent_settings WHERE user_id = ? AND agent_id = ?), NULL), ?)
        ON CONFLICT(user_id, agent_id) DO UPDATE SET
          model_override = excluded.model_override,
          updated_at = excluded.updated_at
      `)
      .run(userId, agentId, model.trim(), userId, agentId, this.nextTimestamp());
  }

  setProviderOverride(userId: string, agentId: string, provider: 'codex' | 'opencode'): void {
    this.db
      .prepare(`
        INSERT INTO user_agent_settings(user_id, agent_id, model_override, provider_override, updated_at)
        VALUES(?, ?, COALESCE((SELECT model_override FROM user_agent_settings WHERE user_id = ? AND agent_id = ?), NULL), ?, ?)
        ON CONFLICT(user_id, agent_id) DO UPDATE SET
          provider_override = excluded.provider_override,
          updated_at = excluded.updated_at
      `)
      .run(userId, agentId, userId, agentId, provider, this.nextTimestamp());
  }

  clearModelOverride(userId: string, agentId: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE user_agent_settings
        SET model_override = NULL, updated_at = ?
        WHERE user_id = ? AND agent_id = ?
      `)
      .run(this.nextTimestamp(), userId, agentId) as { changes?: number };
    this.cleanupEmptySettings(userId, agentId);
    return (result.changes ?? 0) > 0;
  }

  clearProviderOverride(userId: string, agentId: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE user_agent_settings
        SET provider_override = NULL, updated_at = ?
        WHERE user_id = ? AND agent_id = ?
      `)
      .run(this.nextTimestamp(), userId, agentId) as { changes?: number };
    this.cleanupEmptySettings(userId, agentId);
    return (result.changes ?? 0) > 0;
  }

  setSession(
    userId: string,
    agentId: string,
    threadId: string,
    lastPrompt?: string,
    options: { boundIdentityVersion?: string } = {},
  ): void {
    const now = this.nextTimestamp();
    this.withTransaction(() => {
      this.db
        .prepare(`
          INSERT INTO user_agent_session(user_id, agent_id, current_thread_id, bound_identity_version, updated_at)
          VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(user_id, agent_id) DO UPDATE SET
            current_thread_id = excluded.current_thread_id,
            bound_identity_version = excluded.bound_identity_version,
            updated_at = excluded.updated_at
        `)
        .run(userId, agentId, threadId, options.boundIdentityVersion ?? null, now);

      this.db
        .prepare(`
          INSERT INTO user_agent_history(user_id, agent_id, thread_id, updated_at)
          VALUES(?, ?, ?, ?)
          ON CONFLICT(user_id, agent_id, thread_id) DO UPDATE SET
            updated_at = excluded.updated_at
        `)
        .run(userId, agentId, threadId, now);

      this.upsertSessionMeta(threadId, lastPrompt, now);

      this.db
        .prepare(`
          DELETE FROM user_agent_history
          WHERE user_id = ?
            AND agent_id = ?
            AND thread_id IN (
              SELECT thread_id
              FROM user_agent_history
              WHERE user_id = ?
                AND agent_id = ?
              ORDER BY updated_at DESC
              LIMIT -1 OFFSET 20
            )
        `)
        .run(userId, agentId, userId, agentId);

      if (agentId === DEFAULT_AGENT_ID) {
        this.persistLegacySession(userId, threadId, lastPrompt, now, options.boundIdentityVersion);
      }

      if (agentId !== DEFAULT_AGENT_ID) {
        this.db
          .prepare('UPDATE user_agent SET updated_at = ? WHERE user_id = ? AND agent_id = ?')
          .run(now, userId, agentId);
      }
    });
  }

  clearSession(userId: string, agentId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM user_agent_session WHERE user_id = ? AND agent_id = ?')
      .run(userId, agentId) as { changes?: number };
    if (agentId === DEFAULT_AGENT_ID) {
      this.db.prepare('DELETE FROM user_session WHERE user_id = ?').run(userId);
    }
    return (result.changes ?? 0) > 0;
  }

  listDetailed(userId: string, agentId: string): SessionListItem[] {
    const rows = this.db
      .prepare(`
        SELECT
          h.thread_id AS threadId,
          m.name AS name,
          m.summary AS summary,
          m.summary_state AS summaryState,
          m.summary_source AS summarySource,
          m.last_prompt AS lastPrompt,
          m.user_turns_since_summary AS userTurnsSinceSummary,
          m.chars_since_summary AS charsSinceSummary,
          COALESCE(m.updated_at, h.updated_at) AS updatedAt
        FROM user_agent_history h
        LEFT JOIN session_meta m ON m.thread_id = h.thread_id
        WHERE h.user_id = ?
          AND h.agent_id = ?
        ORDER BY h.updated_at DESC
        LIMIT 20
      `)
      .all(userId, agentId) as Array<Record<string, unknown>>;
    if (rows.length > 0 || agentId !== DEFAULT_AGENT_ID) {
      return rows.map(mapSessionListItem);
    }
    return this.listLegacyDetailed(userId);
  }

  resolveSwitchTarget(userId: string, agentId: string, target: string): string | undefined {
    const raw = target.trim();
    if (!raw) {
      return undefined;
    }
    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      if (index <= 0) {
        return undefined;
      }
      const list = this.listDetailed(userId, agentId);
      return list[index - 1]?.threadId;
    }
    return raw;
  }

  renameSession(targetThreadId: string, name: string): boolean {
    const normalized = name.trim();
    if (!normalized) {
      return false;
    }
    this.db
      .prepare(`
        INSERT INTO session_meta(thread_id, name, summary_state, summary_source, last_prompt, updated_at)
        VALUES(?, ?, 'manual_locked', 'manual', NULL, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          name = excluded.name,
          summary_state = excluded.summary_state,
          summary_source = excluded.summary_source,
          updated_at = excluded.updated_at
      `)
      .run(targetThreadId, normalized, this.nextTimestamp());
    return true;
  }

  recordSessionActivity(
    threadId: string,
    input: {
      role: 'user' | 'assistant';
      text?: string;
      timestamp?: number;
    },
  ): void {
    const now = input.timestamp ?? this.nextTimestamp();
    const normalizedText = (input.text ?? '').trim();
    const charCount = normalizedText.length;
    const userTurnIncrement = input.role === 'user' ? 1 : 0;
    this.db
      .prepare(`
        INSERT INTO session_meta(
          thread_id,
          name,
          summary,
          summary_state,
          summary_source,
          last_user_msg_at,
          last_assistant_msg_at,
          user_turns_since_summary,
          chars_since_summary,
          last_prompt,
          updated_at
        )
        VALUES(?, NULL, NULL, 'pending_init', NULL, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          last_user_msg_at = CASE
            WHEN ? = 'user' THEN ?
            ELSE session_meta.last_user_msg_at
          END,
          last_assistant_msg_at = CASE
            WHEN ? = 'assistant' THEN ?
            ELSE session_meta.last_assistant_msg_at
          END,
          user_turns_since_summary = session_meta.user_turns_since_summary + ?,
          chars_since_summary = session_meta.chars_since_summary + ?,
          summary_state = CASE
            WHEN session_meta.summary_state = 'manual_locked' THEN session_meta.summary_state
            WHEN (
              session_meta.summary_state = 'pending_init'
              AND (
                session_meta.user_turns_since_summary + ? >= 2
                OR session_meta.chars_since_summary + ? >= 300
              )
            ) THEN 'dirty'
            WHEN (
              session_meta.summary_state = 'stable'
              AND (
                session_meta.user_turns_since_summary + ? >= 3
                OR session_meta.chars_since_summary + ? >= 800
              )
            ) THEN 'dirty'
            ELSE session_meta.summary_state
          END,
          updated_at = ?
      `)
      .run(
        threadId,
        input.role === 'user' ? now : null,
        input.role === 'assistant' ? now : null,
        userTurnIncrement,
        charCount,
        now,
        input.role,
        now,
        input.role,
        now,
        userTurnIncrement,
        charCount,
        userTurnIncrement,
        charCount,
        userTurnIncrement,
        charCount,
        now,
      );
  }

  listSummaryCandidates(input: {
    now?: number;
    quietWindowMs?: number;
    limit?: number;
  } = {}): SessionSummaryCandidate[] {
    const now = input.now ?? Date.now();
    const quietBefore = now - (input.quietWindowMs ?? 60_000);
    const limit = input.limit ?? 20;
    const rows = this.db
      .prepare(`
        SELECT
          thread_id AS threadId,
          summary,
          last_prompt AS lastPrompt,
          summary_state AS summaryState,
          last_user_msg_at AS lastUserMsgAt,
          user_turns_since_summary AS userTurnsSinceSummary,
          chars_since_summary AS charsSinceSummary
        FROM session_meta
        WHERE summary_state IN ('pending_init', 'dirty')
          AND (last_user_msg_at IS NULL OR last_user_msg_at <= ?)
          AND (
            (summary_state = 'pending_init' AND (user_turns_since_summary >= 2 OR chars_since_summary >= 300))
            OR
            (summary_state = 'dirty' AND (user_turns_since_summary >= 2 OR chars_since_summary >= 300))
          )
        ORDER BY COALESCE(last_user_msg_at, updated_at) DESC
        LIMIT ?
      `)
      .all(quietBefore, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      threadId: String(row.threadId ?? ''),
      summary: typeof row.summary === 'string' ? row.summary : undefined,
      lastPrompt: typeof row.lastPrompt === 'string' ? row.lastPrompt : undefined,
      summaryState: typeof row.summaryState === 'string' ? row.summaryState : 'pending_init',
      lastUserMsgAt: typeof row.lastUserMsgAt === 'number' ? row.lastUserMsgAt : undefined,
      userTurnsSinceSummary: typeof row.userTurnsSinceSummary === 'number' ? row.userTurnsSinceSummary : 0,
      charsSinceSummary: typeof row.charsSinceSummary === 'number' ? row.charsSinceSummary : 0,
    }));
  }

  updateSessionSummary(
    threadId: string,
    input: {
      summary: string;
      source?: 'llm' | 'seed' | 'manual';
      state?: 'stable' | 'dirty' | 'pending_init' | 'manual_locked';
      timestamp?: number;
    },
  ): void {
    const now = input.timestamp ?? this.nextTimestamp();
    this.db
      .prepare(`
        UPDATE session_meta
        SET
          summary = ?,
          summary_source = ?,
          summary_state = ?,
          summary_updated_at = ?,
          user_turns_since_summary = 0,
          chars_since_summary = 0,
          summary_error_count = 0,
          summary_refresh_after = NULL,
          updated_at = ?
        WHERE thread_id = ?
      `)
      .run(input.summary.trim(), input.source ?? 'llm', input.state ?? 'stable', now, now, threadId);
  }

  markSummaryRefreshFailed(threadId: string, retryAt?: number): void {
    this.db
      .prepare(`
        UPDATE session_meta
        SET
          summary_state = 'dirty',
          summary_error_count = summary_error_count + 1,
          summary_refresh_after = ?,
          updated_at = ?
        WHERE thread_id = ?
      `)
      .run(retryAt ?? null, this.nextTimestamp(), threadId);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_session (
        user_id TEXT PRIMARY KEY,
        current_thread_id TEXT NOT NULL,
        bound_identity_version TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_history (
        user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_history_user_updated
        ON user_history(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_meta (
        thread_id TEXT PRIMARY KEY,
        name TEXT,
        summary TEXT,
        summary_state TEXT NOT NULL DEFAULT 'pending_init',
        summary_source TEXT,
        summary_updated_at INTEGER,
        last_user_msg_at INTEGER,
        last_assistant_msg_at INTEGER,
        user_turns_since_summary INTEGER NOT NULL DEFAULT 0,
        chars_since_summary INTEGER NOT NULL DEFAULT 0,
        summary_refresh_after INTEGER,
        summary_error_count INTEGER NOT NULL DEFAULT 0,
        last_prompt TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_current_agent (
        user_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_agent (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS user_agent_session (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        current_thread_id TEXT NOT NULL,
        bound_identity_version TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS user_agent_history (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, agent_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_agent_history_lookup
        ON user_agent_history(user_id, agent_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS user_agent_settings (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model_override TEXT,
        provider_override TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, agent_id)
      );
    `);

    this.ensureColumn('user_session', 'bound_identity_version', 'TEXT');
    this.ensureColumn('user_agent_session', 'bound_identity_version', 'TEXT');
    this.ensureColumn('user_agent_settings', 'provider_override', 'TEXT');
    this.ensureColumn('session_meta', 'summary', 'TEXT');
    this.ensureColumn('session_meta', 'summary_state', "TEXT NOT NULL DEFAULT 'pending_init'");
    this.ensureColumn('session_meta', 'summary_source', 'TEXT');
    this.ensureColumn('session_meta', 'summary_updated_at', 'INTEGER');
    this.ensureColumn('session_meta', 'last_user_msg_at', 'INTEGER');
    this.ensureColumn('session_meta', 'last_assistant_msg_at', 'INTEGER');
    this.ensureColumn('session_meta', 'user_turns_since_summary', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('session_meta', 'chars_since_summary', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('session_meta', 'summary_refresh_after', 'INTEGER');
    this.ensureColumn('session_meta', 'summary_error_count', 'INTEGER NOT NULL DEFAULT 0');
    this.backfillLegacySessionSummaries();
  }

  private getCustomAgent(userId: string, agentId: string): AgentRecord | undefined {
    if (agentId === DEFAULT_AGENT_ID) {
      return undefined;
    }
    const row = this.db
      .prepare(`
        SELECT
          agent_id AS agentId,
          name,
          workspace_dir AS workspaceDir,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM user_agent
        WHERE user_id = ? AND agent_id = ?
      `)
      .get(userId, agentId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      agentId: String(row.agentId ?? ''),
      name: String(row.name ?? ''),
      workspaceDir: String(row.workspaceDir ?? ''),
      createdAt: numberRow(row.createdAt),
      updatedAt: numberRow(row.updatedAt),
    };
  }

  private getDefaultAgent(): AgentRecord {
    return {
      agentId: DEFAULT_AGENT_ID,
      name: '默认Agent',
      workspaceDir: this.defaultWorkspaceDir,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  private getLegacySessionState(userId: string): SessionState {
    const row = this.db
      .prepare(`
        SELECT current_thread_id AS threadId, bound_identity_version AS boundIdentityVersion
        FROM user_session
        WHERE user_id = ?
      `)
      .get(userId) as { threadId?: string; boundIdentityVersion?: string } | undefined;
    return {
      threadId: row?.threadId,
      boundIdentityVersion: typeof row?.boundIdentityVersion === 'string' && row.boundIdentityVersion
        ? row.boundIdentityVersion
        : undefined,
    };
  }

  private listLegacyDetailed(userId: string): SessionListItem[] {
    const rows = this.db
      .prepare(`
        SELECT
          h.thread_id AS threadId,
          m.name AS name,
          m.summary AS summary,
          m.summary_state AS summaryState,
          m.summary_source AS summarySource,
          m.last_prompt AS lastPrompt,
          m.user_turns_since_summary AS userTurnsSinceSummary,
          m.chars_since_summary AS charsSinceSummary,
          COALESCE(m.updated_at, h.updated_at) AS updatedAt
        FROM user_history h
        LEFT JOIN session_meta m ON m.thread_id = h.thread_id
        WHERE h.user_id = ?
        ORDER BY h.updated_at DESC
        LIMIT 20
      `)
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(mapSessionListItem);
  }

  private persistLegacySession(
    userId: string,
    threadId: string,
    lastPrompt: string | undefined,
    now: number,
    boundIdentityVersion?: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO user_session(user_id, current_thread_id, bound_identity_version, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          current_thread_id = excluded.current_thread_id,
          bound_identity_version = excluded.bound_identity_version,
          updated_at = excluded.updated_at
      `)
      .run(userId, threadId, boundIdentityVersion ?? null, now);

    this.db
      .prepare(`
        INSERT INTO user_history(user_id, thread_id, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(user_id, thread_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `)
      .run(userId, threadId, now);

    this.db
      .prepare(`
        DELETE FROM user_history
        WHERE user_id = ?
          AND thread_id IN (
            SELECT thread_id
            FROM user_history
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT -1 OFFSET 20
          )
      `)
      .run(userId, userId);

    this.upsertSessionMeta(threadId, lastPrompt, now);
  }

  private upsertSessionMeta(threadId: string, lastPrompt: string | undefined, now: number): void {
    const normalizedPrompt = normalizePreview(lastPrompt);
    if (normalizedPrompt) {
      const seedSummary = buildSeedSummary(normalizedPrompt);
      this.db
        .prepare(`
          INSERT INTO session_meta(
            thread_id,
            name,
            summary,
            summary_state,
            summary_source,
            last_prompt,
            updated_at
          )
          VALUES(?, NULL, ?, 'pending_init', 'seed', ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            last_prompt = excluded.last_prompt,
            summary = CASE
              WHEN session_meta.summary IS NULL OR session_meta.summary = '' THEN excluded.summary
              ELSE session_meta.summary
            END,
            summary_source = CASE
              WHEN session_meta.summary IS NULL OR session_meta.summary = '' THEN excluded.summary_source
              ELSE session_meta.summary_source
            END,
            updated_at = excluded.updated_at
        `)
        .run(threadId, seedSummary, normalizedPrompt, now);
      return;
    }

    this.db
      .prepare(`
        INSERT INTO session_meta(thread_id, name, summary_state, last_prompt, updated_at)
        VALUES(?, NULL, 'pending_init', NULL, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `)
      .run(threadId, now);
  }

  private withTransaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private cleanupEmptySettings(userId: string, agentId: string): void {
    this.db
      .prepare(`
        DELETE FROM user_agent_settings
        WHERE user_id = ?
          AND agent_id = ?
          AND model_override IS NULL
          AND provider_override IS NULL
      `)
      .run(userId, agentId);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    const hasColumn = rows.some((row) => row.name === column);
    if (hasColumn) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private backfillLegacySessionSummaries(): void {
    const rows = this.db
      .prepare(`
        SELECT thread_id AS threadId, last_prompt AS lastPrompt, updated_at AS updatedAt
        FROM session_meta
        WHERE (summary IS NULL OR summary = '')
          AND last_prompt IS NOT NULL
          AND TRIM(last_prompt) != ''
      `)
      .all() as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return;
    }
    const stmt = this.db.prepare(`
      UPDATE session_meta
      SET
        summary = ?,
        summary_source = 'seed',
        summary_state = CASE
          WHEN summary_state = 'manual_locked' THEN summary_state
          ELSE 'stable'
        END,
        summary_updated_at = COALESCE(summary_updated_at, ?)
      WHERE thread_id = ?
    `);
    for (const row of rows) {
      const threadId = typeof row.threadId === 'string' ? row.threadId : '';
      const lastPrompt = typeof row.lastPrompt === 'string' ? row.lastPrompt : '';
      if (!threadId || !lastPrompt.trim()) {
        continue;
      }
      stmt.run(
        buildSeedSummary(lastPrompt),
        typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
        threadId,
      );
    }
  }

  private nextTimestamp(): number {
    const now = Date.now() * 1000;
    this.lastTs = Math.max(now, this.lastTs + 1);
    return this.lastTs;
  }
}

function normalizePreview(input?: string): string | undefined {
  const text = (input ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return undefined;
  }
  return text.length <= 80 ? text : `${text.slice(0, 80)}...`;
}

function mapSessionListItem(row: Record<string, unknown>): SessionListItem {
  return {
    threadId: String(row.threadId ?? ''),
    name: typeof row.name === 'string' ? row.name : undefined,
    summary: typeof row.summary === 'string' ? row.summary : undefined,
    summaryState: typeof row.summaryState === 'string' ? row.summaryState : undefined,
    summarySource: typeof row.summarySource === 'string' ? row.summarySource : undefined,
    lastPrompt: typeof row.lastPrompt === 'string' ? row.lastPrompt : undefined,
    userTurnsSinceSummary: typeof row.userTurnsSinceSummary === 'number' ? row.userTurnsSinceSummary : undefined,
    charsSinceSummary: typeof row.charsSinceSummary === 'number' ? row.charsSinceSummary : undefined,
    updatedAt: numberRow(row.updatedAt),
  };
}

function numberRow(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function isHiddenAgentId(agentId: string): boolean {
  return HIDDEN_AGENT_ID_PREFIXES.some((prefix) => agentId === prefix || agentId.startsWith(`${prefix}-`));
}

function isHiddenAgent(agent: { agentId: string; name: string }): boolean {
  return isHiddenAgentId(agent.agentId) || HIDDEN_AGENT_NAMES.has(agent.name.trim());
}

function buildSeedSummary(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= 18 ? normalized : `${normalized.slice(0, 18).trimEnd()}…`;
}
