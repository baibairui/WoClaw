import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventDispatcher as LarkEventDispatcher, LoggerLevel as LarkSdkLoggerLevel, WSClient as LarkWSClient } from '@larksuiteoapi/node-sdk';

import { createApp, dispatchFeishuCardActionEvent, dispatchFeishuMessageReceiveEvent } from './app.js';
import { config } from './config.js';
import { WorkspacePublisher } from './services/workspace-publisher.js';
import { AgentWorkspaceManager } from './services/agent-workspace-manager.js';
import { BrowserManager } from './services/browser-manager.js';
import { createBrowserAutomationBackend } from './services/browser-service.js';
import { createGatewayNativeToolHandler } from './services/codex-native-tool-adapter.js';
import { CodexRunner } from './services/codex-runner.js';
import { createChatHandler } from './services/chat-handler.js';
import { getCliProviderSpec, readCliHomeDefaultModel, runnerHomeDirName, writeCliApiLoginConfig } from './services/cli-provider.js';
import { startCodexDeviceLogin } from './services/codex-login-flow.js';
import {
  buildFeishuApiLoginFormMessage,
  buildFeishuApiLoginResultMessage,
  buildFeishuOpenCodeInputFallbackMessage,
  buildFeishuOpenCodeOauthMessage,
} from './services/feishu-command-cards.js';
import { MemorySteward } from './services/memory-steward.js';
import { SessionSummarySteward } from './services/session-summary-steward.js';
import { ReminderStore } from './services/reminder-store.js';
import { ReminderDispatcher } from './services/reminder-dispatcher.js';
import { ensureLarkCliReady } from './services/lark-cli-bootstrap.js';
import { OpenCodeAuthFlowManager, buildOpenCodeAuthSessionKey } from './services/opencode-auth-flow.js';
import { pushFeishuStartupHelp } from './services/startup-help.js';
import { createSpeechService } from './services/speech-service-factory.js';
import { createTtsService } from './services/tts-service-factory.js';
import { WeComApi } from './services/wecom-api.js';
import { WeixinApi, splitWeixinOutboundText, type WeixinInboundMessage } from './services/weixin-api.js';
import { FeishuApi } from './services/feishu-api.js';
import { createFeishuStreamingTextSender } from './services/feishu-streaming.js';
import { WeComCrypto } from './utils/wecom-crypto.js';
import { appendFeishuAttachmentMetadata, extractFeishuBinaryRef } from './utils/feishu-inbound.js';
import { isFeishuUpdateMessageType, normalizeFeishuStructuredMessage } from './utils/feishu-outgoing.js';
import { buildFeishuStatusSummary } from './utils/feishu-status.js';
import { isGatewayMessageTypeSupported, parseGatewayStructuredMessage } from './utils/gateway-message.js';
import { SessionStore } from './stores/session-store.js';
import { MessageDedupStore } from './stores/message-dedup-store.js';
import { RateLimitStore } from './stores/rate-limit-store.js';
import { createLogger } from './utils/logger.js';
import { configureManagedGlobalSkillRoots } from './services/gateway-browser-skill.js';
import { runStartupWorkspaceRepair } from './services/workspace-repair.js';
import { resolveGatewayRunnerHomeDirs, resolveManagedGlobalSkillRoots } from './services/managed-global-skill-roots.js';

const log = createLogger('Server');
const gatewayRootDir = resolveGatewayRootDir(config.gatewayRootDir);
const dataDir = path.join(gatewayRootDir, '.data');
fs.mkdirSync(dataDir, { recursive: true });
const weixinSessionPath = path.join(dataDir, 'weixin-session.json');
const weixinSession = loadWeixinSession(weixinSessionPath);
const agentsDir = resolveAgentsDir({
  configuredDir: config.codexAgentsDir,
  dataDir,
});
const codexWorkdir = resolveCodexWorkdir(config.codexWorkdir, agentsDir);
const codexHomeDir = path.join(dataDir, runnerHomeDirName('codex'));
const opencodeHomeDir = path.join(dataDir, runnerHomeDirName('opencode'));
const runnerHomeDirs = resolveGatewayRunnerHomeDirs(dataDir);
const managedGlobalSkillRoots = resolveManagedGlobalSkillRoots(runnerHomeDirs);
const cliProviderSpec = getCliProviderSpec(config.codexProvider);
const feishuStatusSummary = buildFeishuStatusSummary({
  enabled: config.feishuEnabled,
  longConnection: config.feishuLongConnection,
  groupRequireMention: config.feishuGroupRequireMention,
  docBaseUrlConfigured: true,
  startupHelpEnabled: config.feishuStartupHelpEnabled,
  startupHelpAdminConfigured: Boolean(config.feishuStartupHelpAdminOpenId),
});

