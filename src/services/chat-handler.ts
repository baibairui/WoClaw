import fs from 'node:fs';
import { commandNeedsAgentList, commandNeedsDetailedSessions, handleUserCommand, maskThreadId } from '../features/user-command.js';
import path from 'node:path';
import type { AgentListItem, AgentRecord, SessionListItem } from '../stores/session-store.js';
import type { MemorySummarySnapshot } from './agent-workspace-manager.js';
import { parseCodexJsonl } from './codex-runner.js';
import { formatPaginatedCodexModelsText, loadCodexModels, resolveModelFromSnapshot } from './codex-models.js';
import { AgentSkillManager } from './agent-skill-manager.js';
import { startCodexDeviceLogin } from './codex-login-flow.js';
import { hasCliHomeAuth, hasCliHomeConfig, readCliHomeDefaultModel } from './cli-provider.js';
import {
  buildFeishuLoginChoiceMessage,
  buildFeishuRunCardMessage,
  formatCommandOutboundMessage,
} from './feishu-command-cards.js';
import { buildOpenCodeAuthSessionKey, type OpenCodeAuthFlowManager } from './opencode-auth-flow.js';
import type { SkillCatalogEntry } from './skill-registry.js';
import { parseGatewayStructuredMessage } from '../utils/gateway-message.js';
import { createLogger } from '../utils/logger.js';
import { ActiveRunManager } from './active-run-manager.js';
import type { SkillRuntimePolicy } from './codex-bwrap.js';

const log = createLogger('ChatHandler');
const GATEWAY_LOCAL_PATH_KEYS = [
  'local_image_path',
  'local_file_path',
  'local_audio_path',
  'local_media_path',
  'local_sticker_path',
] as const;

type Channel = 'wecom' | 'feishu' | 'weixin';

interface SessionStoreLike {
  getCurrentAgent(userId: string): AgentRecord;
  listAgents(userId: string, options?: { includeHidden?: boolean }): AgentListItem[];
  createAgent(userId: string, input: { agentId: string; name: string; workspaceDir: string }): AgentRecord;
  setCurrentAgent(userId: string, agentId: string): boolean;
  resolveAgentTarget(userId: string, target: string): string | undefined;
  getSession(userId: string, agentId: string): string | undefined;
  getSessionState?: (userId: string, agentId: string) => { threadId?: string; boundIdentityVersion?: string };
  setSession(
    userId: string,
    agentId: string,
    threadId: string,
    lastPrompt?: string,
    options?: { boundIdentityVersion?: string },
  ): void;
  clearSession(userId: string, agentId: string): boolean;
  getModelOverride?(userId: string, agentId: string): string | undefined;
  setModelOverride?(userId: string, agentId: string, model: string): void;
  clearModelOverride?(userId: string, agentId: string): boolean;
  getProviderOverride?(userId: string, agentId: string): 'codex' | 'opencode' | undefined;
  setProviderOverride?(userId: string, agentId: string, provider: 'codex' | 'opencode'): void;
  clearProviderOverride?(userId: string, agentId: string): boolean;
  listDetailed(userId: string, agentId: string): SessionListItem[];
  resolveSwitchTarget(userId: string, agentId: string, target: string): string | undefined;
  renameSession(targetThreadId: string, name: string): boolean;
  recordSessionActivity?(
    threadId: string,
    input: {
      role: 'user' | 'assistant';
      text?: string;
      timestamp?: number;
    },
  ): void;
}

interface RateLimitStoreLike {
  allow(key: string): boolean;
}

interface CodexRunnerLike {
  run(input: {
    prompt: string;
    threadId?: string;
    model?: string;
    search?: boolean;
    workdir?: string;
    gatewayUserId?: string;
    reminderToolContext?: {
      dbPath: string;
      channel: Channel;
      userId: string;
      agentId: string;
    };
    onMessage?: (text: string) => void;
    onThreadStarted?: (threadId: string) => void;
    skillPolicy?: SkillRuntimePolicy;
  }): Promise<{ threadId: string; rawOutput: string }>;
  runWithControl?(input: {
    prompt: string;
    threadId?: string;
    model?: string;
    search?: boolean;
    workdir?: string;
    gatewayUserId?: string;
    reminderToolContext?: {
      dbPath: string;
      channel: Channel;
      userId: string;
      agentId: string;
    };
    onMessage?: (text: string) => void;
    onThreadStarted?: (threadId: string) => void;
    skillPolicy?: SkillRuntimePolicy;
  }): {
    result: Promise<{ threadId: string; rawOutput: string }>;
    stop: (reason: string) => Promise<boolean>;
  };
  review(input: {
    mode: 'uncommitted' | 'base' | 'commit';
    target?: string;
    prompt?: string;
    model?: string;
    search?: boolean;
    workdir?: string;
    onMessage?: (text: string) => void;
    skillPolicy?: SkillRuntimePolicy;
  }): Promise<{ rawOutput: string }>;
  login(input: {
    onMessage?: (text: string) => void;
  }): Promise<void>;
  listModels?(): Promise<{
    fetchedAt?: string;
    models: Array<{
      slug: string;
      visibility: 'list' | 'hide' | string;
      supportedInApi: boolean;
    }>;
  }>;
  getProvider?(): 'codex' | 'opencode';
}

interface WorkspacePublisherLike {
  publish(): Promise<{ output: string }>;
}

interface SpeechServiceLike {
  processInboundAudio?(input: {
    prompt: string;
    channel: Channel;
    userId: string;
    workspaceDir: string;
  }): Promise<
    | { type: 'continue'; prompt: string }
    | { type: 'reply'; message: string }
    | undefined
  >;
}

interface AgentWorkspaceManagerLike {
  createWorkspace(input: {
    userId: string;
    agentName: string;
    existingAgentIds: string[];
    template?: 'default' | 'memory-onboarding' | 'skill-onboarding';
  }): { agentId: string; workspaceDir: string };
  ensureDefaultWorkspace?(userId: string): { agentId: string; workspaceDir: string };
  repairWorkspaceScaffold?(workspaceDir: string): void;
  isSharedMemoryEmpty(userId: string): boolean;
  isWorkspaceIdentityEmpty?(workspaceDir: string): boolean;
  getSharedMemorySnapshot?: (userId: string) => {
    sharedMemoryDir: string;
    identityContent: string;
    identityVersion: string;
    hasIdentity: boolean;
  };
  getIdentitySnapshot?: (userId: string, workspaceDir: string) => {
    sharedMemoryDir: string;
    identityContent: string;
    identityVersion: string;
    hasIdentity: boolean;
  };
  getMemorySummary?: (userId: string, workspaceDir: string) => MemorySummarySnapshot;
}

interface ChatHandlerDeps {
  sessionStore: SessionStoreLike;
  rateLimitStore: RateLimitStoreLike;
  codexRunner: CodexRunnerLike;
  codexHomeDir?: string;
  agentWorkspaceManager: AgentWorkspaceManagerLike;
  workspacePublisher?: WorkspacePublisherLike;
  runnerEnabled: boolean;
  defaultModel?: string;
  defaultProvider?: 'codex' | 'opencode';
  resolveDefaultModel?: (provider: 'codex' | 'opencode') => string | undefined;
  resolveRunner?: (provider: 'codex' | 'opencode') => CodexRunnerLike;
  resolveRunnerHomeDir?: (provider: 'codex' | 'opencode') => string | undefined;
  defaultSearch: boolean;
  reminderDbPath: string;
  sendText: (channel: Channel, userId: string, content: string) => Promise<void>;
  sendTextWithResult?: (channel: Channel, userId: string, content: string) => Promise<string | undefined>;
  sendStreamingText?: (
    channel: Channel,
    userId: string,
    streamId: string,
    content: string,
    done: boolean,
  ) => Promise<void>;
  skillManager?: {
    listEffectiveSkills(workspaceDir: string): SkillCatalogEntry[];
    listGlobalSkills(workspaceDir: string): SkillCatalogEntry[];
    listAgentLocalSkills(workspaceDir: string): SkillCatalogEntry[];
    disableGlobalSkill(workspaceDir: string, skillName: string): { ok: boolean; reason?: string };
    enableGlobalSkill(workspaceDir: string, skillName: string): { ok: boolean; reason?: string };
    disableAgentSkill(workspaceDir: string, skillName: string): { ok: boolean; reason?: string };
    getPolicy?(workspaceDir: string): SkillRuntimePolicy;
  };
  openCodeAuthFlowManager?: OpenCodeAuthFlowManager;
  speechService?: SpeechServiceLike;
  ttsService?: {
    synthesize(input: {
      text: string;
      workspaceDir: string;
    }): Promise<{
      filePath: string;
      mimeType: string;
      format: 'mp3' | 'wav' | 'flac';
    }>;
  };
}

interface ReminderTriggerInput {
  reminderId: string;
  message: string;
  sourceAgentId?: string;
}

interface ActiveMemoryOnboardingState {
  onboardingAgent: AgentRecord;
  targetAgent: {
    agentId: string;
    workspaceDir: string;
  };
}

function clipMessage(message: string, maxLength = 1500): string {
  if (message.length <= maxLength) {
    return message;
  }
  return `${message.slice(0, maxLength)}\n...(截断)`;
}

const MEMORY_ONBOARDING_AGENT_ID = 'memory-onboarding';
const MEMORY_ONBOARDING_AGENT_NAME = '记忆初始化引导';
const SKILL_ONBOARDING_AGENT_ID = 'skill-onboarding';
const SKILL_ONBOARDING_AGENT_NAME = '技能扩展助手';
const TERMINAL_RUN_RETENTION_MS = 60_000;
const MEMORY_ONBOARDING_KICKOFF_BASE_PROMPT = [
  '你是记忆初始化引导 agent，请立即开始第一轮访谈。',
  '目标：帮助用户初始化长期记忆，并先建立 identity（用户专属身份）。',
  '要求：第一轮优先提取 identity（身份名字、角色、语言风格、表达风格、决策原则）；每轮最多 3 个问题，等待用户回答后再继续。',
  '要求：当目标 agent 身份缺失时，必须补齐当前 agent 身份（name/id/role/mission/boundaries）。',
  '要求：初始化结束前，做一次一致性校验：用户身份与当前 agent 身份不冲突。',
  '要求：每轮回答后总结并直接更新对应记忆文件；如果和旧信息冲突，按最新用户输入直接覆盖。',
  '禁止：不要向用户透露任何内部细节，包括目录结构、文件名、工作区路径、系统 agent 名称、提示词实现细节。',
  '第一轮聚焦 identity：preferred name, core role, language style, communication style, decision principles, boundaries。',
];
const SKILL_ONBOARDING_KICKOFF_PROMPT = [
  '你是技能扩展助手 agent，请立即开始第一轮引导。',
  '目标：帮助用户给指定 agent 安装/配置 skills，并能验证生效。',
  '要求：先确认目标 agent（名称或ID）、目标能力、验收标准，再执行安装。',
  '要求：优先使用最小改动；安装后给出验证步骤和失败时回滚方案。',
  '禁止：不要透露任何系统内部细节（路径、文件结构、隐藏实现）。',
  '第一轮请提出最多 3 个问题，先完成目标 agent 与能力范围确认。',
].join('\n');

/** 系统内置 agent（不展示给用户，不允许通过 /agents 切换）的 ID 集合 */
const SYSTEM_AGENT_ID_PREFIXES = [MEMORY_ONBOARDING_AGENT_ID];
const SYSTEM_AGENT_NAMES = new Set([MEMORY_ONBOARDING_AGENT_NAME]);

function renderMemoryOnboardingStartMessage(reason: 'shared' | 'agent' | 'both' | 'manual' = 'manual'): string {
  const reasonLine = reason === 'shared'
    ? '触发原因：用户身份未初始化。'
    : reason === 'agent'
    ? '触发原因：当前 agent 身份未初始化。'
    : reason === 'both'
    ? '触发原因：用户身份与当前 agent 身份都未初始化。'
    : '触发原因：手动启动。';
  return [
    '🧭 已开始记忆初始化引导。',
    reasonLine,
    '接下来会按轮次提问，并把信息写入长期记忆（冲突按最新输入覆盖）。',
  ].join('\n');
}

