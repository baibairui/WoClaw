import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { startCodexDeviceLogin } from '../src/services/codex-login-flow.js';

function getCardButtons(payload: string): Array<{
  text?: { content?: string };
  multi_url?: { url?: string };
  value?: Record<string, unknown>;
}> {
  const parsed = JSON.parse(payload) as {
    content?: {
      body?: {
        elements?: Array<Record<string, unknown>>;
      };
    };
  };
  const elements = parsed.content?.body?.elements ?? [];
  return elements.flatMap((item) => {
    if (item.tag === 'button') {
      return [item];
    }
    if (item.tag === 'column_set') {
      const columns = Array.isArray(item.columns) ? item.columns as Array<Record<string, unknown>> : [];
      return columns.flatMap((column) => Array.isArray(column.elements) ? column.elements : []);
    }
    return [];
  }) as Array<{
    text?: { content?: string };
    multi_url?: { url?: string };
    value?: Record<string, unknown>;
  }>;
}

describe('startCodexDeviceLogin', () => {
  it('streams device auth progress to Feishu and finishes successfully', async () => {
    const sendText = vi.fn(async () => undefined);
    const login = vi.fn(async (input?: { onMessage?: (text: string) => void }) => {
      input?.onMessage?.('Open this URL and enter code ABCD-EFGH');
    });

    await startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_1',
      sendText,
      codexRunner: { login },
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(String(sendText.mock.calls[0]?.[2] ?? '')).toContain('正在重新请求设备登录码');
    expect(String(sendText.mock.calls[1]?.[2] ?? '')).toContain('ABCD-EFGH');
    expect(String(sendText.mock.calls[1]?.[2] ?? '')).not.toContain('Open this URL and enter code ABCD-EFGH');
    expect(String(sendText.mock.calls[2]?.[2] ?? '')).toContain('登录成功');
  });

  it('strips ansi escape sequences from device auth progress before sending cards', async () => {
    const sendText = vi.fn(async () => undefined);
    const login = vi.fn(async (input?: { onMessage?: (text: string) => void }) => {
      input?.onMessage?.('\u001b[32mOpen this URL and enter code ABCD-EFGH\u001b[0m');
    });

    await startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_ansi',
      sendText,
      codexRunner: { login },
    });

    const payload = String(sendText.mock.calls[1]?.[2] ?? '');
    expect(payload).toContain('ABCD-EFGH');
    expect(payload).not.toContain('Open this URL and enter code ABCD-EFGH');
    expect(payload).not.toContain('\u001b[');
  });

  it('renders a clickable authorization link for feishu device auth progress', async () => {
    const sendText = vi.fn(async () => undefined);
    const login = vi.fn(async (input?: { onMessage?: (text: string) => void }) => {
      input?.onMessage?.('Open https://auth.example.com/device and enter code ABCD-EFGH');
    });

    await startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_link',
      sendText,
      codexRunner: { login },
    });

    const progressPayload = String(sendText.mock.calls[1]?.[2] ?? '');
    const buttons = getCardButtons(progressPayload);
    expect(progressPayload).toContain('ABCD-EFGH');
    expect(buttons.some((button) => button.text?.content === '打开授权链接' && button.multi_url?.url === 'https://auth.example.com/device?user_code=ABCD-EFGH')).toBe(true);
  });

  it('starts device auth again and replaces previous cli auth when auth already exists', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-device-auth-existing-'));
    const authPath = path.join(codexHomeDir, 'auth.json');
    fs.writeFileSync(authPath, '{"tokens":"already-here"}\n', 'utf8');
    const sendText = vi.fn(async () => undefined);
    let oldAuthVisibleDuringLogin = true;
    const login = vi.fn(async (input?: { onMessage?: (text: string) => void }) => {
      oldAuthVisibleDuringLogin = fs.existsSync(authPath);
      input?.onMessage?.('Open https://auth.example.com/device and enter code WXYZ-1234');
      fs.writeFileSync(authPath, '{"tokens":"new-login"}\n', 'utf8');
    });

    await startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_existing',
      sendText,
      codexHomeDir,
      codexRunner: { login },
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(oldAuthVisibleDuringLogin).toBe(false);
    expect(fs.readFileSync(authPath, 'utf8')).toContain('new-login');
    expect(fs.existsSync(`${authPath}.device-auth-backup`)).toBe(false);
  });

  it('removes previous api login config after device auth succeeds', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-device-login-'));
    const configPath = path.join(codexHomeDir, 'config.toml');
    fs.writeFileSync(configPath, 'base_url = "https://codex.ai02.cn"\n', 'utf8');

    await startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_2',
      sendText: vi.fn(async () => undefined),
      codexHomeDir,
      codexRunner: {
        login: vi.fn(async () => undefined),
      },
    });

    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('restores previous api login config when device auth fails', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-device-login-fail-'));
    const configPath = path.join(codexHomeDir, 'config.toml');
    fs.writeFileSync(configPath, 'base_url = "https://codex.ai02.cn"\n', 'utf8');

    await expect(startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_3',
      sendText: vi.fn(async () => undefined),
      codexHomeDir,
      codexRunner: {
        login: vi.fn(async () => {
          throw new Error('device auth failed');
        }),
      },
    })).rejects.toThrow('device auth failed');

    expect(fs.readFileSync(configPath, 'utf8')).toContain('https://codex.ai02.cn');
  });

  it('restores previous cli auth when device re-login fails', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-device-auth-fail-'));
    const authPath = path.join(codexHomeDir, 'auth.json');
    fs.writeFileSync(authPath, '{"tokens":"old-login"}\n', 'utf8');

    await expect(startCodexDeviceLogin({
      channel: 'feishu',
      userId: 'ou_auth_fail',
      sendText: vi.fn(async () => undefined),
      codexHomeDir,
      codexRunner: {
        login: vi.fn(async () => {
          throw new Error('device auth failed');
        }),
      },
    })).rejects.toThrow('device auth failed');

    expect(fs.readFileSync(authPath, 'utf8')).toContain('old-login');
    expect(fs.existsSync(`${authPath}.device-auth-backup`)).toBe(false);
  });
});