log.info('服务启动初始化...', {
  port: config.port,
  codexProvider: config.codexProvider,
  codexBin: config.codexBin,
  opencodeBin: config.opencodeBin,
  codexModel: config.codexModel ?? '(codex cli default)',
  codexSearch: config.codexSearch,
  codexWorkdir,
  gatewayRootDir,
  codexAgentsDir: config.codexAgentsDir,
  commandTimeoutMs: config.commandTimeoutMs ?? '(adaptive)',
  commandTimeoutMinMs: config.commandTimeoutMinMs,
  commandTimeoutMaxMs: config.commandTimeoutMaxMs,
  commandTimeoutPerCharMs: config.commandTimeoutPerCharMs,
  browserAutomationEnabled: config.browserAutomationEnabled,
  browserApiBaseUrl: '(gateway-owned local only)',
  openAiCompatEnabled: Boolean(config.openAiCompat),
  openAiCompatUpstreamBaseUrl: config.openAiCompat?.upstreamBaseUrl ?? '(disabled)',
  browserProfileDir: config.browserProfileDir ?? '(default)',
  codexHomeDir: config.codexProvider === 'opencode' ? opencodeHomeDir : codexHomeDir,
  runnerEnabled: config.runnerEnabled,
  memoryStewardEnabled: config.memoryStewardEnabled,
  memoryStewardIntervalHours: config.memoryStewardIntervalHours,
  sessionSummaryStewardEnabled: config.sessionSummaryStewardEnabled,
  sessionSummaryStewardIntervalMinutes: config.sessionSummaryStewardIntervalMinutes,
  allowFrom: config.allowFrom,
  dedupWindowSeconds: config.dedupWindowSeconds,
  rateLimitMaxMessages: config.rateLimitMaxMessages,
  rateLimitWindowSeconds: config.rateLimitWindowSeconds,
  apiTimeoutMs: config.apiTimeoutMs,
  apiRetryOnTimeout: config.apiRetryOnTimeout,
  wecomEnabled: config.wecomEnabled,
  feishuEnabled: config.feishuEnabled,
  weixinEnabled: config.weixinEnabled,
  feishuLongConnection: feishuStatusSummary.mode === 'long-connection',
  feishuApiTimeoutMs: config.feishuApiTimeoutMs,
  feishuStatus: feishuStatusSummary,
});

log.debug('数据目录已就绪', { dataDir });
const browserManager = new BrowserManager({
  profileDir: resolveRuntimeDir(config.browserProfileDir, path.join(dataDir, 'browser', 'profile')),
});
const internalApiToken = process.env.GATEWAY_INTERNAL_API_TOKEN?.trim() || randomUUID();
const browserAutomation = config.browserAutomationEnabled
  ? createBrowserAutomationBackend(browserManager)
  : undefined;
const nativeToolHandler = createGatewayNativeToolHandler({
  browserAutomation,
});
const activeBrowserApiBaseUrl = config.browserAutomationEnabled
  ? `http://127.0.0.1:${config.port}/internal/browser`
  : undefined;
const internalApiBaseUrl = `http://127.0.0.1:${config.port}/internal`;
const feishuImageCacheDir = path.join(dataDir, 'feishu-images');
fs.mkdirSync(codexHomeDir, { recursive: true });
fs.mkdirSync(opencodeHomeDir, { recursive: true });
fs.mkdirSync(feishuImageCacheDir, { recursive: true });
configureManagedGlobalSkillRoots(managedGlobalSkillRoots);

await ensureLarkCliReady({
  cliHomeDirs: runnerHomeDirs,
  log,
});

log.debug('Agent 工作区目录已就绪', { agentsDir });
const reminderDbPath = path.join(dataDir, 'reminders.db');
const openCodeAuthFlowManager = new OpenCodeAuthFlowManager();

const sessionStore = new SessionStore(path.join(dataDir, 'sessions.db'), {
  defaultWorkspaceDir: agentsDir,
});
log.debug('SessionStore 已初始化');
const agentWorkspaceManager = new AgentWorkspaceManager(agentsDir);
log.debug('AgentWorkspaceManager 已初始化', { agentsDir });
const startupWorkspaceRepairStats = runStartupWorkspaceRepair({
  agentsDir,
  cwd: process.cwd(),
  gatewayRootDir,
  managedGlobalSkillRoots,
  workspaceManager: agentWorkspaceManager,
});
log.info('启动期 workspace repair 完成', startupWorkspaceRepairStats);
const dedupStore = new MessageDedupStore(config.dedupWindowSeconds);
log.debug('MessageDedupStore 已初始化', { dedupWindowSeconds: config.dedupWindowSeconds });
const rateLimitStore = new RateLimitStore(config.rateLimitMaxMessages, config.rateLimitWindowSeconds);
log.debug('RateLimitStore 已初始化', {
  maxMessages: config.rateLimitMaxMessages,
  windowSeconds: config.rateLimitWindowSeconds,
});

const codexRunner = new CodexRunner({
  provider: 'codex',
  codexBin: config.codexBin,
  workdir: codexWorkdir,
  timeoutMs: config.commandTimeoutMs,
  timeoutMinMs: config.commandTimeoutMinMs,
  timeoutMaxMs: config.commandTimeoutMaxMs,
  timeoutPerCharMs: config.commandTimeoutPerCharMs,
  browserApiBaseUrl: activeBrowserApiBaseUrl,
  internalApiBaseUrl,
  internalApiToken,
  gatewayRootDir,
  gatewayPublicBaseUrl: config.gatewayPublicBaseUrl,
  sandbox: config.codexSandbox,
  codexHomeDir,
  nativeToolHandler,
});
const opencodeRunner = new CodexRunner({
  provider: 'opencode',
  codexBin: config.opencodeBin,
  workdir: codexWorkdir,
  timeoutMs: config.commandTimeoutMs,
  timeoutMinMs: config.commandTimeoutMinMs,
  timeoutMaxMs: config.commandTimeoutMaxMs,
  timeoutPerCharMs: config.commandTimeoutPerCharMs,
  browserApiBaseUrl: activeBrowserApiBaseUrl,
  internalApiBaseUrl,
  internalApiToken,
  gatewayRootDir,
  gatewayPublicBaseUrl: config.gatewayPublicBaseUrl,
  sandbox: config.codexSandbox,
  codexHomeDir: opencodeHomeDir,
});
log.debug('Runners 已初始化');

