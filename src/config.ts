import dotenv from 'dotenv';
import { resolveCliProvider, resolveCodexBin, resolveOpenCodeBin } from './services/cli-provider.js';

dotenv.config();

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid number env: ${name}`);
  }
  return value;
}

function optionalNumberUndefined(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid number env: ${name}`);
  }
  return value;
}

function optionalString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return raw.trim();
}

function optionalStringUndefined(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  return value ? value : undefined;
}

function optionalStringUndefinedRaw(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, '');
}

function optionalBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`invalid boolean env: ${name}`);
}

function optionalCsv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function codexSandboxMode(): 'full-auto' | 'none' {
  const value = process.env.CODEX_SANDBOX ?? 'full-auto';
  if (value === 'full-auto' || value === 'none') {
    return value;
  }
  throw new Error(`invalid CODEX_SANDBOX: ${value}`);
}

function speechMode(): 'transcribe_only' | 'transcribe_and_reply' {
  const value = process.env.SPEECH_MODE ?? 'transcribe_and_reply';
  if (value === 'transcribe_only' || value === 'transcribe_and_reply') {
    return value;
  }
  throw new Error(`invalid SPEECH_MODE: ${value}`);
}

const resolvedCodexBin = resolveCodexBin(process.env.CODEX_BIN);

