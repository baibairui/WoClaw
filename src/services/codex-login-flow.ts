import fs from 'node:fs';
import path from 'node:path';
import { buildFeishuDeviceAuthProgressMessage, formatCommandOutboundMessage } from './feishu-command-cards.js';
import { getCliProviderSpec, type CliProvider } from './cli-provider.js';

type Channel = 'wecom' | 'feishu' | 'weixin';

interface StartCodexDeviceLoginInput {
  provider?: CliProvider;
  channel: Channel;
  userId: string;
  sendText: (channel: Channel, userId: string, content: string) => Promise<void>;
  codexHomeDir?: string;
  codexRunner: {
    login(input: {
      onMessage?: (text: string) => void;
    }): Promise<void>;
  };
}

export async function startCodexDeviceLogin(input: StartCodexDeviceLoginInput): Promise<void> {
  const { channel, userId, sendText, codexHomeDir, codexRunner } = input;
  const provider = input.provider ?? 'codex';
  const providerSpec = getCliProviderSpec(provider);
  if (!providerSpec.supportsDeviceAuth) {
    throw new Error(`${providerSpec.label} does not support gateway device auth login`);
  }

  const sendCommandText = async (text: string): Promise<void> => {
    await sendText(channel, userId, formatCommandOutboundMessage(channel, '/login', text));
  };
  const sendDeviceAuthProgress = async (text: string): Promise<void> => {
    await sendText(
      channel,
      userId,
      channel === 'feishu'
        ? buildFeishuDeviceAuthProgressMessage({
            providerLabel: providerSpec.label,
            text,
          })
        : formatCommandOutboundMessage(channel, '/login', text),
    );
  };

  await sendCommandText(provider === 'codex'
    ? '⏳ 正在重新请求设备登录码，请稍候...'
    : `⏳ 正在重新请求 ${providerSpec.label} 设备登录码，请稍候...`);

  const suspendedAuth = suspendCliAuth(provider, codexHomeDir);
  const suspendedConfig = suspendCodexApiConfig(codexHomeDir);

  let lastStreamSend: Promise<void> = Promise.resolve();
  try {
    await codexRunner.login({
      onMessage: (text) => {
        const sanitized = sanitizeDeviceAuthMessage(text);
        if (!sanitized) {
          return;
        }
        lastStreamSend = sendDeviceAuthProgress(sanitized);
      },
    });
    await lastStreamSend;
    suspendedAuth.commit();
    suspendedConfig.commit();
    await sendCommandText(`✅ 登录成功！${providerSpec.label} CLI 已获得授权。`);
  } catch (error) {
    suspendedAuth.restore();
    suspendedConfig.restore();
    throw error;
  }
}

function sanitizeDeviceAuthMessage(text: string): string {
  return stripAnsi(text)
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function suspendCliAuth(provider: CliProvider, codexHomeDir: string | undefined): {
  commit: () => void;
  restore: () => void;
} {
  if (!codexHomeDir) {
    return {
      commit: () => undefined,
      restore: () => undefined,
    };
  }
  const resolvedHome = path.resolve(codexHomeDir);
  const authPath = provider === 'opencode'
    ? path.join(resolvedHome, '.local', 'share', 'opencode', 'auth.json')
    : path.join(resolvedHome, 'auth.json');
  if (!fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
    return {
      commit: () => undefined,
      restore: () => undefined,
    };
  }

  const backupPath = `${authPath}.device-auth-backup`;
  fs.rmSync(backupPath, { force: true });
  fs.renameSync(authPath, backupPath);

  let settled = false;
  return {
    commit: () => {
      if (settled) {
        return;
      }
      settled = true;
      if (!fs.existsSync(authPath)) {
        if (fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, authPath);
        }
        throw new Error('device auth did not write a new auth.json');
      }
      fs.rmSync(backupPath, { force: true });
    },
    restore: () => {
      if (settled) {
        return;
      }
      settled = true;
      fs.rmSync(authPath, { force: true });
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, authPath);
      }
    },
  };
}

function suspendCodexApiConfig(codexHomeDir: string | undefined): {
  commit: () => void;
  restore: () => void;
} {
  if (!codexHomeDir) {
    return {
      commit: () => undefined,
      restore: () => undefined,
    };
  }

  const configPath = path.join(path.resolve(codexHomeDir), 'config.toml');
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    return {
      commit: () => undefined,
      restore: () => undefined,
    };
  }

  const backupPath = `${configPath}.device-auth-backup`;
  fs.rmSync(backupPath, { force: true });
  fs.renameSync(configPath, backupPath);

  let settled = false;
  return {
    commit: () => {
      if (settled) {
        return;
      }
      settled = true;
      fs.rmSync(backupPath, { force: true });
    },
    restore: () => {
      if (settled) {
        return;
      }
      settled = true;
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, configPath);
      }
    },
  };
}