function resolveRunnerHomeDir(provider: 'codex' | 'opencode'): string {
  return provider === 'opencode' ? opencodeHomeDir : codexHomeDir;
}

function resolveRunner(provider: 'codex' | 'opencode'): CodexRunner {
  return provider === 'opencode' ? opencodeRunner : codexRunner;
}

function resolveChatDefaultModel(provider: 'codex' | 'opencode'): string | undefined {
  return readCliHomeDefaultModel(provider, resolveRunnerHomeDir(provider))
    ?? (provider === config.codexProvider ? config.codexModel : undefined);
}

const workspacePublisher = new WorkspacePublisher({
  cwd: gatewayRootDir,
});
log.debug('WorkspacePublisher 已初始化', { cwd: gatewayRootDir });

const weComApi = config.wecomEnabled && config.corpId && config.corpSecret && config.agentId !== undefined
  ? new WeComApi({
    corpId: config.corpId,
    secret: config.corpSecret,
    agentId: config.agentId,
    timeoutMs: config.apiTimeoutMs,
    retryOnTimeout: config.apiRetryOnTimeout,
  })
  : undefined;
if (weComApi) {
  log.debug('WeComApi 已初始化');
}

const feishuApi = config.feishuEnabled && config.feishuAppId && config.feishuAppSecret
  ? new FeishuApi({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    timeoutMs: config.feishuApiTimeoutMs,
    retryOnTimeout: config.apiRetryOnTimeout,
    imageCacheDir: feishuImageCacheDir,
  })
  : undefined;
if (feishuApi) {
  log.debug('FeishuApi 已初始化');
}

const feishuBotIdentity = await resolveFeishuBotIdentity({
  enabled: config.feishuEnabled,
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  timeoutMs: config.feishuApiTimeoutMs,
});
const resolvedWeixinBaseUrl = weixinSession?.baseUrl || config.weixinBaseUrl;
const resolvedWeixinBotToken = weixinSession?.botToken || config.weixinBotToken;

const weixinApi = config.weixinEnabled && resolvedWeixinBotToken
  ? new WeixinApi({
    baseUrl: resolvedWeixinBaseUrl,
    botToken: resolvedWeixinBotToken,
    timeoutMs: config.apiTimeoutMs,
  })
  : undefined;
if (weixinApi) {
  log.debug('WeixinApi 已初始化', { baseUrl: resolvedWeixinBaseUrl, sessionPath: weixinSessionPath });
} else if (config.weixinEnabled) {
  log.warn('Weixin 已启用，但未找到 bot token；可先执行 npm run weixin:login', {
    sessionPath: weixinSessionPath,
  });
}

const wecomCrypto = config.wecomEnabled && config.token && config.encodingAesKey && config.corpId
  ? new WeComCrypto({
    token: config.token,
    encodingAesKey: config.encodingAesKey,
    corpId: config.corpId,
  })
  : undefined;
if (wecomCrypto) {
  log.debug('WeComCrypto 已初始化');
}

const userTaskQueue = new Map<string, Promise<void>>();
const outboundSendQueue = new Map<string, Promise<unknown>>();
const inboundReplyContext = new Map<string, {
  messageId?: string;
  allowReply: boolean;
  replyTargetId?: string;
  replyTargetType?: 'open_id' | 'chat_id';
}>();
const weixinContextTokenStore = new Map<string, string>();
const weixinStatePath = path.join(dataDir, 'weixin-state.json');
let weixinCursor = loadWeixinCursor(weixinStatePath);

interface InboundEnrichResult {
  content: string;
  attachmentRequired: boolean;
  attachmentDownloaded: boolean;
  errorMessage?: string;
}

function extractFeishuReplyOptions(
  content: Record<string, unknown> | string,
): {
  content: Record<string, unknown> | string;
  replyInThread?: boolean;
} {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return { content };
  }

  const replyInThread = typeof content.reply_in_thread === 'boolean'
    ? content.reply_in_thread
    : (typeof content.replyInThread === 'boolean' ? content.replyInThread : undefined);

  if (replyInThread === undefined) {
    return { content };
  }

  const normalizedContent = { ...content };
  delete normalizedContent.reply_in_thread;
  delete normalizedContent.replyInThread;

  return {
    content: normalizedContent,
    replyInThread,
  };
}

function resolveUserKey(userId: string): string {
  const normalized = userId.trim();
  return normalized || 'anonymous-user';
}