export const config = {
  port: optionalNumber('PORT', 3000),
  wecomEnabled: process.env.WECOM_ENABLED !== 'false',
  corpId: optionalStringUndefined('WEWORK_CORP_ID'),
  corpSecret: optionalStringUndefined('WEWORK_SECRET'),
  agentId: optionalNumberUndefined('WEWORK_AGENT_ID'),
  token: optionalStringUndefined('WEWORK_TOKEN'),
  encodingAesKey: optionalStringUndefined('WEWORK_ENCODING_AES_KEY'),
  confirmTtlSeconds: optionalNumber('CONFIRM_TTL_SECONDS', 120),
  commandTimeoutMs: optionalNumberUndefined('COMMAND_TIMEOUT_MS'),
  commandTimeoutMinMs: optionalNumber('COMMAND_TIMEOUT_MIN_MS', 180_000),
  commandTimeoutMaxMs: optionalNumber('COMMAND_TIMEOUT_MAX_MS', 900_000),
  commandTimeoutPerCharMs: optionalNumber('COMMAND_TIMEOUT_PER_CHAR_MS', 80),
  apiTimeoutMs: optionalNumber('API_TIMEOUT_MS', 15_000),
  apiRetryOnTimeout: process.env.API_RETRY_ON_TIMEOUT === 'true',
  feishuEnabled: process.env.FEISHU_ENABLED === 'true',
  feishuAppId: optionalStringUndefined('FEISHU_APP_ID'),
  feishuAppSecret: optionalStringUndefined('FEISHU_APP_SECRET'),
  feishuDocBaseUrl: optionalStringUndefined('FEISHU_DOC_BASE_URL'),
  feishuVerificationToken: optionalStringUndefined('FEISHU_VERIFICATION_TOKEN'),
  feishuLongConnection: process.env.FEISHU_LONG_CONNECTION === 'true',
  feishuGroupRequireMention: process.env.FEISHU_GROUP_REQUIRE_MENTION !== 'false',
  feishuApiTimeoutMs: optionalNumber('FEISHU_API_TIMEOUT_MS', 15_000),
  feishuStartupHelpEnabled: process.env.FEISHU_STARTUP_HELP_ENABLED === 'true',
  feishuStartupHelpAdminOpenId: optionalStringUndefined('FEISHU_STARTUP_HELP_ADMIN_OPEN_ID'),
  weixinEnabled: process.env.WEIXIN_ENABLED === 'true',
  weixinBaseUrl: normalizeBaseUrl(optionalStringUndefined('WEIXIN_BASE_URL')) ?? 'https://ilinkai.weixin.qq.com',
  weixinBotToken: optionalStringUndefined('WEIXIN_BOT_TOKEN'),
  weixinPollIntervalMs: optionalNumber('WEIXIN_POLL_INTERVAL_MS', 1000),
  dedupWindowSeconds: optionalNumber('DEDUP_WINDOW_SECONDS', 60),
  rateLimitMaxMessages: optionalNumber('RATE_LIMIT_MAX_MESSAGES', 20),
  rateLimitWindowSeconds: optionalNumber('RATE_LIMIT_WINDOW_SECONDS', 60),
  allowFrom: optionalString('ALLOW_FROM', '*'),
  codexProvider: resolveCliProvider(process.env.CODEX_PROVIDER, resolvedCodexBin),
  codexBin: resolvedCodexBin,
  opencodeBin: resolveOpenCodeBin(process.env.OPENCODE_BIN),
  codexModel: optionalStringUndefined('CODEX_MODEL'),
  codexSearch: process.env.CODEX_SEARCH === 'true',
  codexWorkdir: process.env.CODEX_WORKDIR ?? process.cwd(),
  gatewayRootDir: optionalStringUndefinedRaw('GATEWAY_ROOT_DIR'),
  gatewayPublicBaseUrl: normalizeBaseUrl(optionalStringUndefined('GATEWAY_PUBLIC_BASE_URL')),
  codexAgentsDir: optionalStringUndefined('CODEX_AGENTS_DIR'),
  /** 'full-auto' (默认，有沙箱) 或 'none' (跳过沙箱，适合服务器) */
  codexSandbox: codexSandboxMode(),
  browserAutomationEnabled: optionalBoolean('BROWSER_AUTOMATION_ENABLED')
    ?? (process.env.BROWSER_MCP_ENABLED !== 'false'),
  browserProfileDir: optionalStringUndefined('BROWSER_PROFILE_DIR')
    ?? optionalStringUndefined('BROWSER_MCP_PROFILE_DIR'),
  runnerEnabled: process.env.RUNNER_ENABLED !== 'false',
  sessionSummaryStewardEnabled: process.env.SESSION_SUMMARY_STEWARD_ENABLED !== 'false',
  sessionSummaryStewardIntervalMinutes: optionalNumber('SESSION_SUMMARY_STEWARD_INTERVAL_MINUTES', 10),
  openAiCompat: (() => {
    const upstreamBaseUrl = normalizeBaseUrl(optionalStringUndefined('OPENAI_COMPAT_UPSTREAM_BASE_URL'));
    const upstreamApiKey = optionalStringUndefined('OPENAI_COMPAT_UPSTREAM_API_KEY');
    if (!upstreamBaseUrl || !upstreamApiKey) {
      return undefined;
    }
    return {
      upstreamBaseUrl,
      upstreamApiKey,
      clientApiKey: optionalStringUndefined('OPENAI_COMPAT_API_KEY'),
    };
  })(),
  speech: {
    enabled: process.env.SPEECH_ENABLED === 'true',
    mode: speechMode(),
    stt: {
      provider: optionalString('SPEECH_STT_PROVIDER', 'openai-compatible'),
      baseUrl: normalizeBaseUrl(optionalStringUndefined('SPEECH_STT_BASE_URL')),
      apiKeyEnv: optionalString('SPEECH_STT_API_KEY_ENV', 'OPENAI_API_KEY'),
      model: optionalString('SPEECH_STT_MODEL', 'gpt-4o-mini-transcribe'),
    },
    tts: {
      enabled: process.env.SPEECH_TTS_ENABLED === 'true',
      provider: optionalString('SPEECH_TTS_PROVIDER', 'minimax'),
      baseUrl: normalizeBaseUrl(optionalStringUndefined('SPEECH_TTS_BASE_URL')),
      apiKeyEnv: optionalString('SPEECH_TTS_API_KEY_ENV', 'MINIMAX_API_KEY'),
      model: optionalString('SPEECH_TTS_MODEL', 'speech-2.8-hd'),
      voiceId: optionalString('SPEECH_TTS_VOICE_ID', 'Chinese (Mandarin)_Cheerful_Sunshine'),
      outputFormat: optionalString('SPEECH_TTS_AUDIO_FORMAT', 'mp3') as 'mp3' | 'wav' | 'flac',
      audio: {
        sampleRate: optionalNumber('SPEECH_TTS_AUDIO_SAMPLE_RATE', 32000),
        bitrate: optionalNumber('SPEECH_TTS_AUDIO_BITRATE', 128000),
        channel: optionalNumber('SPEECH_TTS_AUDIO_CHANNEL', 1),
      },
      voice: {
        speed: optionalNumber('SPEECH_TTS_VOICE_SPEED', 1),
        vol: optionalNumber('SPEECH_TTS_VOICE_VOL', 1),
        pitch: optionalNumber('SPEECH_TTS_VOICE_PITCH', 0),
      },
    },
    audio: {
      maxSizeMb: optionalNumber('SPEECH_AUDIO_MAX_SIZE_MB', 25),
      maxDurationSec: optionalNumber('SPEECH_AUDIO_MAX_DURATION_SEC', 300),
      allowedMimeTypes: optionalCsv('SPEECH_AUDIO_ALLOWED_MIME_TYPES', [
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
        'audio/wav',
        'audio/webm',
      ]),
    },
    prompt: {
      includeTranscriptMeta: optionalBoolean('SPEECH_PROMPT_INCLUDE_TRANSCRIPT_META') ?? true,
    },
  },
};

if (config.feishuEnabled) {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error(
      '飞书配置不完整：启用 FEISHU_ENABLED=true 时必须配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。' +
      ' 可先执行 agentclaw setup 或 agentclaw doctor 进行安装自检。',
    );
  }
}

if (config.wecomEnabled) {
  if (!config.corpId || !config.corpSecret || config.agentId === undefined || !config.token || !config.encodingAesKey) {
    throw new Error(
      'missing required env for WeCom: WEWORK_CORP_ID / WEWORK_SECRET / WEWORK_AGENT_ID / WEWORK_TOKEN / WEWORK_ENCODING_AES_KEY',
    );
  }
}