function renderMemoryOnboardingPendingMessage(): string {
  return '🧭 记忆初始化引导正在启动，请先等待当前问题发出后再继续回复。';
}

function renderMemoryOnboardingResumeMessage(): string {
  return '🧭 记忆初始化已在进行中，请继续回答当前问题即可。';
}

function renderMemoryOnboardingSuggestion(reason: 'shared' | 'agent' | 'both'): string {
  const reasonLine = reason === 'shared'
    ? '检测到用户身份尚未初始化。'
    : reason === 'agent'
    ? '检测到当前 agent 身份尚未初始化。'
    : '检测到用户身份和当前 agent 身份都尚未初始化。';
  return [
    `🧭 ${reasonLine}`,
    '当前不会自动劫持到隐藏初始化 agent，先继续按当前 agent 执行。',
    '如需补齐初始化，请手动执行 `/agent init-memory`。',
  ].join('\n');
}

function renderSkillOnboardingStartMessage(agent: { name: string; agentId: string; workspaceDir: string }): string {
  return [
    `🛠️ 已切换到技能扩展助手：${agent.name} (${agent.agentId})`,
    `工作区：${agent.workspaceDir}`,
    '你可以直接说：要给哪个 agent 安装什么 skill。',
  ].join('\n');
}

function renderSkillOnboardingResumeMessage(agent: { name: string; agentId: string; workspaceDir: string }): string {
  return [
    `🛠️ 已切换到技能扩展助手：${agent.name} (${agent.agentId})`,
    `工作区：${agent.workspaceDir}`,
    '该助手已有进行中的会话，请继续描述目标能力。',
  ].join('\n');
}

function isSystemAgentId(agentId: string): boolean {
  return SYSTEM_AGENT_ID_PREFIXES.some((prefix) => agentId === prefix || agentId.startsWith(`${prefix}-`));
}

function isSystemAgentRecord(agent: { agentId: string; name?: string }): boolean {
  const byId = isSystemAgentId(agent.agentId);
  const byName = typeof agent.name === 'string' && SYSTEM_AGENT_NAMES.has(agent.name.trim());
  return byId || byName;
}

function resolveAgentWorkdir(agent: { agentId: string; workspaceDir: string }): string {
  return agent.workspaceDir;
}

function resolveRuntimeAgent(
  agentWorkspaceManager: AgentWorkspaceManagerLike | undefined,
  userId: string,
  agent: AgentRecord,
): AgentRecord {
  let runtimeAgent = agent;
  if (agent.agentId === 'default') {
    const ensured = agentWorkspaceManager?.ensureDefaultWorkspace?.(userId);
    if (ensured?.workspaceDir) {
      runtimeAgent = {
        ...agent,
        workspaceDir: ensured.workspaceDir,
      };
    }
  }

  const workspaceDir = runtimeAgent.workspaceDir?.trim()
    ? path.resolve(runtimeAgent.workspaceDir)
    : runtimeAgent.workspaceDir;
  if (workspaceDir && !fs.existsSync(workspaceDir)) {
    log.warn('runtime agent workspace missing, repairing scaffold', {
      userId,
      agentId: runtimeAgent.agentId,
      workspaceDir,
    });
    agentWorkspaceManager?.repairWorkspaceScaffold?.(workspaceDir);
  }

  return {
    ...runtimeAgent,
    workspaceDir,
  };
}

function sanitizeOnboardingText(text: string): string {
  const pathLike = /`[^`\n]*\/[^`\n]*`/g;
  const mdFileLike = /`[^`\n]+\.md`/g;
  return text
    .replace(pathLike, '`[内部路径]`')
    .replace(mdFileLike, '`[记忆文件]`')
    .replace(/shared-memory|user\.md|soul\.md|memory\/|AGENTS\.md|agent\.md|profile\.md|preferences\.md|projects\.md|relationships\.md|decisions\.md|open-loops\.md/gi, '长期记忆');
}

type ReplyMode = 'audio';

function extractReplyModeDirective(text: string): {
  replyMode?: ReplyMode;
  cleanedText: string;
} {
  if (!text.trim() || parseGatewayStructuredMessage(text)) {
    return {
      cleanedText: text,
    };
  }

  const pattern = /(?:^|\n)\s*reply_mode\s*=\s*(audio)\s*(?=\n|$)/i;
  const match = text.match(pattern);
  if (!match) {
    return {
      cleanedText: text,
    };
  }

  const cleanedText = text
    .replace(/(?:^|\n)\s*reply_mode\s*=\s*audio\s*(?=\n|$)/ig, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    replyMode: 'audio',
    cleanedText,
  };
}

function resolveUserKey(userId: string): string {
  const normalized = userId.trim();
  return normalized || 'anonymous-user';
}

function formatAgentVisibleReply(agent: { name: string }, text: string): string {
  if (!text.trim()) {
    return text;
  }
  if (parseGatewayStructuredMessage(text)) {
    return text;
  }
  if (isSystemAgentRecord({ agentId: '', name: agent.name })) {
    return text;
  }
  const visibleName = agent.name.trim() === '默认Agent' ? '默认助手' : agent.name.trim();
  const prefix = `${visibleName} ·\n`;
  if (text.startsWith(prefix)) {
    return text;
  }
  return `${prefix}${text}`;
}

function rewriteGatewayStructuredLocalPaths(rawText: string, workspaceDir: string): string {
  const structured = parseGatewayStructuredMessage(rawText);
  if (!structured || structured.op === 'recall' || typeof structured.content === 'string') {
    return rawText;
  }

  const rewrittenContent = rewriteGatewayLocalPathContent(structured.content, workspaceDir);
  if (rewrittenContent === structured.content) {
    return rawText;
  }

  if (structured.op === 'update') {
    return JSON.stringify({
      __gateway_message__: true,
      op: 'update',
      message_id: structured.message_id,
      msg_type: structured.msg_type,
      content: rewrittenContent,
    });
  }

  return JSON.stringify({
    __gateway_message__: true,
    msg_type: structured.msg_type,
    content: rewrittenContent,
  });
}

function rewriteGatewayLocalPathContent(
  content: Record<string, unknown>,
  workspaceDir: string,
): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = { ...content };
  for (const key of GATEWAY_LOCAL_PATH_KEYS) {
    const value = next[key];
    if (typeof value !== 'string') {
      continue;
    }
    const rewritten = rewriteSandboxWorkspacePath(value, workspaceDir);
    if (rewritten !== value) {
      next[key] = rewritten;
      changed = true;
    }
  }
  return changed ? next : content;
}

function rewriteSandboxWorkspacePath(rawPath: string, workspaceDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '/workspace') {
    return workspaceDir;
  }
  if (!trimmed.startsWith('/workspace/')) {
    return rawPath;
  }
  const relativePath = trimmed.slice('/workspace/'.length);
  return path.join(workspaceDir, relativePath);
}

async function stageInboundLocalPaths(prompt: string, workspaceDir: string): Promise<string> {
  const matches = Array.from(prompt.matchAll(/\b(local_(?:image|file|audio|media|sticker)_path)=([^\n\r]+)/g));
  if (matches.length === 0) {
    return prompt;
  }

  let changed = false;
  let nextPrompt = prompt;
  for (const match of matches) {
    const key = match[1];
    const sourcePath = match[2];
    if (!key || !sourcePath) {
      continue;
    }
    const stagedPath = await stageLocalPathIntoWorkspace(sourcePath, workspaceDir);
    if (!stagedPath || stagedPath === sourcePath) {
      continue;
    }
    nextPrompt = nextPrompt.replace(`${key}=${sourcePath}`, `${key}=${stagedPath}`);
    changed = true;
  }
  return changed ? nextPrompt : prompt;
}

async function stageLocalPathIntoWorkspace(sourcePath: string, workspaceDir: string): Promise<string | undefined> {
  const normalizedSource = sourcePath.trim();
  if (!normalizedSource || normalizedSource.startsWith(workspaceDir) || !fs.existsSync(normalizedSource)) {
    return normalizedSource || undefined;
  }

  const stagedDir = path.join(workspaceDir, '.gateway-inbox');
  await fs.promises.mkdir(stagedDir, { recursive: true });
  const parsed = path.parse(normalizedSource);
  const stagedPath = path.join(
    stagedDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${parsed.ext || ''}`,
  );
  await fs.promises.copyFile(normalizedSource, stagedPath);
  return stagedPath;
}

function formatMemorySummary(agent: AgentRecord, snapshot: MemorySummarySnapshot): string {
  const sharedLines = snapshot.shared.length > 0
    ? snapshot.shared.map((entry, index) => `${index + 1}. ${entry.fileName}: ${entry.summary}`)
    : ['(当前没有已初始化的用户身份内容)'];
  const agentLines = snapshot.agent.length > 0
    ? snapshot.agent.map((entry, index) => `${index + 1}. ${entry.fileName}: ${entry.summary}`)
    : ['(当前 agent 身份与短期记忆还没有可展示内容)'];
  return [
    `当前 agent：${agent.name} (${agent.agentId})`,
    `工作区：${agent.workspaceDir}`,
    '',
    '【User Identity】',
    ...sharedLines,
    '',
    '【Agent Identity】',
    ...agentLines,
  ].join('\n');
}

function buildAgentProgressText(agent: { name: string }, phase: 'received' | 'reminder' | 'done'): string {
  if (phase === 'received') {
    return formatAgentVisibleReply(agent, '⏳ 已接收请求，正在处理...');
  }
  if (phase === 'reminder') {
    return formatAgentVisibleReply(agent, '⏳ 已收到定时任务，正在处理...');
  }
  return formatAgentVisibleReply(agent, '✅ 已处理完成。');
}

function buildGatewayUpdateMessage(messageId: string, content: string): string {
  const structured = parseGatewayStructuredMessage(content);
  if (!structured || structured.op === 'recall') {
    return content;
  }
  return JSON.stringify({
    __gateway_message__: true,
    op: 'update',
    message_id: messageId,
    msg_type: structured.msg_type,
    content: structured.content,
  });
}

function buildGatewayRecallMessage(messageId: string): string {
  return JSON.stringify({
    __gateway_message__: true,
    op: 'recall',
    message_id: messageId,
  });
}

function isInvalidThreadIdLiteral(threadId?: string): boolean {
  if (!threadId) {
    return false;
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed !== threadId) {
    return true;
  }
  return trimmed.includes('<') || trimmed.includes('>');
}

function isCodexTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /codex timeout after \d+ms/i.test(message) || /codex login timeout/i.test(message);
}

type ChatFailureKind = 'interrupted' | 'timeout' | 'auth_config' | 'runner_unavailable' | 'generic';

function classifyChatFailure(error: unknown, sawAgentOutput: boolean): ChatFailureKind {
  if (sawAgentOutput) {
    return 'interrupted';
  }
  if (isCodexTimeoutError(error)) {
    return 'timeout';
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /invalid api_key|invalid base_url|invalid model|not configured|does not support gateway device auth login/.test(message)
    || /\blogin\b/.test(message)
  ) {
    return 'auth_config';
  }
  if (/\bspawn\b|enoent|eacces|command not found/.test(message)) {
    return 'runner_unavailable';
  }
  return 'generic';
}

function buildAgentInterruptedText(agent: { name: string }): string {
  return formatAgentVisibleReply(agent, '⚠️ 本次回复中断了，你可以直接回复“继续”让我接着处理。');
}

function buildAgentTimeoutText(agent: { name: string }): string {
  return formatAgentVisibleReply(agent, '⏳ 这次处理时间有点长，已暂时中断。你可以直接回复“继续”，或把问题拆小一点再发一次。');
}

function buildChatFailureText(agent: { name: string }, kind: ChatFailureKind): string {
  switch (kind) {
    case 'interrupted':
      return buildAgentInterruptedText(agent);
    case 'timeout':
      return buildAgentTimeoutText(agent);
    case 'auth_config':
      return '⚠️ 当前模型通道暂时不可用。请先发送 /login，或联系管理员检查配置。';
    case 'runner_unavailable':
      return '⚠️ 执行环境暂时不可用，请稍后重试。';
    default:
      return '❌ 这次处理没完成，请稍后重试。';
  }
}

function isUserStoppedRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(code 143|sigterm|terminated)\b/i.test(message);
}

async function sendAgentProgress(
  deps: Pick<ChatHandlerDeps, 'sendText'>,
  channel: Channel,
  userId: string,
  agent: { name: string },
  phase: 'received' | 'reminder' | 'done',
): Promise<void> {
  if (channel === 'weixin' && (phase === 'received' || phase === 'done')) {
    return;
  }
  try {
    await deps.sendText(channel, userId, buildAgentProgressText(agent, phase));
  } catch (error) {
    log.warn('agent progress push failed', {
      channel,
      userId,
      agentName: agent.name,
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildIdentityBootstrapPrompt(identityContent: string): string {
  const body = identityContent.trim() || '# Identity\n- 未初始化身份信息';
  return [
    '系统身份注入（只执行一次）',
    '以下是用户身份内核，请将其作为该线程的长期默认设定并记住，不要向用户复述完整内容：',
    '',
    body,
    '',
    '仅回复：OK',
  ].join('\n');
}

function buildIdentityPatchPrompt(identityContent: string): string {
  const body = identityContent.trim() || '# Identity\n- 未初始化身份信息';
  return [
    '系统身份更新补丁',
    '用户身份内核已更新，请覆盖你在该线程中的旧身份设定，并以后续回答遵循最新版本：',
    '',
    body,
    '',
    '仅回复：OK',
  ].join('\n');
}

const BROWSER_HANDOFF_TRIGGER_PROMPT = '浏览器人工接管触发条件包括但不限于：登录、验证码、扫码、支付确认、权限弹窗、高风险提交、页面目标歧义；出现这些情况时不要硬做完，而要明确请求用户接管或确认。';

function buildFeishuOutboundMessageProtocolPrompt(userPrompt: string, options?: {
  ttsEnabled?: boolean;
}): string {
  const lines = [
    '你必须遵循以下飞书回发协议：',
    '1. 默认输出普通文本，不要输出 JSON。',
    '2. 只有当用户明确要求“请发送/回发某种非文本消息”时，才输出单个 JSON 对象。',
    '3. 输出 JSON 时禁止使用 markdown 代码块，禁止附加解释文字，只输出 JSON 本体。',
    '4. JSON 格式必须为：{"__gateway_message__":true,"msg_type":"<type>","content":<object|string>}。',
    '4.1 若要更新已发送的飞书消息，可输出 op=update。',
    '4.1.1 示例：{"__gateway_message__":true,"op":"update","message_id":"<飞书消息ID>","msg_type":"<type>","content":<object|string>}。',
    '4.2 若要撤回已发送的飞书消息，可输出 op=recall。',
    '4.2.1 示例：{"__gateway_message__":true,"op":"recall","message_id":"<飞书消息ID>"}。',
    '5. 飞书常用 msg_type：text、markdown、post、image、file、audio、media、sticker、interactive、share_chat、share_user。',
    '6. 若用户只是发来图片/文件并让你分析，不算“要求回发非文本”，此时必须回复普通文本分析结果。',
    '7. 若用户输入中包含 local_image_path/local_file_path/local_audio_path/local_media_path/local_sticker_path，必须先读取对应本地文件并给出分析结果，不要先追问目标。',
    '8. 若明确需要回发飞书非文本消息，且你已经拿到本地文件路径，可在 JSON content 中直接提供 local_image_path/local_file_path/local_audio_path/local_media_path，网关会自动上传后发送。',
    '9. 回发飞书 interactive 时，可优先使用简写 content：{"template_id":"...","template_variable":{...}}，网关会自动转换为模板卡片格式。',
    '9.1 若使用飞书 interactive 自定义 schema 2.0 卡片，禁止使用 `tag:"action"` 或 `tag:\'action\'`。',
    '9.1.1 飞书已不再支持 `action` 这个 schema 2.0 容器。',
    '9.2 需要按钮行时，改用 `column_set` + `column` + `button`，表单提交继续使用 `form` + `button` + `action_type:"form_submit"`。',
    '10. 回发飞书 structured markdown 或 post 时，网关会统一转换为 interactive 卡片；新回复不要再把 post 当成首选格式。',
    '11. 回发飞书 sticker 时，若已有本地贴纸文件，可直接提供 local_sticker_path，网关会自动上传后发送。',
    '12. 选择消息类型时遵循：简单一句话优先 text；多段说明/列表/摘要、浏览器阶段性进度、阻塞说明和完成总结优先 interactive。',
    '12.1 若是在汇报浏览器执行中的阶段性进度，且内容天然包含 Action/Evidence/Result/Next step 这类多段结构，优先使用 interactive，并在卡片 markdown 中分段呈现。',
    '12.2 若是在请求用户接管浏览器步骤，或说明阻塞原因、风险点、待确认项，且内容天然是多段说明/清单，优先使用 interactive。',
    '12.3 若是在汇报浏览器任务已完成，并需要总结已执行动作、最终结果、产出物和后续建议，且内容天然是多段摘要，优先使用 interactive。',
    `12.4 ${BROWSER_HANDOFF_TRIGGER_PROMPT}`,
    '13. image/file/audio/media/sticker/share_chat/share_user 只在用户明确要求发送对应类型，或你已经拿到可发送资源（如 key、本地路径、分享对象ID）时使用。',
    '14. 如果不确定该用哪种类型，优先退回 text；一旦需要结构化展示，优先 interactive，不要再把 post 当默认选项。',
  ];
  if (options?.ttsEnabled) {
    lines.push('15. 若用户明确要求“语音回复/念出来/发音频”，且你本次只需要给出普通文本答案，不要输出 JSON；请在最终答案最后单独追加一行 `reply_mode=audio`。');
    lines.push('15.1 `reply_mode=audio` 仅在用户明确要求语音回复时使用；其他情况不要输出这行标记。');
  }
  return [
    ...lines,
    '',
    '用户输入如下：',
    userPrompt,
  ].join('\n');
}

function buildWeComOutboundMessageProtocolPrompt(userPrompt: string): string {
  return [
    '你必须遵循以下企微回发协议：',
    '1. 默认输出普通文本，不要输出 JSON。',
    '2. 只有当用户明确要求“请发送/回发某种非文本消息”时，才输出单个 JSON 对象。',
    '3. 输出 JSON 时禁止使用 markdown 代码块，禁止附加解释文字，只输出 JSON 本体。',
    '4. JSON 格式必须为：{"__gateway_message__":true,"msg_type":"<type>","content":<object|string>}。',
    '5. 企微常用 msg_type：text、markdown、image、voice、video、file。',
    '6. 若用户只是发来图片/文件并让你分析，不算“要求回发非文本”，此时必须回复普通文本分析结果。',
    '7. 若用户输入中包含 local_image_path/local_file_path/local_audio_path/local_media_path，可先读取对应本地文件并给出分析结果；若明确需要回发企微非文本消息，且你已经拿到本地路径，可在 JSON content 中直接提供这些路径，网关会先上传再发送。',
    '8. 选择消息类型时遵循：简单一句话优先 text；多段说明或列表优先 markdown；只有在用户明确要发送图片/语音/视频/文件时才用 image/voice/video/file。',
    '8.1 若是在汇报浏览器执行中的阶段性进度、阻塞原因、用户接管请求或完成态总结，且内容天然是多段说明/清单，优先使用 markdown。',
    `8.2 ${BROWSER_HANDOFF_TRIGGER_PROMPT}`,
    '9. image/voice/video/file 仅在用户明确要求发送对应类型，或你已拿到可发送资源（如 media_id、本地路径）时使用。',
    '10. 如果不确定该用哪种类型，优先退回 text，不要为了“看起来高级”滥用 markdown 或媒体类型。',
    '',
    '用户输入如下：',
    userPrompt,
  ].join('\n');
}

function buildWeixinOutboundMessageProtocolPrompt(userPrompt: string): string {
  return [
    '你必须遵循以下个人微信回发协议：',
    '1. 默认输出普通文本，不要输出 JSON。',
    '2. 只有当用户明确要求“请发送/回发某种非文本消息”时，才输出单个 JSON 对象。',
    '3. 输出 JSON 时禁止使用 markdown 代码块，禁止附加解释文字，只输出 JSON 本体。',
    '4. JSON 格式必须为：{"__gateway_message__":true,"msg_type":"<type>","content":<object|string>}。',
    '5. 个人微信常用 msg_type：text、image、voice、video、file。',
    '6. 若用户只是发来图片/文件/语音并让你分析，不算“要求回发非文本”，此时必须回复普通文本分析结果。',
    '7. 若用户输入中包含 local_image_path/local_file_path/local_audio_path/local_media_path，可先读取对应本地文件并给出分析结果；若明确需要回发个人微信非文本消息，且你已经拿到本地路径，可在 JSON content 中直接提供这些路径，网关会先上传再发送。',
    '8. 个人微信没有 markdown / interactive 卡片能力；简单一句话优先 text，只有在用户明确要发送图片/语音/视频/文件时才用 image/voice/video/file。',
    `8.1 ${BROWSER_HANDOFF_TRIGGER_PROMPT}`,
    '9. image/voice/video/file 仅在用户明确要求发送对应类型，或你已拿到可发送资源（如本地路径、协议字段）时使用。',
    '10. 如果不确定该用哪种类型，优先退回 text，不要为了“看起来高级”滥用媒体类型。',
    '',
    '用户输入如下：',
    userPrompt,
  ].join('\n');
}

function buildOutboundMessageProtocolPrompt(channel: Channel, userPrompt: string, options?: {
  feishuTtsEnabled?: boolean;
}): string {
  if (channel === 'feishu') {
    return buildFeishuOutboundMessageProtocolPrompt(userPrompt, {
      ttsEnabled: options?.feishuTtsEnabled,
    });
  }
  if (channel === 'weixin') {
    return buildWeixinOutboundMessageProtocolPrompt(userPrompt);
  }
  return buildWeComOutboundMessageProtocolPrompt(userPrompt);
}

function buildInboundNonTextAck(prompt: string): string | undefined {
  if (prompt.startsWith('[飞书富文本]') || prompt.includes('feishu_message_type=post')) {
    return undefined;
  }
  const patterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /^\[飞书图片]/, label: '飞书图片' },
    { regex: /^\[飞书文件]/, label: '飞书文件' },
    { regex: /^\[飞书语音]/, label: '飞书语音' },
    { regex: /^\[飞书媒体]/, label: '飞书媒体' },
    { regex: /^\[飞书表情]/, label: '飞书表情' },
    { regex: /^\[飞书卡片]/, label: '飞书卡片' },
    { regex: /^\[飞书分享群名片]/, label: '飞书分享群名片' },
    { regex: /^\[飞书分享个人名片]/, label: '飞书分享个人名片' },
    { regex: /^\[企微图片]/, label: '企微图片' },
    { regex: /^\[企微语音]/, label: '企微语音' },
    { regex: /^\[企微视频]/, label: '企微视频' },
    { regex: /^\[企微文件]/, label: '企微文件' },
    { regex: /^\[企微链接]/, label: '企微链接' },
    { regex: /^\[企微位置]/, label: '企微位置' },
  ];
  const hit = patterns.find((item) => item.regex.test(prompt));
  if (!hit) {
    return undefined;
  }
  return `✅ 已收到${hit.label}消息，正在分析处理。`;
}

function buildMemoryOnboardingKickoffPrompt(input: {
  reason: 'shared' | 'agent' | 'both' | 'manual';
  targetAgent?: { agentId: string; name: string; workspaceDir: string };
}): string {
  const lines = [...MEMORY_ONBOARDING_KICKOFF_BASE_PROMPT];
  if (input.reason === 'agent' || input.reason === 'both' || input.reason === 'manual') {
    if (input.targetAgent) {
      lines.push(
        '附加目标：如果目标 agent 的身份未初始化，请一并初始化（名称、ID、角色、工作边界）。',
        '附加要求：若模板字段缺失（mission/decision principles/success criteria），请一并补齐。',
        `目标 agent：${input.targetAgent.name} (${input.targetAgent.agentId})`,
        `目标工作区：${input.targetAgent.workspaceDir}`,
      );
    } else {
      lines.push('附加目标：如果当前 agent 的身份未初始化，请一并初始化（名称、ID、角色、工作边界）。');
    }
  }
  return lines.join('\n');
}

export function createChatHandler(deps: ChatHandlerDeps) {
  const userSearchOverrides = new Map<string, boolean>();
  const onboardingKickoffInFlight = new Set<string>();
  const activeMemoryOnboarding = new Map<string, ActiveMemoryOnboardingState>();
  const skillManager = deps.skillManager ?? new AgentSkillManager();
  const activeRunManager = new ActiveRunManager();
  const terminalRunTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function retainTerminalRun(runId: string): void {
    const existing = terminalRunTimers.get(runId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      activeRunManager.delete(runId);
      terminalRunTimers.delete(runId);
    }, TERMINAL_RUN_RETENTION_MS);
    terminalRunTimers.set(runId, timer);
  }

  function getCurrentProvider(userKey: string, agentId: string): 'codex' | 'opencode' {
    return deps.sessionStore.getProviderOverride?.(userKey, agentId)
      ?? deps.defaultProvider
      ?? deps.codexRunner.getProvider?.()
      ?? 'codex';
  }

  function getRunner(provider: 'codex' | 'opencode'): CodexRunnerLike {
    return deps.resolveRunner?.(provider) ?? deps.codexRunner;
  }

  function getRunnerLabel(provider: 'codex' | 'opencode'): string {
    return provider === 'opencode' ? 'OpenCode' : 'Codex';
  }

  function getRunnerHomeDir(provider: 'codex' | 'opencode'): string | undefined {
    return deps.resolveRunnerHomeDir?.(provider) ?? deps.codexHomeDir;
  }

  function resolveLoginAuthState(provider: 'codex' | 'opencode') {
    const homeDir = getRunnerHomeDir(provider);
    return {
      hasConfig: hasCliHomeConfig(provider, homeDir),
      hasAuth: hasCliHomeAuth(provider, homeDir),
      model: readCliHomeDefaultModel(provider, homeDir) ?? deps.resolveDefaultModel?.(provider) ?? undefined,
    };
  }

  function hasExplicitProviderSelection(userKey: string, agentId: string): boolean {
    return !!deps.sessionStore.getProviderOverride?.(userKey, agentId);
  }

  async function resolveModelsSnapshot(provider: 'codex' | 'opencode') {
    const runner = getRunner(provider);
    if (runner.listModels) {
      return runner.listModels();
    }
    return loadCodexModels();
  }

  function getSessionState(userKey: string, agentId: string): { threadId?: string; boundIdentityVersion?: string } {
    if (deps.sessionStore.getSessionState) {
      return deps.sessionStore.getSessionState(userKey, agentId);
    }
    return { threadId: deps.sessionStore.getSession(userKey, agentId) };
  }

  function getCurrentModel(userKey: string, agentId: string): string | undefined {
    return deps.sessionStore.getModelOverride?.(userKey, agentId)
      ?? deps.resolveDefaultModel?.(getCurrentProvider(userKey, agentId))
      ?? deps.defaultModel;
  }

  function persistSession(
    userKey: string,
    agentId: string,
    threadId: string,
    lastPrompt: string | undefined,
    boundIdentityVersion: string | undefined,
  ): void {
    deps.sessionStore.setSession(userKey, agentId, threadId, lastPrompt, {
      boundIdentityVersion,
    });
  }

  function recordSessionActivity(
    threadId: string | undefined,
    input: {
      role: 'user' | 'assistant';
      text?: string;
      timestamp?: number;
    },
  ): void {
    if (!threadId) {
      return;
    }
    deps.sessionStore.recordSessionActivity?.(threadId, input);
  }

  function setActiveMemoryOnboarding(
    userKey: string,
    onboardingAgent: AgentRecord,
    targetAgent: { agentId: string; workspaceDir: string },
  ): void {
    activeMemoryOnboarding.set(userKey, {
      onboardingAgent,
      targetAgent,
    });
  }

  function getActiveMemoryOnboarding(userKey: string): ActiveMemoryOnboardingState | undefined {
    return activeMemoryOnboarding.get(userKey);
  }

  function clearActiveMemoryOnboarding(userKey: string): void {
    activeMemoryOnboarding.delete(userKey);
  }

  function isMemoryOnboardingComplete(
    userKey: string,
    state: ActiveMemoryOnboardingState,
  ): boolean {
    if (deps.agentWorkspaceManager.isSharedMemoryEmpty(userKey)) {
      return false;
    }
    if (!deps.agentWorkspaceManager.isWorkspaceIdentityEmpty) {
      return true;
    }
    return !deps.agentWorkspaceManager.isWorkspaceIdentityEmpty(state.targetAgent.workspaceDir);
  }

  async function ensureIdentityBound(input: {
    channel: Channel;
    userId: string;
    sessionUserKey: string;
    agent: AgentRecord;
    model: string | undefined;
    threadId?: string;
  }): Promise<{ threadId?: string; boundIdentityVersion?: string }> {
    const { channel, userId, sessionUserKey, agent, model } = input;
    const runner = getRunner(getCurrentProvider(sessionUserKey, agent.agentId));
    const snapshot = deps.agentWorkspaceManager.getIdentitySnapshot
      ? deps.agentWorkspaceManager.getIdentitySnapshot(sessionUserKey, agent.workspaceDir)
      : deps.agentWorkspaceManager.getSharedMemorySnapshot?.(sessionUserKey);
    if (!snapshot || isSystemAgentRecord(agent)) {
      return {
        threadId: input.threadId,
        boundIdentityVersion: undefined,
      };
    }

    let threadId = input.threadId;
    const targetVersion = snapshot.identityVersion;
    const state = getSessionState(sessionUserKey, agent.agentId);
    const currentVersion = state.boundIdentityVersion;

    if (!threadId) {
      const bootstrapResult = await runner.run({
        prompt: buildIdentityBootstrapPrompt(snapshot.identityContent),
        model,
        search: false,
        workdir: resolveAgentWorkdir(agent),
        reminderToolContext: {
          channel,
          userId,
          agentId: agent.agentId,
          dbPath: deps.reminderDbPath,
        },
        onThreadStarted: (startedThreadId) => {
          persistSession(sessionUserKey, agent.agentId, startedThreadId, 'identity bootstrap', targetVersion);
        },
      });
      threadId = bootstrapResult.threadId;
      persistSession(sessionUserKey, agent.agentId, threadId, 'identity bootstrap', targetVersion);
      return { threadId, boundIdentityVersion: targetVersion };
    }

    if (currentVersion !== targetVersion) {
      const patchResult = await runner.run({
        prompt: buildIdentityPatchPrompt(snapshot.identityContent),
        threadId,
        model,
        search: false,
        workdir: resolveAgentWorkdir(agent),
        reminderToolContext: {
          channel,
          userId,
          agentId: agent.agentId,
          dbPath: deps.reminderDbPath,
        },
        onThreadStarted: (startedThreadId) => {
          persistSession(sessionUserKey, agent.agentId, startedThreadId, 'identity refresh', targetVersion);
        },
      });
      threadId = patchResult.threadId;
      persistSession(sessionUserKey, agent.agentId, threadId, 'identity refresh', targetVersion);
      return { threadId, boundIdentityVersion: targetVersion };
    }

    return { threadId, boundIdentityVersion: targetVersion };
  }

  async function runReminderTrigger(input: {
    channel: Channel;
    userId: string;
    reminder: ReminderTriggerInput;
  }): Promise<void> {
    const { channel, userId, reminder } = input;
    const sessionUserKey = resolveUserKey(userId);
    const listedAgents = deps.sessionStore.listAgents(sessionUserKey, { includeHidden: true });
    const targetAgent = reminder.sourceAgentId
      ? listedAgents.find((item) => item.agentId === reminder.sourceAgentId)
      : undefined;
    const runtimeAgent = resolveRuntimeAgent(
      deps.agentWorkspaceManager,
      sessionUserKey,
      targetAgent ?? deps.sessionStore.getCurrentAgent(sessionUserKey),
    );
    const currentModel = getCurrentModel(sessionUserKey, runtimeAgent.agentId);
    const runner = getRunner(getCurrentProvider(sessionUserKey, runtimeAgent.agentId));

    if (!deps.runnerEnabled) {
      await deps.sendText(channel, userId, `⏰ 定时提醒：${reminder.message}`);
      return;
    }

    const sessionState = getSessionState(sessionUserKey, runtimeAgent.agentId);
    const identityBinding = await ensureIdentityBound({
      channel,
      userId,
      sessionUserKey,
      agent: runtimeAgent,
      model: currentModel,
      threadId: sessionState.threadId,
    });
    const runtimeThreadId = identityBinding.threadId;
    const triggerPrompt = [
      `系统定时提醒已到期（id: ${reminder.reminderId}）。`,
      `提醒内容：${reminder.message}`,
      '请基于当前会话上下文给出提醒回复，并可附 1-2 条下一步建议。',
    ].join('\n');

    let lastStreamSend: Promise<void> = Promise.resolve();
    let sawAgentOutput = false;
    try {
      await sendAgentProgress(deps, channel, userId, runtimeAgent, 'reminder');
      const result = await runner.run({
        prompt: triggerPrompt,
        threadId: runtimeThreadId,
        model: currentModel,
        search: false,
        workdir: resolveAgentWorkdir(runtimeAgent),
        gatewayUserId: userId,
        reminderToolContext: {
          channel,
          userId,
          agentId: runtimeAgent.agentId,
          dbPath: deps.reminderDbPath,
        },
        onThreadStarted: (startedThreadId) => {
          persistSession(
            sessionUserKey,
            runtimeAgent.agentId,
            startedThreadId,
            `⏰ ${reminder.message}`,
            identityBinding.boundIdentityVersion,
          );
        },
        onMessage: (text) => {
          const output = formatAgentVisibleReply(runtimeAgent, text).trim();
          if (!output) {
            return;
          }
          sawAgentOutput = true;
          lastStreamSend = deps.sendText(channel, userId, output).catch((err) => {
            log.error('runReminderTrigger onMessage 推送失败', err);
          });
        },
      });
      await lastStreamSend;
      if (!sawAgentOutput) {
        await sendAgentProgress(deps, channel, userId, runtimeAgent, 'done');
      }
      persistSession(
        sessionUserKey,
        runtimeAgent.agentId,
        result.threadId,
        `⏰ ${reminder.message}`,
        identityBinding.boundIdentityVersion,
      );
    } catch (error) {
      log.error('runReminderTrigger 执行失败，回退固定提醒消息', {
        channel,
        userId,
        reminderId: reminder.reminderId,
        agentId: runtimeAgent.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      await deps.sendText(channel, userId, `⏰ 定时提醒：${reminder.message}`);
    }
  }

  return async function handleText(input: {
    channel: Channel;
    userId: string;
    content: string;
    reminderTrigger?: ReminderTriggerInput;
  }): Promise<void> {
    if (input.reminderTrigger) {
      await runReminderTrigger({
        channel: input.channel,
        userId: input.userId,
        reminder: input.reminderTrigger,
      });
      return;
    }
    const { channel, userId, content } = input;
    const sessionUserKey = resolveUserKey(userId);
    const prompt = content.trim();
    if (!prompt) {
      log.debug('handleText 收到空 prompt，跳过', { channel, userId });
      return;
    }
    const inboundAck = buildInboundNonTextAck(prompt);
    if (inboundAck) {
      await deps.sendText(channel, userId, inboundAck);
    }

    log.info(`
════════════════════════════════════════════════════════════
📩 用户消息  [${channel}:${userId}]
────────────────────────────────────────────────────────────
${clipMessage(prompt, 500)}
════════════════════════════════════════════════════════════`);

    const currentAgent = resolveRuntimeAgent(
      deps.agentWorkspaceManager,
      sessionUserKey,
      normalizeVisibleCurrentAgent(sessionUserKey),
    );
    const openCodeAuthSessionKey = buildOpenCodeAuthSessionKey(channel, userId, currentAgent.agentId);
    if (deps.openCodeAuthFlowManager?.has(openCodeAuthSessionKey)) {
      if (prompt === '/cancel') {
        deps.openCodeAuthFlowManager.stop(openCodeAuthSessionKey, '用户手动取消');
        await deps.sendText(channel, userId, '已取消当前登录流程。');
        return;
      }
      if (deps.openCodeAuthFlowManager.isAwaitingInput(openCodeAuthSessionKey)) {
        const accepted = await deps.openCodeAuthFlowManager.sendInput(openCodeAuthSessionKey, prompt);
        if (accepted) {
          await deps.sendText(channel, userId, '已收到，正在继续处理授权流程。');
          return;
        }
      }
    }
    const existingSessionState = getSessionState(sessionUserKey, currentAgent.agentId);
    const persistedThreadId = existingSessionState.threadId;
    const existingThreadId = isInvalidThreadIdLiteral(persistedThreadId) ? undefined : persistedThreadId;
    if (persistedThreadId && !existingThreadId) {
      log.warn('handleText 检测到非法会话 threadId，已清理并降级为新会话', {
        userId,
        agentId: currentAgent.agentId,
        threadIdPreview: clipMessage(persistedThreadId, 80),
      });
      deps.sessionStore.clearSession(sessionUserKey, currentAgent.agentId);
    }
    const currentModel = getCurrentModel(sessionUserKey, currentAgent.agentId);
    const currentSearch = userSearchOverrides.get(sessionUserKey) ?? deps.defaultSearch;
    // 对用户展示时，过滤掉系统内置 agent（如 memory-onboarding）
    const allAgents = commandNeedsAgentList(prompt) ? deps.sessionStore.listAgents(sessionUserKey, { includeHidden: true }) : [];
    const agents = allAgents.filter((a) => !isSystemAgentRecord(a));
    const commandResult = handleUserCommand(prompt, {
      currentThreadId: existingThreadId,
      currentAgent,
      agents,
      sessions: commandNeedsDetailedSessions(prompt)
        ? deps.sessionStore.listDetailed(sessionUserKey, currentAgent.agentId)
        : [],
    });

    async function startMemoryOnboarding(
      onboardingAgent: { agentId: string; name: string; workspaceDir: string },
      model: string | undefined,
      options: {
        reason: 'shared' | 'agent' | 'both' | 'manual';
        targetAgent?: { agentId: string; name: string; workspaceDir: string };
      },
    ): Promise<void> {
      onboardingKickoffInFlight.add(sessionUserKey);
      if (!deps.rateLimitStore.allow(sessionUserKey)) {
        onboardingKickoffInFlight.delete(sessionUserKey);
        await deps.sendText(channel, userId, '⏳ 初始化请求过于频繁，请稍后再试。');
        return;
      }
      if (!deps.runnerEnabled) {
        onboardingKickoffInFlight.delete(sessionUserKey);
        await deps.sendText(channel, userId, '⚠️ 当前服务已禁用命令执行，暂时无法开始初始化访谈。');
        return;
      }

      let lastStreamSend: Promise<void> = Promise.resolve();
      const onboardingThreadId = deps.sessionStore.getSession(sessionUserKey, onboardingAgent.agentId);
      try {
        const onboardingRunner = getRunner(getCurrentProvider(sessionUserKey, onboardingAgent.agentId));
        const result = await onboardingRunner.run({
          prompt: buildMemoryOnboardingKickoffPrompt(options),
          threadId: onboardingThreadId,
          model,
          search: false,
          workdir: resolveAgentWorkdir(onboardingAgent),
          reminderToolContext: {
            channel,
            userId,
            agentId: onboardingAgent.agentId,
            dbPath: deps.reminderDbPath,
          },
          onThreadStarted: (startedThreadId) => {
            deps.sessionStore.setSession(sessionUserKey, onboardingAgent.agentId, startedThreadId, 'memory onboarding kickoff');
          },
          onMessage: (text) => {
            const sanitized = formatAgentVisibleReply(onboardingAgent, sanitizeOnboardingText(text));
            lastStreamSend = deps.sendText(channel, userId, sanitized).catch((err) => {
              log.error('startMemoryOnboarding onMessage 推送失败', err);
            });
          },
        });
        await lastStreamSend;
        deps.sessionStore.setSession(sessionUserKey, onboardingAgent.agentId, result.threadId, 'memory onboarding kickoff');
      } catch (error) {
        log.error('startMemoryOnboarding 执行失败', {
          userId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        clearActiveMemoryOnboarding(sessionUserKey);
        await deps.sendText(channel, userId, '❌ 初始化引导启动失败，请稍后重试，或发送任意消息继续。');
      } finally {
        onboardingKickoffInFlight.delete(sessionUserKey);
      }
    }

    function ensureMemoryOnboardingAgent(): AgentRecord {
      const listedAgents = deps.sessionStore.listAgents(sessionUserKey, { includeHidden: true });
      const existing = listedAgents.find((item) => isSystemAgentRecord(item));
      if (existing) {
        return {
          agentId: existing.agentId,
          name: existing.name,
          workspaceDir: existing.workspaceDir,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        };
      }

      const workspace = deps.agentWorkspaceManager.createWorkspace({
        userId: sessionUserKey,
        agentName: MEMORY_ONBOARDING_AGENT_NAME,
        existingAgentIds: listedAgents.map((item) => item.agentId),
        template: 'memory-onboarding',
      });
      const agent = deps.sessionStore.createAgent(sessionUserKey, {
        agentId: workspace.agentId,
        name: MEMORY_ONBOARDING_AGENT_NAME,
        workspaceDir: workspace.workspaceDir,
      });
      return agent;
    }

    function ensureSkillOnboardingAgent(): AgentRecord {
      const listedAgents = deps.sessionStore.listAgents(sessionUserKey, { includeHidden: true });
      const existing = listedAgents.find((item) => item.agentId === SKILL_ONBOARDING_AGENT_ID || item.name.trim() === SKILL_ONBOARDING_AGENT_NAME);
      if (existing) {
        return {
          agentId: existing.agentId,
          name: existing.name,
          workspaceDir: existing.workspaceDir,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        };
      }

      const workspace = deps.agentWorkspaceManager.createWorkspace({
        userId: sessionUserKey,
        agentName: SKILL_ONBOARDING_AGENT_NAME,
        existingAgentIds: listedAgents.map((item) => item.agentId),
        template: 'skill-onboarding',
      });
      const agent = deps.sessionStore.createAgent(sessionUserKey, {
        agentId: workspace.agentId,
        name: SKILL_ONBOARDING_AGENT_NAME,
        workspaceDir: workspace.workspaceDir,
      });
      return agent;
    }

    function normalizeVisibleCurrentAgent(userKey: string): AgentRecord {
      const selected = deps.sessionStore.getCurrentAgent(userKey);
      if (!isSystemAgentRecord(selected)) {
        return selected;
      }

      const listedAgents = deps.sessionStore.listAgents(userKey, { includeHidden: true });
      const customFallback = listedAgents.find((item) => !item.isDefault && !isSystemAgentRecord(item));
      const fallback = customFallback ?? listedAgents.find((item) => !isSystemAgentRecord(item));
      if (fallback) {
        deps.sessionStore.setCurrentAgent(userKey, fallback.agentId);
        return deps.sessionStore.getCurrentAgent(userKey);
      }
      return selected;
    }

    if (commandResult.handled) {
      const commandName = (prompt.split(/\s+/, 1)[0] ?? '').toLowerCase() || '/unknown';
      async function sendCommandText(text: string): Promise<void> {
        await deps.sendText(channel, userId, formatCommandOutboundMessage(channel, commandName, text));
      }
      if (commandResult.clearSession) {
        deps.sessionStore.clearSession(sessionUserKey, currentAgent.agentId);
      }
      if (commandResult.renameTarget && commandResult.renameName) {
        const resolved = deps.sessionStore.resolveSwitchTarget(sessionUserKey, currentAgent.agentId, commandResult.renameTarget);
        if (!resolved) {
          await sendCommandText('❌ 未找到目标会话，请先发送 /sessions 查看编号。');
          return;
        }
        deps.sessionStore.renameSession(resolved, commandResult.renameName);
        await sendCommandText(`✅ 已重命名会话：${commandResult.renameName}`);
        return;
      }
      if (commandResult.createAgentName) {
        clearActiveMemoryOnboarding(sessionUserKey);
        const workspace = deps.agentWorkspaceManager.createWorkspace({
          userId: sessionUserKey,
          agentName: commandResult.createAgentName,
          existingAgentIds: deps.sessionStore.listAgents(sessionUserKey, { includeHidden: true }).map((item) => item.agentId),
          template: commandResult.createAgentTemplate,
        });
        const agent = deps.sessionStore.createAgent(sessionUserKey, {
          agentId: workspace.agentId,
          name: commandResult.createAgentName,
          workspaceDir: workspace.workspaceDir,
        });
        deps.sessionStore.setCurrentAgent(sessionUserKey, agent.agentId);
        await sendCommandText(
          [
            `✅ 已创建并切换到 agent：${agent.name} (${agent.agentId})`,
            `工作区：${agent.workspaceDir}`,
            `记忆入口：${agent.workspaceDir}/AGENTS.md`,
          ].join('\n'),
        );
        return;
      }
      if (commandResult.initMemoryAgent) {
        const agent = ensureMemoryOnboardingAgent();
        const onboardingThreadId = deps.sessionStore.getSession(sessionUserKey, agent.agentId);
        if (onboardingKickoffInFlight.has(sessionUserKey) && !onboardingThreadId) {
          await sendCommandText(renderMemoryOnboardingPendingMessage());
          return;
        }
        setActiveMemoryOnboarding(sessionUserKey, agent, {
          agentId: currentAgent.agentId,
          workspaceDir: currentAgent.workspaceDir,
        });
        if (onboardingThreadId) {
          await sendCommandText(renderMemoryOnboardingResumeMessage());
          return;
        }
        await sendCommandText(renderMemoryOnboardingStartMessage('manual'));
        await startMemoryOnboarding(agent, currentModel, {
          reason: 'manual',
          targetAgent: currentAgent,
        });
        return;
      }
      if (commandResult.initSkillAgent) {
        clearActiveMemoryOnboarding(sessionUserKey);
        const agent = ensureSkillOnboardingAgent();
        deps.sessionStore.setCurrentAgent(sessionUserKey, agent.agentId);
        const skillThreadId = deps.sessionStore.getSession(sessionUserKey, agent.agentId);
        if (skillThreadId) {
          await sendCommandText(renderSkillOnboardingResumeMessage(agent));
          return;
        }
        if (!deps.rateLimitStore.allow(sessionUserKey)) {
          await sendCommandText('⏳ 请求过于频繁，请稍后再试。');
          return;
        }
        if (!deps.runnerEnabled) {
          await sendCommandText('⚠️ 当前服务已禁用命令执行，暂时无法启动技能扩展助手。');
          return;
        }
        await sendCommandText(renderSkillOnboardingStartMessage(agent));
        try {
          let lastStreamSend: Promise<void> = Promise.resolve();
          const skillRunner = getRunner(getCurrentProvider(sessionUserKey, agent.agentId));
          const result = await skillRunner.run({
            prompt: SKILL_ONBOARDING_KICKOFF_PROMPT,
            model: currentModel,
            search: false,
            workdir: resolveAgentWorkdir(agent),
            reminderToolContext: {
              channel,
              userId,
              agentId: agent.agentId,
              dbPath: deps.reminderDbPath,
            },
            onThreadStarted: (startedThreadId) => {
              deps.sessionStore.setSession(sessionUserKey, agent.agentId, startedThreadId, 'skill onboarding kickoff');
            },
            onMessage: (text) => {
              const sanitized = formatAgentVisibleReply(agent, sanitizeOnboardingText(text));
              lastStreamSend = sendCommandText(sanitized).catch((err) => {
                log.error('initSkillAgent onMessage 推送失败', err);
              });
            },
          });
          await lastStreamSend;
          deps.sessionStore.setSession(sessionUserKey, agent.agentId, result.threadId, 'skill onboarding kickoff');
        } catch (error) {
          log.error('initSkillAgent 执行失败', {
            userId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          await sendCommandText('❌ 技能扩展助手启动失败，请稍后重试。');
        }
        return;
      }
      if (commandResult.initLogin) {
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        const loginRunner = getRunner(runtimeProvider);
        const loginRunnerLabel = getRunnerLabel(runtimeProvider);
        const supportsDeviceAuth = runtimeProvider === 'codex';
        if (!deps.runnerEnabled) {
          await sendCommandText('⚠️ 当前服务已禁用命令执行，无法进行登录。');
          return;
        }
        if (channel === 'feishu') {
          await deps.sendText(channel, userId, buildFeishuLoginChoiceMessage({
            provider: runtimeProvider,
            providerLabel: loginRunnerLabel,
            supportsDeviceAuth,
            authState: resolveLoginAuthState(runtimeProvider),
          }));
          return;
        }
        if (runtimeProvider === 'opencode') {
          await sendCommandText('当前模型通道是 OpenCode。请在飞书里发送 /login，通过卡片选择登录方式。系统会优先返回授权链接，引导你在浏览器完成登录。');
          return;
        }
        if (!supportsDeviceAuth) {
          await sendCommandText(`⚠️ 当前模型通道 ${loginRunnerLabel} 不支持通过网关代理设备授权，请改用飞书中的 API URL / Key 登录。`);
          return;
        }
        try {
          await startCodexDeviceLogin({
            provider: runtimeProvider,
            channel,
            userId,
            sendText: deps.sendText,
            codexHomeDir: getRunnerHomeDir(runtimeProvider),
            codexRunner: {
              login: async (input) => loginRunner.login({
                onMessage: (text) => {
                  log.info(`
════════════════════════════════════════════════════════════
🔑 Codex 登录设备码  [${channel}:${userId}]
────────────────────────────────────────────────────────────
${clipMessage(text, 500)}
════════════════════════════════════════════════════════════`);
                  input.onMessage?.(text);
                },
              }),
            },
          });
        } catch (error) {
          log.error('handleText /login 失败或超时', {
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          await sendCommandText('❌ 登录超时或遇到错误。请重试 /login 命令。');
        }
        return;
      }
      if (commandResult.queryProvider) {
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        const explicitlySelected = hasExplicitProviderSelection(sessionUserKey, currentAgent.agentId);
        await sendCommandText([
          `当前模型通道：${getRunnerLabel(runtimeProvider)} (${runtimeProvider})`,
          `当前 agent：${currentAgent.name} (${currentAgent.agentId})`,
          explicitlySelected
            ? '当前 agent 已显式选择模型通道。'
            : `当前 agent 尚未显式选择模型通道，当前先使用默认值：${getRunnerLabel(runtimeProvider)}。建议首轮先完成选择。`,
          '切换命令：/provider codex | /provider opencode | /provider reset',
        ].join('\n'));
        return;
      }
      if (commandResult.clearProvider) {
        deps.sessionStore.clearProviderOverride?.(sessionUserKey, currentAgent.agentId);
        deps.sessionStore.clearSession(sessionUserKey, currentAgent.agentId);
        deps.sessionStore.clearModelOverride?.(sessionUserKey, currentAgent.agentId);
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        await sendCommandText([
          `✅ 已恢复默认模型通道：${getRunnerLabel(runtimeProvider)} (${runtimeProvider})`,
          '已同步清空当前 agent 的会话与模型覆盖，避免跨通道复用旧上下文。',
        ].join('\n'));
        return;
      }
      if (commandResult.setProvider) {
        deps.sessionStore.setProviderOverride?.(sessionUserKey, currentAgent.agentId, commandResult.setProvider);
        deps.sessionStore.clearSession(sessionUserKey, currentAgent.agentId);
        deps.sessionStore.clearModelOverride?.(sessionUserKey, currentAgent.agentId);
        await sendCommandText([
          `✅ 已切换当前 agent 模型通道为：${getRunnerLabel(commandResult.setProvider)} (${commandResult.setProvider})`,
          '已同步清空当前 agent 的会话与模型覆盖，避免跨通道复用旧上下文。',
        ].join('\n'));
        return;
      }
      if (commandResult.useAgentTarget) {
        const resolved = deps.sessionStore.resolveAgentTarget(sessionUserKey, commandResult.useAgentTarget);
        if (!resolved) {
          await sendCommandText('❌ 未找到目标 agent，请先发送 /agents 查看编号。');
          return;
        }
        clearActiveMemoryOnboarding(sessionUserKey);
        deps.sessionStore.setCurrentAgent(sessionUserKey, resolved);
        const nextAgent = resolveRuntimeAgent(
          deps.agentWorkspaceManager,
          sessionUserKey,
          deps.sessionStore.getCurrentAgent(sessionUserKey),
        );
        const nextThreadId = deps.sessionStore.getSession(sessionUserKey, nextAgent.agentId);
        await sendCommandText(
          [
            `✅ 已切换到 agent：${nextAgent.name} (${nextAgent.agentId})`,
            `工作区：${nextAgent.workspaceDir}`,
            `当前会话：${maskThreadId(nextThreadId)}`,
          ].join('\n'),
        );
        return;
      }
      if (commandResult.switchTarget) {
        const resolved = deps.sessionStore.resolveSwitchTarget(sessionUserKey, currentAgent.agentId, commandResult.switchTarget);
        if (!resolved) {
          await sendCommandText('❌ 未找到目标会话，请先发送 /sessions 查看编号。');
          return;
        }
        if (isInvalidThreadIdLiteral(resolved)) {
          await sendCommandText('❌ 无效的会话标识，请使用 /sessions 中的编号或真实 threadId。');
          return;
        }
        deps.sessionStore.setSession(sessionUserKey, currentAgent.agentId, resolved);
        await sendCommandText(`✅ 已切换到会话：${maskThreadId(resolved)}`);
        return;
      }
      if (commandResult.queryAgent || commandResult.queryAgents) {
        if (commandResult.message) {
          await sendCommandText(commandResult.message);
        }
        return;
      }
      if (commandResult.queryMemory) {
        if (!deps.agentWorkspaceManager.getMemorySummary) {
          await sendCommandText('⚠️ 当前版本未启用记忆摘要读取能力。');
          return;
        }
        const snapshot = deps.agentWorkspaceManager.getMemorySummary(sessionUserKey, currentAgent.workspaceDir);
        await sendCommandText(formatMemorySummary(currentAgent, snapshot));
        return;
      }
      if (commandResult.queryModel) {
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        const snapshot = await resolveModelsSnapshot(runtimeProvider);
        const lines = [
          `当前模型通道：${getRunnerLabel(runtimeProvider)} (${runtimeProvider})`,
          `当前模型：${currentModel ?? `(${getRunnerLabel(runtimeProvider)} 默认模型)`}`,
        ];
        if (snapshot.models.length > 0) {
          lines.push(formatPaginatedCodexModelsText(snapshot, commandResult.queryModelsPage ?? 1));
        }
        await sendCommandText(lines.join('\n'));
        return;
      }
      if (commandResult.queryModels) {
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        await sendCommandText(formatPaginatedCodexModelsText(await resolveModelsSnapshot(runtimeProvider), commandResult.queryModelsPage ?? 1));
        return;
      }
      if (commandResult.querySkills) {
        const scope = commandResult.querySkillsScope ?? 'effective';
        const skillList = scope === 'global'
          ? skillManager.listGlobalSkills(currentAgent.workspaceDir)
          : scope === 'agent'
          ? skillManager.listAgentLocalSkills(currentAgent.workspaceDir)
          : skillManager.listEffectiveSkills(currentAgent.workspaceDir);
        if (skillList.length === 0) {
          await sendCommandText('当前未发现可用 skill。');
          return;
        }
        const lines = skillList.map((item, index) => {
          const desc = item.description ? ` - ${item.description}` : '';
          return `${index + 1}. ${item.name} [${item.source}]${desc}`;
        });
        await sendCommandText(
          [
            `当前会话可用 skill（范围：${scope}，agent：${currentAgent.name} / ${currentAgent.agentId}）`,
            ...lines,
          ].join('\n'),
        );
        return;
      }
      if (commandResult.disableGlobalSkillName) {
        const result = skillManager.disableGlobalSkill(currentAgent.workspaceDir, commandResult.disableGlobalSkillName);
        if (!result.ok) {
          await sendCommandText(`❌ ${result.reason ?? '禁用全局 skill 失败'}`);
          return;
        }
        await sendCommandText(`✅ 已禁用全局 skill（仅当前 agent）：${commandResult.disableGlobalSkillName}`);
        return;
      }
      if (commandResult.enableGlobalSkillName) {
        const result = skillManager.enableGlobalSkill(currentAgent.workspaceDir, commandResult.enableGlobalSkillName);
        if (!result.ok) {
          await sendCommandText(`❌ ${result.reason ?? '添加全局 skill 失败'}`);
          return;
        }
        await sendCommandText(`✅ 已添加全局 skill（仅当前 agent）：${commandResult.enableGlobalSkillName}`);
        return;
      }
      if (commandResult.disableAgentSkillName) {
        const result = skillManager.disableAgentSkill(currentAgent.workspaceDir, commandResult.disableAgentSkillName);
        if (!result.ok) {
          await sendCommandText(`❌ ${result.reason ?? '禁用当前 agent skill 失败'}`);
          return;
        }
        await sendCommandText(`✅ 已禁用当前 agent skill：${commandResult.disableAgentSkillName}`);
        return;
      }
      if (commandResult.clearModel) {
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        deps.sessionStore.clearModelOverride?.(sessionUserKey, currentAgent.agentId);
        const snapshot = await resolveModelsSnapshot(runtimeProvider);
        await sendCommandText([
          `✅ 已重置模型：${deps.resolveDefaultModel?.(runtimeProvider) ?? deps.defaultModel ?? `(${getRunnerLabel(runtimeProvider)} 默认模型)`}`,
          ...(snapshot.models.length > 0 ? [formatPaginatedCodexModelsText(snapshot, 1)] : []),
        ].join('\n'));
        return;
      }
      if (commandResult.setModel) {
        const runtimeProvider = getCurrentProvider(sessionUserKey, currentAgent.agentId);
        const snapshot = await resolveModelsSnapshot(runtimeProvider);
        const resolved = resolveModelFromSnapshot(commandResult.setModel, snapshot);
        if (!resolved.ok || !resolved.model) {
          await sendCommandText(`❌ ${resolved.reason ?? '模型校验失败'}`);
          return;
        }
        deps.sessionStore.setModelOverride?.(sessionUserKey, currentAgent.agentId, resolved.model);
        const note = resolved.reason ? `\n⚠️ ${resolved.reason}` : '';
        await sendCommandText([
          `✅ 已切换模型为：${resolved.model}${note}`,
          ...(snapshot.models.length > 0 ? [formatPaginatedCodexModelsText(snapshot, 1)] : []),
        ].join('\n'));
        return;
      }
      if (commandResult.querySearch) {
        await sendCommandText(`联网搜索：${currentSearch ? 'on' : 'off'}`);
        return;
      }

      if (commandResult.stopRunId) {
        const activeRun = activeRunManager.get(commandResult.stopRunId);
        if (!activeRun) {
          await deps.sendText(channel, userId, '⚠️ 未找到正在运行的任务，可能已经结束。');
          return;
        }
        if (activeRun.status === 'completed') {
          return;
        }
        if (channel === 'feishu' && activeRun.messageId) {
          await deps.sendText(
            channel,
            userId,
            buildGatewayUpdateMessage(
              activeRun.messageId,
              buildFeishuRunCardMessage({
                runId: activeRun.runId,
                agentName: currentAgent.name.trim() === '默认Agent' ? '默认助手' : currentAgent.name,
                provider: activeRun.provider ?? getCurrentProvider(sessionUserKey, currentAgent.agentId),
                status: 'stopping',
                startedAt: activeRun.startedAt,
                lastActivityAt: Date.now(),
                threadId: activeRun.threadId,
              }),
            ),
          );
          activeRunManager.update(commandResult.stopRunId, {
            status: 'stopping',
            lastActivityAt: Date.now(),
          });
        }
        await activeRunManager.stopRun({
          runId: commandResult.stopRunId,
          channel,
          userId,
        });
        const stoppedRun = activeRunManager.get(commandResult.stopRunId) ?? activeRun;
        if (channel === 'feishu' && stoppedRun.messageId) {
          await deps.sendText(
            channel,
            userId,
            buildGatewayUpdateMessage(
              stoppedRun.messageId,
              buildFeishuRunCardMessage({
                runId: stoppedRun.runId,
                agentName: currentAgent.name.trim() === '默认Agent' ? '默认助手' : currentAgent.name,
                provider: stoppedRun.provider ?? getCurrentProvider(sessionUserKey, currentAgent.agentId),
                status: 'stopped',
                startedAt: stoppedRun.startedAt,
                lastActivityAt: Date.now(),
                threadId: stoppedRun.threadId,
              }),
            ),
          );
          activeRunManager.update(commandResult.stopRunId, {
            status: 'stopped',
            lastActivityAt: Date.now(),
          });
          retainTerminalRun(commandResult.stopRunId);
        } else {
          await deps.sendText(channel, userId, '✅ 已发送停止请求。');
        }
        return;
      }
      if (typeof commandResult.setSearchEnabled === 'boolean') {
        userSearchOverrides.set(sessionUserKey, commandResult.setSearchEnabled);
        await sendCommandText(`✅ 已${commandResult.setSearchEnabled ? '开启' : '关闭'}联网搜索`);
        return;
      }
      if (commandResult.publishWorkspace) {
        if (!deps.workspacePublisher) {
          await sendCommandText('⚠️ 当前服务未开启 workspace 发布命令，请联系管理员。');
          return;
        }
        await sendCommandText('⏳ 正在发布 workspace，请稍候...');
        try {
          const result = await deps.workspacePublisher.publish();
          const preview = result.output
            ? `\n\n发布输出（末尾）：\n${clipMessage(result.output, 600)}`
            : '';
          await sendCommandText(`✅ workspace 发布完成。${preview}`);
        } catch (error) {
          log.error('handleText /deploy-workspace 执行失败', {
            userId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          await sendCommandText('❌ workspace 发布失败，请检查日志后重试。');
        }
        return;
      }
      if (commandResult.reviewMode) {
        if (!deps.rateLimitStore.allow(sessionUserKey)) {
          log.warn('handleText /review 命中限流，拒绝执行', { userId });
          await sendCommandText('⏳ 请求过于频繁，请稍后再试。');
          return;
        }
        if (!deps.runnerEnabled) {
          log.warn('handleText /review runnerEnabled=false，拒绝执行', { userId });
          await sendCommandText('⚠️ 当前服务已禁用命令执行，请联系管理员。');
          return;
        }
        try {
          let lastStreamSend: Promise<void> = Promise.resolve();
          const startTime = Date.now();
          const reviewRunner = getRunner(getCurrentProvider(sessionUserKey, currentAgent.agentId));
          const reviewWorkdir = resolveAgentWorkdir(currentAgent);
          const reviewResult = await reviewRunner.review({
            mode: commandResult.reviewMode,
            target: commandResult.reviewTarget,
            prompt: commandResult.reviewPrompt,
            model: currentModel,
            search: currentSearch,
            workdir: reviewWorkdir,
            skillPolicy: skillManager.getPolicy?.(reviewWorkdir),
            onMessage: (text) => {
              log.info(`
════════════════════════════════════════════════════════════
🧪 Codex Review  [${channel}:${userId}]
────────────────────────────────────────────────────────────
${clipMessage(text, 500)}
════════════════════════════════════════════════════════════`);
              lastStreamSend = sendCommandText(text).catch((err) => {
                log.error('handleText review onMessage 推送失败', err);
              });
            },
          });
          const elapsed = Date.now() - startTime;
          await lastStreamSend;
          log.info('<<< handleText Codex review 执行完成', {
            userId,
            mode: commandResult.reviewMode,
            target: commandResult.reviewTarget ?? '(none)',
            agentId: currentAgent.agentId,
            workdir: reviewWorkdir,
            elapsedMs: elapsed,
            rawOutputLength: reviewResult.rawOutput.length,
          });
        } catch (error) {
          log.error('handleText /review 执行失败', {
            userId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          await sendCommandText('❌ review 执行失败，请稍后重试。');
        }
        return;
      }
      if (commandResult.message) {
        await sendCommandText(commandResult.message);
      }
      return;
    }

    if (commandResult.nativeCodexCommand && getCurrentProvider(sessionUserKey, currentAgent.agentId) !== 'codex') {
      await deps.sendText(
        channel,
        userId,
        formatCommandOutboundMessage(
          channel,
          `/${commandResult.nativeCodexCommand}`,
          `⚠️ /${commandResult.nativeCodexCommand} 是 Codex 原生命令。请先使用 /provider codex 切换当前 agent 的模型通道。`,
        ),
      );
      return;
    }

    const activeOnboarding = commandResult.nativeCodexCommand ? undefined : getActiveMemoryOnboarding(sessionUserKey);
    const activeOnboardingThreadId = activeOnboarding
      ? deps.sessionStore.getSession(sessionUserKey, activeOnboarding.onboardingAgent.agentId)
      : undefined;
    if (!commandResult.handled && activeOnboarding && onboardingKickoffInFlight.has(sessionUserKey) && !activeOnboardingThreadId) {
      await deps.sendText(channel, userId, renderMemoryOnboardingPendingMessage());
      return;
    }

    const isSharedMemoryEmpty = deps.agentWorkspaceManager.isSharedMemoryEmpty(sessionUserKey);
    const isCurrentAgentIdentityEmpty = !isSystemAgentRecord(currentAgent)
      && !!deps.agentWorkspaceManager.isWorkspaceIdentityEmpty?.(currentAgent.workspaceDir);
    const shouldStartMemoryOnboarding = !commandResult.nativeCodexCommand && (isSharedMemoryEmpty || isCurrentAgentIdentityEmpty);
    const onboardingReason: 'shared' | 'agent' | 'both' = isSharedMemoryEmpty && isCurrentAgentIdentityEmpty
      ? 'both'
      : isSharedMemoryEmpty
      ? 'shared'
      : 'agent';
    const shouldPushStartupHelp = !commandResult.nativeCodexCommand
      && !existingThreadId
      && !shouldStartMemoryOnboarding
      && !isSystemAgentRecord(currentAgent);
    const shouldRecommendProviderSelection = !existingThreadId
      && !isSystemAgentRecord(currentAgent)
      && !hasExplicitProviderSelection(sessionUserKey, currentAgent.agentId);

    if (!activeOnboarding && shouldStartMemoryOnboarding && !existingThreadId) {
      await deps.sendText(channel, userId, renderMemoryOnboardingSuggestion(onboardingReason));
    }

    if (!activeOnboarding && shouldPushStartupHelp) {
      if (shouldRecommendProviderSelection) {
        const providerHelp = handleUserCommand('/provider').queryProvider
          ? [
              `当前 agent 尚未显式选择模型通道，当前先使用默认值：${getRunnerLabel(getCurrentProvider(sessionUserKey, currentAgent.agentId))}。`,
              '建议首轮先发送 `/provider codex` 或 `/provider opencode` 完成选择。',
            ].join('\n')
          : undefined;
        if (providerHelp) {
          await deps.sendText(channel, userId, formatCommandOutboundMessage(channel, '/provider', providerHelp));
        }
      }
      const helpText = handleUserCommand('/help').message;
      if (helpText) {
        await deps.sendText(channel, userId, formatCommandOutboundMessage(channel, '/help', helpText));
      }
    }

    if (!deps.rateLimitStore.allow(sessionUserKey)) {
      log.warn('handleText 命中限流，拒绝执行', { userId });
      await deps.sendText(channel, userId, '⏳ 请求过于频繁，请稍后再试。');
      return;
    }

    if (!deps.runnerEnabled) {
      log.warn('handleText runnerEnabled=false，拒绝执行', { userId });
      await deps.sendText(channel, userId, '⚠️ 当前服务已禁用命令执行，请联系管理员。');
      return;
    }

    let sawAgentOutput = false;
    let activeRunId: string | undefined;
    let runtimeAgent = activeOnboarding
      ? resolveRuntimeAgent(
          deps.agentWorkspaceManager,
          sessionUserKey,
          activeOnboarding.onboardingAgent,
        )
      : currentAgent;
    try {
      let lastStreamSend: Promise<void> = Promise.resolve();
      const streamId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      let streamedText = '';
      let lastAgentRawOutput = '';
      let lastFeishuStreamFlushAt = 0;
      let lastFeishuStreamSnapshot = '';
      let feishuAudioOnlyMode = false;
      let runnerOutputReady = false;
      const bufferedRunnerOutputs: string[] = [];
      const initialRuntimeThreadId = activeOnboarding
        ? activeOnboardingThreadId
        : existingThreadId;
      const identityBinding = await ensureIdentityBound({
        channel,
        userId,
        sessionUserKey,
        agent: runtimeAgent,
        model: currentModel,
        threadId: initialRuntimeThreadId,
      });
      const runtimeThreadId = identityBinding.threadId;
      const runtimeSearch = activeOnboarding ? false : currentSearch;
      log.debug('handleText 查询 session', {
        userId,
        agentId: runtimeAgent.agentId,
        workdir: resolveAgentWorkdir(runtimeAgent),
        existingThreadId: runtimeThreadId ?? '(无，新会话)',
      });

      const startTime = Date.now();
      const normalizedPrompt = await stageInboundLocalPaths(prompt, resolveAgentWorkdir(runtimeAgent));
      const speechPrompt = await deps.speechService?.processInboundAudio?.({
        prompt: normalizedPrompt,
        channel,
        userId,
        workspaceDir: resolveAgentWorkdir(runtimeAgent),
      });
      if (speechPrompt?.type === 'reply') {
        await deps.sendText(channel, userId, formatAgentVisibleReply(runtimeAgent, speechPrompt.message));
        return;
      }
      const shouldReplyWithWeixinVoice = channel === 'weixin' && Boolean(deps.ttsService);
      const canFeishuRequestAudioReply = channel === 'feishu' && Boolean(deps.ttsService);
      const runtimePrompt = buildOutboundMessageProtocolPrompt(
        channel,
        speechPrompt?.prompt ?? normalizedPrompt,
        {
          feishuTtsEnabled: canFeishuRequestAudioReply,
        },
      );
      recordSessionActivity(runtimeThreadId, {
        role: 'user',
        text: speechPrompt?.prompt ?? normalizedPrompt,
        timestamp: Date.now(),
      });
      const promptForRunner = speechPrompt?.prompt ?? normalizedPrompt;
      const runtimePrompt = commandResult.nativeCodexCommand
        ? promptForRunner
        : buildOutboundMessageProtocolPrompt(
            channel,
            promptForRunner,
            {
              feishuTtsEnabled: canFeishuRequestAudioReply,
            },
          );
      const runtimeProvider = getCurrentProvider(sessionUserKey, runtimeAgent.agentId);
      const activeRunner = getRunner(runtimeProvider);
      const runtimeWorkdir = resolveAgentWorkdir(runtimeAgent);
      const runtimeSkillPolicy = skillManager.getPolicy?.(runtimeWorkdir);
      const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      activeRunId = runId;
      const runStartedAt = Date.now();
      const emitRunnerOutput = (text: string): void => {
        if (shouldReplyWithWeixinVoice) {
          return;
        }
        const normalizedOutput = rewriteGatewayStructuredLocalPaths(text, runtimeWorkdir);
        const rawVisibleOutput = activeOnboarding ? sanitizeOnboardingText(normalizedOutput) : normalizedOutput;
        lastAgentRawOutput = rawVisibleOutput;
        const visibleReply = extractReplyModeDirective(rawVisibleOutput);
        feishuAudioOnlyMode = visibleReply.replyMode === 'audio';
        if (feishuAudioOnlyMode) {
          return;
        }
        const userVisibleOutput = formatAgentVisibleReply(runtimeAgent, visibleReply.cleanedText);
        log.info(`
════════════════════════════════════════════════════════════
🤖 Codex 回复  [${channel}:${userId}]
────────────────────────────────────────────────────────────
${clipMessage(userVisibleOutput, 500)}
════════════════════════════════════════════════════════════`);
        if (!userVisibleOutput) {
          return;
        }
        sawAgentOutput = true;
        if (channel === 'feishu' && deps.sendStreamingText) {
          streamedText = userVisibleOutput;
          const now = Date.now();
          if (now - lastFeishuStreamFlushAt < 450) {
            return;
          }
          lastFeishuStreamFlushAt = now;
          const snapshot = streamedText;
          lastStreamSend = deps.sendStreamingText(channel, userId, streamId, snapshot, false)
            .then(() => {
              lastFeishuStreamSnapshot = snapshot;
            })
            .catch(async (err) => {
              log.error('handleText onMessage 推送失败', err);
              try {
                await deps.sendText(channel, userId, '⚠️ 消息发送失败，请检查机器人发送权限或消息类型配置。');
              } catch (fallbackErr) {
                log.error('handleText onMessage fallback 推送失败', fallbackErr);
              }
            });
          return;
        }
        lastStreamSend = deps.sendText(channel, userId, userVisibleOutput).catch(async (err) => {
          log.error('handleText onMessage 推送失败', err);
          try {
            await deps.sendText(channel, userId, '⚠️ 消息发送失败，请检查机器人发送权限或消息类型配置。');
          } catch (fallbackErr) {
            log.error('handleText onMessage fallback 推送失败', fallbackErr);
          }
        });
      };
      const handleRunnerOutput = (text: string): void => {
        if (!runnerOutputReady) {
          bufferedRunnerOutputs.push(text);
          return;
        }
        emitRunnerOutput(text);
      };
      const flushBufferedRunnerOutputs = (): void => {
        runnerOutputReady = true;
        for (const pendingText of bufferedRunnerOutputs.splice(0)) {
          emitRunnerOutput(pendingText);
        }
      };
      const controlledRun = activeRunner.runWithControl
        ? activeRunner.runWithControl({
            prompt: runtimePrompt,
            threadId: runtimeThreadId,
            model: currentModel,
            search: runtimeSearch,
            workdir: runtimeWorkdir,
            gatewayUserId: userId,
            skillPolicy: runtimeSkillPolicy,
            reminderToolContext: {
              channel,
              userId,
              agentId: runtimeAgent.agentId,
              dbPath: deps.reminderDbPath,
            },
            onThreadStarted: (startedThreadId) => {
              persistSession(
                sessionUserKey,
                runtimeAgent.agentId,
                startedThreadId,
                prompt,
                identityBinding.boundIdentityVersion,
              );
              activeRunManager.update(runId, {
                threadId: startedThreadId,
                lastActivityAt: Date.now(),
              });
            },
            onMessage: (text) => {
              activeRunManager.update(runId, {
                lastActivityAt: Date.now(),
              });
              handleRunnerOutput(text);
            },
          })
        : {
            result: activeRunner.run({
              prompt: runtimePrompt,
              threadId: runtimeThreadId,
              model: currentModel,
              search: runtimeSearch,
              workdir: runtimeWorkdir,
              gatewayUserId: userId,
              skillPolicy: runtimeSkillPolicy,
              reminderToolContext: {
                channel,
                userId,
                agentId: runtimeAgent.agentId,
                dbPath: deps.reminderDbPath,
              },
              onThreadStarted: (startedThreadId) => {
                persistSession(
                  sessionUserKey,
                  runtimeAgent.agentId,
                  startedThreadId,
                  prompt,
                  identityBinding.boundIdentityVersion,
                );
              },
              onMessage: (text) => {
                handleRunnerOutput(text);
              },
            }),
            stop: async () => false,
          };
      if (channel === 'feishu' && activeRunner.runWithControl) {
        const messageId = await (deps.sendTextWithResult ?? (async () => undefined))(channel, userId, buildFeishuRunCardMessage({
          runId,
          agentName: runtimeAgent.name.trim() === '默认Agent' ? '默认助手' : runtimeAgent.name,
          provider: runtimeProvider,
          status: 'running',
          startedAt: runStartedAt,
          lastActivityAt: runStartedAt,
          threadId: runtimeThreadId,
        }));
        activeRunManager.register({
          runId,
          channel,
          userId,
          agentId: runtimeAgent.agentId,
          provider: runtimeProvider,
          status: 'running',
          startedAt: runStartedAt,
          lastActivityAt: runStartedAt,
          messageId,
          threadId: runtimeThreadId,
          stop: async (reason: string) => {
            await controlledRun.stop(reason);
          },
        });
        flushBufferedRunnerOutputs();
      } else {
        await sendAgentProgress(deps, channel, userId, runtimeAgent, 'received');
        flushBufferedRunnerOutputs();
      }
      const result = await controlledRun.result;
      const elapsed = Date.now() - startTime;
      await lastStreamSend;
      if (shouldReplyWithWeixinVoice && deps.ttsService) {
        const parsed = parseCodexJsonl(result.rawOutput);
        const normalizedOutput = rewriteGatewayStructuredLocalPaths(parsed.answer, resolveAgentWorkdir(runtimeAgent));
        const rawVisibleOutput = activeOnboarding ? sanitizeOnboardingText(normalizedOutput) : normalizedOutput;
        if (parseGatewayStructuredMessage(rawVisibleOutput)) {
          await deps.sendText(channel, userId, rawVisibleOutput);
        } else {
          const synthesized = await deps.ttsService.synthesize({
            text: rawVisibleOutput,
            workspaceDir: resolveAgentWorkdir(runtimeAgent),
          });
          await deps.sendText(channel, userId, JSON.stringify({
            __gateway_message__: true,
            msg_type: 'file',
            content: {
              local_file_path: synthesized.filePath,
            },
          }));
        }
        sawAgentOutput = true;
      }
      if (canFeishuRequestAudioReply) {
        const parsed = parseCodexJsonl(result.rawOutput);
        const normalizedOutput = rewriteGatewayStructuredLocalPaths(parsed.answer, resolveAgentWorkdir(runtimeAgent));
        const rawVisibleOutput = activeOnboarding ? sanitizeOnboardingText(normalizedOutput) : normalizedOutput;
        const streamedReplyDirective = extractReplyModeDirective(lastAgentRawOutput);
        const replyDirective = streamedReplyDirective.replyMode === 'audio'
          ? streamedReplyDirective
          : extractReplyModeDirective(rawVisibleOutput);
        if (replyDirective.replyMode === 'audio' && deps.ttsService && !parseGatewayStructuredMessage(replyDirective.cleanedText)) {
          const synthesized = await deps.ttsService.synthesize({
            text: replyDirective.cleanedText,
            workspaceDir: resolveAgentWorkdir(runtimeAgent),
          });
          await deps.sendText(channel, userId, JSON.stringify({
            __gateway_message__: true,
            msg_type: 'audio',
            content: {
              local_audio_path: synthesized.filePath,
            },
          }));
          sawAgentOutput = true;
        }
      }
      if (feishuAudioOnlyMode && !sawAgentOutput) {
        const parsed = parseCodexJsonl(result.rawOutput);
        const normalizedOutput = rewriteGatewayStructuredLocalPaths(parsed.answer, resolveAgentWorkdir(runtimeAgent));
        const rawVisibleOutput = activeOnboarding ? sanitizeOnboardingText(normalizedOutput) : normalizedOutput;
        const fallbackReply = lastAgentRawOutput || rawVisibleOutput;
        const replyDirective = extractReplyModeDirective(fallbackReply);
        if (parseGatewayStructuredMessage(replyDirective.cleanedText)) {
          await deps.sendText(channel, userId, replyDirective.cleanedText);
        } else if (replyDirective.cleanedText.trim()) {
          await deps.sendText(channel, userId, formatAgentVisibleReply(runtimeAgent, replyDirective.cleanedText));
        }
        sawAgentOutput = true;
      }
      if (!feishuAudioOnlyMode && channel === 'feishu' && deps.sendStreamingText && streamedText && streamedText !== lastFeishuStreamSnapshot) {
        await deps.sendStreamingText(channel, userId, streamId, streamedText, true);
      }
      if (!sawAgentOutput) {
        await sendAgentProgress(deps, channel, userId, runtimeAgent, 'done');
      }
      const finishedRun = activeRunManager.get(runId);
      if (channel === 'feishu' && finishedRun?.messageId) {
        await deps.sendText(
          channel,
          userId,
          buildGatewayUpdateMessage(
            finishedRun.messageId,
            buildFeishuRunCardMessage({
              runId,
              agentName: runtimeAgent.name.trim() === '默认Agent' ? '默认助手' : runtimeAgent.name,
              provider: runtimeProvider,
              status: 'completed',
              startedAt: finishedRun.startedAt,
              lastActivityAt: Date.now(),
              threadId: result.threadId,
            }),
          ),
        );
        activeRunManager.update(runId, {
          status: 'completed',
          lastActivityAt: Date.now(),
          threadId: result.threadId,
        });
        retainTerminalRun(runId);
      }

      log.info('<<< handleText Codex 执行完成', {
        userId,
        agentId: runtimeAgent.agentId,
        threadId: result.threadId,
        workdir: resolveAgentWorkdir(runtimeAgent),
        elapsedMs: elapsed,
        rawOutputLength: result.rawOutput.length,
      });

      persistSession(
        sessionUserKey,
        runtimeAgent.agentId,
        result.threadId,
        prompt,
        identityBinding.boundIdentityVersion,
      );
      recordSessionActivity(result.threadId, {
        role: 'assistant',
        text: lastAgentRawOutput || result.rawOutput,
        timestamp: Date.now(),
      });
      if (activeOnboarding && isMemoryOnboardingComplete(sessionUserKey, activeOnboarding)) {
        clearActiveMemoryOnboarding(sessionUserKey);
      }
      log.debug('handleText session 已更新', {
        userId,
        agentId: runtimeAgent.agentId,
        threadId: result.threadId,
      });
    } catch (error) {
      const activeRun = activeRunId ? activeRunManager.get(activeRunId) : undefined;
      if (channel === 'feishu' && sawAgentOutput && activeRun?.messageId) {
        await deps.sendText(
          channel,
          userId,
          buildGatewayUpdateMessage(
            activeRun.messageId,
            buildFeishuRunCardMessage({
              runId: activeRun.runId,
              agentName: runtimeAgent.name.trim() === '默认Agent' ? '默认助手' : runtimeAgent.name,
              provider: activeRun.provider ?? getCurrentProvider(sessionUserKey, runtimeAgent.agentId),
              status: 'completed',
              startedAt: activeRun.startedAt,
              lastActivityAt: Date.now(),
              threadId: activeRun.threadId,
            }),
          ),
        );
        if (activeRunId) {
          activeRunManager.update(activeRunId, {
            status: 'completed',
            lastActivityAt: Date.now(),
          });
          retainTerminalRun(activeRunId);
        }
        log.info('handleText suppressing feishu interruption warning after visible output', {
          userId,
          runId: activeRunId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (
        channel === 'feishu'
        && (
          (activeRun?.messageId && (activeRun.status === 'stopping' || activeRun.status === 'stopped'))
          || ((activeRun?.status === 'stopping' || activeRun?.status === 'stopped') && isUserStoppedRunError(error))
        )
      ) {
        if (activeRunId) {
          activeRunManager.delete(activeRunId);
        }
        log.info('handleText stop-requested run exited after user stop', {
          userId,
          runId: activeRunId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      log.error('handleText 执行失败', {
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      const failureKind = classifyChatFailure(error, sawAgentOutput);
      const failureText = buildChatFailureText(runtimeAgent, failureKind);
      await deps.sendText(
        channel,
        userId,
        channel === 'feishu'
          ? formatCommandOutboundMessage(channel, '/failure', failureText)
          : failureText,
      );
    }
  };
}