function canUseDir(targetDir: string): boolean {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function resolveAgentsDir(input: { configuredDir?: string; dataDir: string }): string {
  const fallbackDir = path.resolve(input.dataDir, 'agents');
  if (input.configuredDir) {
    const configured = path.resolve(input.configuredDir);
    if (canUseDir(configured)) {
      return configured;
    }
    log.warn('配置的 CODEX_AGENTS_DIR 不可用，回退到默认目录', { configured, fallbackDir });
    fs.mkdirSync(fallbackDir, { recursive: true });
    return fallbackDir;
  }
  fs.mkdirSync(fallbackDir, { recursive: true });
  return fallbackDir;
}

function resolveCodexWorkdir(configuredDir: string, agentsDir: string): string {
  const resolved = path.resolve(configuredDir);
  if (canUseDir(resolved)) {
    return resolved;
  }
  const fallback = path.resolve(agentsDir);
  if (canUseDir(fallback)) {
    log.warn('配置的 CODEX_WORKDIR 不可用，回退到 agents 工作目录', {
      configured: resolved,
      fallback,
    });
    return fallback;
  }
  const finalFallback = path.resolve(process.cwd());
  log.warn('配置的 CODEX_WORKDIR 与 agents 工作目录都不可用，回退到当前目录', {
    configured: resolved,
    fallback: finalFallback,
  });
  return finalFallback;
}

function resolveRuntimeDir(configuredDir: string | undefined, fallbackDir: string): string {
  if (!configuredDir?.trim()) {
    return path.resolve(fallbackDir);
  }
  return path.resolve(configuredDir);
}

async function resolveFeishuBotIdentity(input: {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  timeoutMs: number;
}): Promise<{ openId?: string; appName?: string }> {
  if (!input.enabled || !input.appId || !input.appSecret) {
    return {};
  }
  try {
    const tokenResp = await fetchJsonWithTimeout('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        app_id: input.appId,
        app_secret: input.appSecret,
      }),
    }, input.timeoutMs);
    const token = typeof tokenResp?.tenant_access_token === 'string' ? tokenResp.tenant_access_token.trim() : '';
    if (!token) {
      log.warn('飞书机器人身份解析失败：tenant_access_token 为空');
      return {};
    }
    const botResp = await fetchJsonWithTimeout('https://open.feishu.cn/open-apis/bot/v3/info', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }, input.timeoutMs);
    const bot = asRecord(botResp?.bot);
    const openId = typeof bot?.open_id === 'string' ? bot.open_id.trim() : '';
    const appName = typeof bot?.app_name === 'string' ? bot.app_name.trim() : '';
    if (!openId && !appName) {
      log.warn('飞书机器人身份解析失败：bot open_id/app_name 为空');
      return {};
    }
    log.info('飞书机器人身份已解析', {
      feishuBotOpenId: openId || '(empty)',
      feishuBotName: appName || '(empty)',
    });
    return {
      openId: openId || undefined,
      appName: appName || undefined,
    };
  } catch (error) {
    log.warn('飞书机器人身份解析失败，回退 text_without_at_bot 判定', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

async function fetchJsonWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
    const code = typeof body.code === 'number' ? body.code : 0;
    if (code !== 0) {
      const msg = typeof body.msg === 'string' ? body.msg : 'unknown';
      throw new Error(`feishu api ${code} ${msg}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function resolveGatewayRootDir(configuredDir: string | undefined): string {
  if (configuredDir && configuredDir.trim()) {
    const resolved = path.resolve(configuredDir);
    if (canUseDir(resolved)) {
      return resolved;
    }
    log.warn('配置的 GATEWAY_ROOT_DIR 不可用，回退到当前目录', {
      configured: resolved,
      fallback: path.resolve(process.cwd()),
    });
  }
  return path.resolve(process.cwd());
}

function runInUserQueue(userId: string, task: () => Promise<void>): Promise<void> {
  const previous = userTaskQueue.get(userId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (userTaskQueue.get(userId) === next) {
        userTaskQueue.delete(userId);
      }
    });

  userTaskQueue.set(userId, next);
  return next;
}

function isImmediateControlCommand(content: string): boolean {
  return /^\/run\s+stop\s+\S+/i.test(content.trim());
}

function enqueueOutboundSend<T>(
  channel: 'wecom' | 'feishu' | 'weixin',
  userId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${channel}:${userId}`;
  const previous = outboundSendQueue.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (outboundSendQueue.get(key) === next) {
        outboundSendQueue.delete(key);
      }
    });
  outboundSendQueue.set(key, next);
  return next;
}

async function sendText(channel: 'wecom' | 'feishu' | 'weixin', userId: string, content: string): Promise<void> {
  await enqueueSendText(channel, userId, content);
}

async function sendStreamingText(
  channel: 'wecom' | 'feishu' | 'weixin',
  userId: string,
  streamId: string,
  content: string,
  done: boolean,
): Promise<void> {
  await getStreamingTextSender()(channel, userId, streamId, content, done);
}

let streamingTextSender: ReturnType<typeof createFeishuStreamingTextSender> | undefined;

function getStreamingTextSender(): ReturnType<typeof createFeishuStreamingTextSender> {
  if (!streamingTextSender) {
    streamingTextSender = createFeishuStreamingTextSender({
      sendText: enqueueSendText,
      patchCardMessage: async (input) => {
        if (!feishuApi) {
          throw new Error('feishu api not configured');
        }
        await feishuApi.patchCardMessage(input);
      },
      onPatchError: (error, context) => {
        log.warn('飞书流式消息更新失败，回退为发送新消息', {
          userId: context.userId,
          streamId: context.streamId,
          messageId: context.messageId,
          error: error.message,
        });
      },
    });
  }
  return streamingTextSender;
}

async function enqueueSendText(channel: 'wecom' | 'feishu' | 'weixin', userId: string, content: string): Promise<string | undefined> {
  const structured = parseGatewayStructuredMessage(content);
  return enqueueOutboundSend(channel, userId, async () => {
    const replyContext = inboundReplyContext.get(`${channel}:${userId}`);
    const replyToMessageId = replyContext?.allowReply ? replyContext.messageId : undefined;
    const feishuReplyTarget = {
      receiveId: replyContext?.replyTargetId ?? userId,
      receiveIdType: replyContext?.replyTargetType ?? 'open_id',
    } as const;
    if (channel === 'weixin') {
      if (!weixinApi) {
        throw new Error('weixin api not configured');
      }
      const contextToken = weixinContextTokenStore.get(userId);
      if (!contextToken) {
        throw new Error(`missing weixin context token for ${userId}`);
      }
      if (structured) {
        if (structured.op !== 'send') {
          await weixinApi.sendText(userId, `❌ 个人微信暂不支持 ${structured.op} 消息操作。`, contextToken);
          return undefined;
        }
        if (!isGatewayMessageTypeSupported(channel, structured.msg_type)) {
          await weixinApi.sendText(userId, `❌ 不支持的个人微信 msg_type：${structured.msg_type}`, contextToken);
          return undefined;
        }
        await weixinApi.sendMessage(userId, {
          msgType: structured.msg_type,
          content: structured.content,
        }, contextToken);
        return undefined;
      }
      const outboundText = content;
      const outboundParts = splitWeixinOutboundText(outboundText);
      for (const part of outboundParts) {
        await weixinApi.sendText(userId, part, contextToken);
      }
      return undefined;
    }
    if (structured) {
      if (structured.op === 'recall') {
        if (channel === 'wecom') {
          if (!weComApi) {
            throw new Error('wecom api not configured');
          }
          await weComApi.sendText(userId, '❌ 企微暂不支持 recall 消息操作。');
          return undefined;
        }
        if (!feishuApi) {
          throw new Error('feishu api not configured');
        }
        await feishuApi.recallMessage(structured.message_id);
        return undefined;
      }
      if (!isGatewayMessageTypeSupported(channel, structured.msg_type)) {
        const message = `❌ 不支持的 ${channel === 'feishu' ? '飞书' : '企微'} msg_type：${structured.msg_type}`;
        if (channel === 'wecom') {
          if (!weComApi) {
            throw new Error('wecom api not configured');
          }
          await weComApi.sendText(userId, message);
          return undefined;
        }
        if (!feishuApi) {
          throw new Error('feishu api not configured');
        }
        return feishuApi.sendText(feishuReplyTarget, message, {
          replyToMessageId,
        });
      }
      if (channel === 'wecom') {
        if (!weComApi) {
          throw new Error('wecom api not configured');
        }
        if (structured.op !== 'send') {
          await weComApi.sendText(userId, `❌ 企微暂不支持 ${structured.op} 消息操作。`);
          return undefined;
        }
        await weComApi.sendMessage(userId, {
          msgType: structured.msg_type,
          content: structured.content,
        });
        return undefined;
      }
      if (!feishuApi) {
        throw new Error('feishu api not configured');
      }
      const normalizedFeishuMessage = normalizeFeishuStructuredMessage(structured.msg_type, structured.content);
      const feishuReplyOptions = extractFeishuReplyOptions(normalizedFeishuMessage.content);
      if (structured.op === 'update') {
        if (normalizedFeishuMessage.msgType === 'interactive') {
          await feishuApi.patchCardMessage({
            messageId: structured.message_id,
            content: feishuReplyOptions.content,
          });
          return undefined;
        }
        if (!isFeishuUpdateMessageType(normalizedFeishuMessage.msgType)) {
          const message = `❌ 不支持的飞书 update msg_type：${normalizedFeishuMessage.msgType}`;
          return feishuApi.sendText(feishuReplyTarget, message, {
            replyToMessageId,
          });
        }
        await feishuApi.updateMessage({
          messageId: structured.message_id,
          msgType: normalizedFeishuMessage.msgType,
          content: feishuReplyOptions.content,
        });
        return undefined;
      }
      return feishuApi.sendMessage(feishuReplyTarget, {
        msgType: normalizedFeishuMessage.msgType,
        content: feishuReplyOptions.content,
        replyToMessageId,
        replyInThread: feishuReplyOptions.replyInThread,
      });
    }

    if (channel === 'wecom') {
      if (!weComApi) {
        throw new Error('wecom api not configured');
      }
      await weComApi.sendText(userId, content);
      return undefined;
    }
    if (!feishuApi) {
      throw new Error('feishu api not configured');
    }
    return feishuApi.sendText(feishuReplyTarget, content, {
      replyToMessageId,
    });
  });
}

const handleChatText = createChatHandler({
  sessionStore,
  rateLimitStore,
  codexRunner,
  codexHomeDir: resolveRunnerHomeDir(config.codexProvider),
  agentWorkspaceManager,
  workspacePublisher,
  runnerEnabled: config.runnerEnabled,
  defaultProvider: config.codexProvider,
  resolveDefaultModel: resolveChatDefaultModel,
  resolveRunner,
  resolveRunnerHomeDir,
  defaultSearch: config.codexSearch,
  reminderDbPath,
  sendText,
  sendTextWithResult: enqueueSendText,
  sendStreamingText,
  openCodeAuthFlowManager,
  speechService: createSpeechService({
    speech: config.speech,
    apiTimeoutMs: config.apiTimeoutMs,
  }),
  ttsService: createTtsService({
    tts: config.speech.tts,
    apiTimeoutMs: config.apiTimeoutMs,
  }),
});

const reminderStore = new ReminderStore(reminderDbPath);
const reminderDispatcher = new ReminderDispatcher({
  store: reminderStore,
  sendText,
  onTriggerAgent: async (reminder) => {
    const sessionUserKey = resolveUserKey(reminder.userId);
    await runInUserQueue(sessionUserKey, async () => {
      await handleChatText({
        channel: reminder.channel,
        userId: reminder.userId,
        content: reminder.message,
        reminderTrigger: {
          reminderId: reminder.id,
          message: reminder.message,
          sourceAgentId: reminder.sourceAgentId,
        },
      });
    });
  },
});

const memorySteward = new MemorySteward({
  sessionStore,
  agentWorkspaceManager,
  codexRunner,
  enabled: config.memoryStewardEnabled,
  intervalMs: config.memoryStewardIntervalHours * 60 * 60_000,
  model: config.codexModel,
});

const sessionSummarySteward = new SessionSummarySteward({
  sessionStore,
  codexRunner,
  enabled: config.sessionSummaryStewardEnabled,
  intervalMs: config.sessionSummaryStewardIntervalMinutes * 60_000,
  model: config.codexModel,
});

const app = createApp({
  wecomEnabled: config.wecomEnabled,
  feishuEnabled: config.feishuEnabled,
  feishuAppId: config.feishuAppId,
  feishuAppSecret: config.feishuAppSecret,
  wecomCrypto,
  allowFrom: config.allowFrom,
  internalApiToken,
  gatewayRootDir,
  browserAutomation,
  openAiCompat: config.openAiCompat,
  feishuVerificationToken: config.feishuVerificationToken,
  feishuLongConnection: feishuStatusSummary.mode === 'long-connection',
  feishuGroupRequireMention: feishuStatusSummary.groupRequireMention,
  feishuBotOpenId: feishuBotIdentity.openId,
  feishuBotName: feishuBotIdentity.appName,
  feishuDocBaseUrlConfigured: feishuStatusSummary.docBaseUrlConfigured,
  feishuStartupHelpEnabled: feishuStatusSummary.startupHelpEnabled,
  feishuStartupHelpAdminConfigured: feishuStatusSummary.startupHelpAdminConfigured,
  isDuplicateMessage: (msgId) => dedupStore.isDuplicate(msgId),
  handleText: appDepsHandleText,
  handleFeishuCardAction: appDepsHandleFeishuCardAction,
});

app.post('/internal/external-chat', async (req, res) => {
  const token = req.header('x-gateway-internal-token');
  if (!internalApiToken || token !== internalApiToken) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  const body = req.body as {
    userId?: string;
    content?: string;
    channel?: 'wecom' | 'feishu';
  } | undefined;
  const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  const channel = body?.channel === 'wecom' ? 'wecom' : 'feishu';

  if (!userId || !content) {
    res.status(400).json({ ok: false, error: 'missing userId or content' });
    return;
  }

  const collected: string[] = [];
  const captureChatText = createChatHandler({
    sessionStore,
    rateLimitStore,
    codexRunner,
    codexHomeDir: resolveRunnerHomeDir(config.codexProvider),
    agentWorkspaceManager,
    workspacePublisher,
    runnerEnabled: config.runnerEnabled,
    defaultProvider: config.codexProvider,
    resolveDefaultModel: resolveChatDefaultModel,
    resolveRunner,
    resolveRunnerHomeDir,
    defaultSearch: config.codexSearch,
    reminderDbPath,
    sendText: async (_channel, _userId, outbound) => {
      collected.push(outbound);
    },
    openCodeAuthFlowManager,
    speechService: createSpeechService({
      speech: config.speech,
      apiTimeoutMs: config.apiTimeoutMs,
    }),
  });

  try {
    const sessionUserKey = resolveUserKey(userId);
    await runInUserQueue(sessionUserKey, async () => {
      await captureChatText({ channel, userId, content });
    });
    res.json({ ok: true, messages: collected });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      messages: collected,
    });
  }
});

async function enrichInboundContent(channel: 'wecom' | 'feishu' | 'weixin', content: string): Promise<InboundEnrichResult> {
  if (channel !== 'feishu' || !feishuApi) {
    return {
      content,
      attachmentRequired: false,
      attachmentDownloaded: false,
    };
  }
  const inboundRef = extractFeishuBinaryRef(content);
  if (!inboundRef) {
    return {
      content,
      attachmentRequired: false,
      attachmentDownloaded: false,
    };
  }
  try {
    if (!inboundRef.messageId) {
      return {
        content,
        attachmentRequired: true,
        attachmentDownloaded: false,
        errorMessage: 'missing message_id for feishu message.resource.get',
      };
    }
    const localPath = await feishuApi.downloadMessageResource({
      messageId: inboundRef.messageId,
      fileKey: inboundRef.key,
      type: mapFeishuResourceTypes(inboundRef.kind),
    });
    return {
      content: appendFeishuAttachmentMetadata(content, {
        kind: inboundRef.kind,
        localPath,
      }),
      attachmentRequired: true,
      attachmentDownloaded: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn('飞书二进制消息下载失败，继续仅使用 key 处理', {
      kind: inboundRef.kind,
      key: inboundRef.key,
      error: errorMessage,
    });
    return {
      content,
      attachmentRequired: true,
      attachmentDownloaded: false,
      errorMessage,
    };
  }
}

function extractWeixinText(message: WeixinInboundMessage): string {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text.trim();
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text.trim();
    }
  }
  return '';
}

function loadWeixinCursor(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { cursor?: string };
    return parsed.cursor?.trim() || '';
  } catch {
    return '';
  }
}

function loadWeixinSession(filePath: string): { baseUrl?: string; botToken?: string } | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { baseUrl?: string; botToken?: string };
    return {
      baseUrl: parsed.baseUrl?.trim(),
      botToken: parsed.botToken?.trim(),
    };
  } catch {
    return undefined;
  }
}

function saveWeixinCursor(filePath: string, cursor: string): void {
  fs.writeFileSync(filePath, JSON.stringify({ cursor }, null, 2), 'utf-8');
}

function startWeixinPoller(): void {
  if (!weixinApi) {
    return;
  }
  const poll = async () => {
    try {
      const result = await weixinApi.getUpdates(weixinCursor);
      if (typeof result.get_updates_buf === 'string' && result.get_updates_buf) {
        weixinCursor = result.get_updates_buf;
        saveWeixinCursor(weixinStatePath, weixinCursor);
      }
      const messages = Array.isArray(result.msgs) ? result.msgs : [];
      for (const msg of messages) {
        const msgId = String(msg.message_id ?? '');
        const text = extractWeixinText(msg);
        const fromUserId = msg.from_user_id?.trim();
        const contextToken = msg.context_token?.trim();
        if (!fromUserId || !contextToken || !text) {
          continue;
        }
        if (msgId && dedupStore.isDuplicate(`weixin:${msgId}`)) {
          continue;
        }
        weixinContextTokenStore.set(fromUserId, contextToken);
        const sessionUserKey = resolveUserKey(fromUserId);
        await runInUserQueue(sessionUserKey, async () => {
          await handleChatText({ channel: 'weixin', userId: fromUserId, content: text });
        });
      }
    } catch (error) {
      log.warn('Weixin poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTimeout(poll, config.weixinPollIntervalMs);
    }
  };
  void poll();
}

function mapFeishuResourceTypes(kind: 'image' | 'file' | 'audio' | 'media' | 'sticker'): Array<'image' | 'file'> {
  if (kind === 'image') {
    return ['image'];
  }
  if (kind === 'sticker') {
    throw new Error('sticker resource download is not supported by feishu message resource API');
  }
  if (kind === 'media') {
    return ['file', 'image'];
  }
  return ['file', 'image'];
}

app.listen(config.port, () => {
  log.info(`✅ AgentClaw 已启动，监听 http://127.0.0.1:${config.port}`);
  log.info('飞书运行状态摘要', feishuStatusSummary);
  if (config.feishuEnabled && config.feishuLongConnection && config.feishuAppId && config.feishuAppSecret) {
    const wsClient = new LarkWSClient({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      loggerLevel: LarkSdkLoggerLevel.error,
    });
    const eventDispatcher = new LarkEventDispatcher({
      loggerLevel: LarkSdkLoggerLevel.error,
    }).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        log.info('飞书长连接收到事件', { eventType: 'im.message.receive_v1' });
        dispatchFeishuMessageReceiveEvent({
          allowFrom: config.allowFrom,
          feishuGroupRequireMention: config.feishuGroupRequireMention,
          feishuBotOpenId: feishuBotIdentity.openId,
          feishuBotName: feishuBotIdentity.appName,
          isDuplicateMessage: (msgId) => dedupStore.isDuplicate(msgId),
          handleText: async (input) => appDepsHandleText(input),
          handleFeishuCardAction: async (input) => appDepsHandleFeishuCardAction(input),
        }, data);
      },
      'card.action.trigger': async (data: Record<string, unknown>) => {
        log.info('飞书长连接收到事件', { eventType: 'card.action.trigger' });
        dispatchFeishuCardActionEvent({
          allowFrom: config.allowFrom,
          feishuGroupRequireMention: config.feishuGroupRequireMention,
          feishuBotOpenId: feishuBotIdentity.openId,
          feishuBotName: feishuBotIdentity.appName,
          isDuplicateMessage: (msgId) => dedupStore.isDuplicate(msgId),
          handleText: async (input) => appDepsHandleText(input),
          handleFeishuCardAction: async (input) => appDepsHandleFeishuCardAction(input),
        }, data, {
          publicBaseUrl: config.gatewayPublicBaseUrl,
        });
      },
    });
    wsClient.start({ eventDispatcher }).then(async () => {
      log.info('✅ 飞书长连接已启动');
      try {
        await pushFeishuStartupHelp({
          enabled: config.feishuStartupHelpEnabled,
          adminOpenId: config.feishuStartupHelpAdminOpenId,
          sendText,
        });
      } catch (error) {
        log.warn('飞书启动帮助发送失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }).catch((error) => {
      log.error('❌ 飞书长连接启动失败', error);
    });
  } else if (config.feishuEnabled && feishuApi) {
    void pushFeishuStartupHelp({
      enabled: config.feishuStartupHelpEnabled,
      adminOpenId: config.feishuStartupHelpAdminOpenId,
      sendText,
    }).catch((error) => {
      log.warn('飞书启动帮助发送失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  memorySteward.start();
  sessionSummarySteward.start();
  reminderDispatcher.start();
  if (weixinApi) {
    startWeixinPoller();
  }
});

async function appDepsHandleText(input: {
  channel: 'wecom' | 'feishu' | 'weixin';
  userId: string;
  content: string;
  sourceMessageId?: string;
  allowReply?: boolean;
  replyTargetId?: string;
  replyTargetType?: 'open_id' | 'chat_id';
}): Promise<void> {
  const enrichResult = await enrichInboundContent(input.channel, input.content);
  if (enrichResult.attachmentRequired && !enrichResult.attachmentDownloaded) {
    await sendText(
      input.channel,
      input.userId,
      `❌ 附件下载失败，未调用 Codex。${enrichResult.errorMessage ? `原因：${enrichResult.errorMessage}` : ''}`,
    );
    return;
  }
  const sessionUserKey = resolveUserKey(input.userId);
  const execute = async () => {
    const contextKey = `${input.channel}:${input.userId}`;
    inboundReplyContext.set(contextKey, {
      messageId: input.channel === 'feishu' ? input.sourceMessageId : undefined,
      allowReply: input.channel === 'feishu' ? input.allowReply === true : false,
      replyTargetId: input.channel === 'feishu' ? input.replyTargetId : undefined,
      replyTargetType: input.channel === 'feishu' ? input.replyTargetType : undefined,
    });
    try {
      await handleChatText({ channel: input.channel, userId: input.userId, content: enrichResult.content });
    } finally {
      inboundReplyContext.delete(contextKey);
    }
  };
  if (isImmediateControlCommand(enrichResult.content)) {
    await execute();
    return;
  }
  await runInUserQueue(sessionUserKey, execute);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractCardField(value: Record<string, unknown>, key: string): string | undefined {
  const direct = value[key];
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const nested = asRecord(direct);
  if (typeof nested?.value === 'string' && nested.value.trim()) {
    return nested.value.trim();
  }
  if (typeof nested?.default_value === 'string' && nested.default_value.trim()) {
    return nested.default_value.trim();
  }
  return undefined;
}

async function appDepsHandleFeishuCardAction(input: {
  userId: string;
  chatId?: string;
  publicBaseUrl?: string;
  action: string;
  value: Record<string, unknown>;
}): Promise<void> {
  const currentAgent = sessionStore.getCurrentAgent(resolveUserKey(input.userId));
  const runtimeProvider = sessionStore.getProviderOverride?.(resolveUserKey(input.userId), currentAgent.agentId) ?? config.codexProvider;
  const runtimeProviderSpec = getCliProviderSpec(runtimeProvider);
  const runtimeRunner = resolveRunner(runtimeProvider);
  const runtimeHomeDir = resolveRunnerHomeDir(runtimeProvider);
  if (input.action === 'codex_login.start_device_auth') {
    try {
      await startCodexDeviceLogin({
        provider: runtimeProvider,
        channel: 'feishu',
        userId: input.userId,
        sendText,
        codexHomeDir: runtimeHomeDir,
        codexRunner: runtimeRunner,
      });
    } catch (error) {
      log.error('飞书设备授权登录失败', {
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      await sendText('feishu', input.userId, buildFeishuApiLoginResultMessage({
        provider: runtimeProvider,
        ok: false,
        message: `设备授权登录失败：${error instanceof Error ? error.message : String(error)}`,
        model: runtimeProviderSpec.defaultModel,
      }));
    }
    return;
  }

  if (input.action === 'opencode_login.start_provider_auth') {
    const providerId = extractCardField(input.value, 'provider_id') ?? '';
    if (!providerId) {
      await sendText('feishu', input.userId, '❌ 缺少登录渠道，无法启动登录。');
      return;
    }
    const authSessionKey = buildOpenCodeAuthSessionKey('feishu', input.userId, currentAgent.agentId);
    await openCodeAuthFlowManager.start({
      key: authSessionKey,
      provider: providerId,
      opencodeBin: config.opencodeBin,
      cliHomeDir: opencodeHomeDir,
      cwd: currentAgent.workspaceDir,
      publicBaseUrl: input.publicBaseUrl,
      baseEnv: process.env,
      onEvent: async (event) => {
        if (event.type === 'oauth_url') {
          await sendText('feishu', input.userId, buildFeishuOpenCodeOauthMessage({
            provider: event.provider,
            url: event.url,
          }));
          return;
        }
        if (event.type === 'input_required') {
          await sendText('feishu', input.userId, buildFeishuOpenCodeInputFallbackMessage({
            provider: event.provider,
            prompt: event.prompt,
          }));
          return;
        }
      },
      onExit: async (result) => {
        await sendText('feishu', input.userId, result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
      },
    });
    return;
  }

  if (input.action === 'opencode_login.submit_auth_input') {
    const authInput = extractCardField(input.value, 'auth_input') ?? '';
    const authSessionKey = buildOpenCodeAuthSessionKey('feishu', input.userId, currentAgent.agentId);
    const accepted = await openCodeAuthFlowManager.sendInput(authSessionKey, authInput);
    await sendText(
      'feishu',
      input.userId,
      accepted ? '⏳ 已继续 OpenCode 登录流程，请等待授权结果。' : '❌ 当前没有可继续的 OpenCode 登录流程，请重新点击 /login。',
    );
    return;
  }

  if (input.action === 'codex_login.open_api_form') {
    await sendText('feishu', input.userId, buildFeishuApiLoginFormMessage({
      provider: runtimeProvider,
      baseUrl: extractCardField(input.value, 'base_url'),
      model: extractCardField(input.value, 'model'),
      reasoningEffort: extractCardField(input.value, 'reasoning_effort'),
    }));
    return;
  }

  if (input.action === 'codex_login.submit_api_credentials') {
    try {
      const result = await writeCliApiLoginConfig({
        provider: runtimeProvider,
        cliHomeDir: runtimeHomeDir,
        baseUrl: extractCardField(input.value, 'base_url') ?? '',
        apiKey: extractCardField(input.value, 'api_key') ?? '',
        model: extractCardField(input.value, 'model') ?? runtimeProviderSpec.defaultModel,
        reasoningEffort: extractCardField(input.value, 'reasoning_effort'),
      });
      await sendText('feishu', input.userId, buildFeishuApiLoginResultMessage({
        provider: runtimeProvider,
        ok: true,
        message: `项目内 ${runtimeProviderSpec.label} API 配置已更新。`,
        baseUrl: result.baseUrl,
        model: result.model,
        maskedApiKey: result.maskedApiKey,
        reasoningEffort: result.reasoningEffort,
      }));
    } catch (error) {
      await sendText('feishu', input.userId, buildFeishuApiLoginResultMessage({
        provider: runtimeProvider,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        baseUrl: extractCardField(input.value, 'base_url') ?? '',
        model: extractCardField(input.value, 'model') ?? runtimeProviderSpec.defaultModel,
        reasoningEffort: extractCardField(input.value, 'reasoning_effort'),
      }));
    }
    return;
  }

  log.warn('收到未识别的飞书卡片受控动作', {
    userId: input.userId,
    chatId: input.chatId ?? '(empty)',
    action: input.action,
  });
}
