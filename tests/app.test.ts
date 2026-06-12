import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import { createApp, dispatchFeishuCardActionEvent, dispatchFeishuMessageReceiveEvent } from '../src/app.js';

const serverRefs: Array<{ close: () => void }> = [];

afterAll(() => {
  for (const server of serverRefs) {
    server.close();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function startTestServer(options?: {
  feishuVerificationToken?: string;
  feishuLongConnection?: boolean;
  feishuGroupRequireMention?: boolean;
  feishuDocBaseUrlConfigured?: boolean;
  feishuStartupHelpEnabled?: boolean;
  feishuStartupHelpAdminConfigured?: boolean;
  handleText?: (input: {
    channel: 'wecom' | 'feishu';
    userId: string;
    content: string;
    sourceMessageId?: string;
    allowReply?: boolean;
    replyTargetId?: string;
    replyTargetType?: 'open_id' | 'chat_id';
  }) => Promise<void>;
  handleFeishuCardAction?: (input: {
    userId: string;
    chatId?: string;
    publicBaseUrl?: string;
    action: string;
    value: Record<string, unknown>;
  }) => Promise<void>;
  internalApiToken?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  gatewayRootDir?: string;
  browserAutomation?: {
    execute: (command: string, args: Record<string, unknown>) => Promise<{
      text: string;
      data?: Record<string, unknown>;
    }>;
  };
  openAiCompat?: {
    upstreamBaseUrl: string;
    upstreamApiKey: string;
    clientApiKey?: string;
  };
}) {
  const app = createApp({
    wecomEnabled: true,
    feishuEnabled: true,
    wecomCrypto: {
      verifySignature: () => true,
      decrypt: (input: string) => input,
    } as never,
    allowFrom: '*',
    feishuVerificationToken: options?.feishuVerificationToken,
    feishuLongConnection: options?.feishuLongConnection,
    feishuGroupRequireMention: options?.feishuGroupRequireMention,
    feishuDocBaseUrlConfigured: options?.feishuDocBaseUrlConfigured,
    feishuStartupHelpEnabled: options?.feishuStartupHelpEnabled,
    feishuStartupHelpAdminConfigured: options?.feishuStartupHelpAdminConfigured,
    internalApiToken: options?.internalApiToken,
    feishuAppId: options?.feishuAppId,
    feishuAppSecret: options?.feishuAppSecret,
    gatewayRootDir: options?.gatewayRootDir,
    browserAutomation: options?.browserAutomation,
    openAiCompat: options?.openAiCompat,
    isDuplicateMessage: () => false,
    handleText: options?.handleText ?? (async () => undefined),
    handleFeishuCardAction: options?.handleFeishuCardAction,
  });

  const server = app.listen(0);
  serverRefs.push(server);
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to acquire test server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startJsonUpstream(handler: (input: {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}) => Promise<{
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}>) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const result = await handler({
      path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
      method: req.method ?? 'GET',
      headers: new Headers(req.headers as Record<string, string>),
      body: rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {},
    });
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(key, value);
    }
    res.setHeader('content-type', 'application/json');
    res.statusCode = result.status ?? 200;
    res.end(JSON.stringify(result.body));
  });

  server.listen(0);
  serverRefs.push(server);
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to acquire test upstream address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startSseUpstream(handler: (input: {
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}) => string[]) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const events = handler({
      path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
      headers: new Headers(req.headers as Record<string, string>),
      body: rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {},
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const event of events) {
      res.write(event);
    }
    res.end();
  });

  server.listen(0);
  serverRefs.push(server);
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to acquire test upstream address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startWecomDisabledServer() {
  const app = createApp({
    wecomEnabled: false,
    feishuEnabled: false,
    allowFrom: '*',
    feishuGroupRequireMention: true,
    isDuplicateMessage: () => false,
    handleText: async () => undefined,
  });

  const server = app.listen(0);
  serverRefs.push(server);
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to acquire test server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('createApp wecom toggle', () => {
  it('does not expose wecom callback when disabled', async () => {
    const baseUrl = await startWecomDisabledServer();

    const response = await fetch(`${baseUrl}/wecom/callback`);

    expect(response.status).toBe(404);
  });

  it('exposes channel status in healthz', async () => {
    const baseUrl = await startTestServer({
      feishuLongConnection: true,
      feishuGroupRequireMention: true,
    });

    const response = await fetch(`${baseUrl}/healthz`);
    const payload = await response.json() as {
      ok?: boolean;
      channels?: {
        wecom?: { enabled?: boolean };
        feishu?: {
          enabled?: boolean;
          mode?: string;
          webhookEnabled?: boolean;
          groupRequireMention?: boolean;
          docBaseUrlConfigured?: boolean;
          startupHelpEnabled?: boolean;
          startupHelpAdminConfigured?: boolean;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.channels?.wecom?.enabled).toBe(true);
    expect(payload.channels?.feishu?.enabled).toBe(true);
    expect(payload.channels?.feishu?.mode).toBe('long-connection');
    expect(payload.channels?.feishu?.webhookEnabled).toBe(false);
    expect(payload.channels?.feishu?.groupRequireMention).toBe(true);
    expect(payload.channels?.feishu?.docBaseUrlConfigured).toBe(true);
    expect(payload.channels?.feishu?.startupHelpEnabled).toBe(false);
    expect(payload.channels?.feishu?.startupHelpAdminConfigured).toBe(false);
  });

  it('exposes feishu install-related status in healthz', async () => {
    const baseUrl = await startTestServer({
      feishuLongConnection: false,
      feishuGroupRequireMention: false,
      feishuDocBaseUrlConfigured: true,
      feishuStartupHelpEnabled: true,
      feishuStartupHelpAdminConfigured: true,
    });

    const response = await fetch(`${baseUrl}/healthz`);
    const payload = await response.json() as {
      channels?: {
        feishu?: {
          mode?: string;
          webhookEnabled?: boolean;
          groupRequireMention?: boolean;
          docBaseUrlConfigured?: boolean;
          startupHelpEnabled?: boolean;
          startupHelpAdminConfigured?: boolean;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.channels?.feishu?.mode).toBe('webhook');
    expect(payload.channels?.feishu?.webhookEnabled).toBe(true);
    expect(payload.channels?.feishu?.groupRequireMention).toBe(false);
    expect(payload.channels?.feishu?.docBaseUrlConfigured).toBe(true);
    expect(payload.channels?.feishu?.startupHelpEnabled).toBe(true);
    expect(payload.channels?.feishu?.startupHelpAdminConfigured).toBe(true);
  });
});

describe('createApp OpenAI compatibility routes', () => {
  it('proxies Responses API requests to the configured upstream', async () => {
    const upstreamCalls: Array<{
      path: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const upstreamBaseUrl = await startJsonUpstream(async (input) => {
      upstreamCalls.push({
        path: input.path,
        authorization: input.headers.get('authorization'),
        body: input.body,
      });
      return {
        body: {
          id: 'resp_test',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5',
          output: [],
        },
      };
    });
    const baseUrl = await startTestServer({
      openAiCompat: {
        upstreamBaseUrl,
        upstreamApiKey: 'upstream-secret',
        clientApiKey: 'client-secret',
      },
    });

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        input: 'hello',
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.id).toBe('resp_test');
    expect(upstreamCalls).toEqual([
      {
        path: '/responses',
        authorization: 'Bearer upstream-secret',
        body: {
          model: 'gpt-5',
          input: 'hello',
        },
      },
    ]);
  });

  it('proxies the model list endpoint for OpenAI-compatible clients', async () => {
    const upstreamCalls: Array<{ method: string; path: string }> = [];
    const upstreamBaseUrl = await startJsonUpstream(async (input) => {
      upstreamCalls.push({
        method: input.method,
        path: input.path,
      });
      return {
        body: {
          object: 'list',
          data: [
            {
              id: 'gpt-5',
              object: 'model',
            },
          ],
        },
      };
    });
    const baseUrl = await startTestServer({
      openAiCompat: {
        upstreamBaseUrl,
        upstreamApiKey: 'same-secret',
      },
    });

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        authorization: 'Bearer same-secret',
      },
    });
    const payload = await response.json() as { data?: Array<{ id?: string }> };

    expect(response.status).toBe(200);
    expect(upstreamCalls).toEqual([{ method: 'GET', path: '/models' }]);
    expect(payload.data?.[0]?.id).toBe('gpt-5');
  });

  it('converts Chat Completions requests to Responses API and maps the result back', async () => {
    const upstreamCalls: Array<Record<string, unknown>> = [];
    const upstreamBaseUrl = await startJsonUpstream(async (input) => {
      upstreamCalls.push(input.body);
      return {
        body: {
          id: 'resp_chat',
          object: 'response',
          created_at: 123,
          status: 'completed',
          model: 'gpt-5',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '你好，我是兼容层。',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 8,
            output_tokens: 6,
            total_tokens: 14,
          },
        },
      };
    });
    const baseUrl = await startTestServer({
      openAiCompat: {
        upstreamBaseUrl,
        upstreamApiKey: 'same-secret',
      },
    });

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer same-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '打个招呼' },
        ],
        temperature: 0.2,
        max_tokens: 64,
      }),
    });
    const payload = await response.json() as {
      object?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    expect(response.status).toBe(200);
    expect(upstreamCalls[0]).toEqual({
      model: 'gpt-5',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '打个招呼',
            },
          ],
        },
      ],
      instructions: '你是助手',
      temperature: 0.2,
      max_output_tokens: 64,
    });
    expect(payload.object).toBe('chat.completion');
    expect(payload.choices?.[0]?.message?.content).toBe('你好，我是兼容层。');
    expect(payload.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 6,
      total_tokens: 14,
    });
  });

  it('rejects OpenAI-compatible requests with an invalid client key', async () => {
    const upstreamBaseUrl = await startJsonUpstream(async () => ({
      body: { id: 'should_not_be_called' },
    }));
    const baseUrl = await startTestServer({
      openAiCompat: {
        upstreamBaseUrl,
        upstreamApiKey: 'upstream-secret',
        clientApiKey: 'client-secret',
      },
    });

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        input: 'hello',
      }),
    });
    const payload = await response.json() as { error?: { type?: string } };

    expect(response.status).toBe(401);
    expect(payload.error?.type).toBe('invalid_api_key');
  });

  it('converts streaming Responses events into Chat Completions chunks', async () => {
    const upstreamBaseUrl = await startSseUpstream(() => [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '好' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_stream', created_at: 321, model: 'gpt-5' } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const baseUrl = await startTestServer({
      openAiCompat: {
        upstreamBaseUrl,
        upstreamApiKey: 'same-secret',
      },
    });

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer same-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        messages: [
          { role: 'user', content: '流式打招呼' },
        ],
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"你"');
    expect(text).toContain('"content":"好"');
    expect(text).toContain('data: [DONE]');
  });
});

describe('createApp feishu oauth routes', () => {
  it('does not expose deprecated oauth endpoints', async () => {
    const baseUrl = await startTestServer();

    const oauthStart = await fetch(`${baseUrl}/feishu/oauth/start?gateway_user_id=u1`);
    const oauthCallback = await fetch(`${baseUrl}/feishu/oauth/callback?code=code_1&state=u1`);
    const authStatus = await fetch(`${baseUrl}/feishu/auth/status?gateway_user_id=u1`);

    expect(oauthStart.status).toBe(404);
    expect(oauthCallback.status).toBe(404);
    expect(authStatus.status).toBe(404);
  });

  it('does not expose the disabled feishu skill oauth callback', async () => {
    const baseUrl = await startTestServer({
      feishuAppId: 'cli_app',
      feishuAppSecret: 'cli_secret',
    });

    const response = await fetch(
      `${baseUrl}/feishu/skill/oauth/callback?code=code_123&state=test`,
    );

    expect(response.status).toBe(404);
  });
});

describe('createApp internal feishu user ops', () => {
  it('does not expose deprecated personal-feishu endpoints', async () => {
    const baseUrl = await startTestServer({
      internalApiToken: 'token-123',
      browserAutomation: {
        execute: vi.fn(async () => ({ text: 'ok' })),
      },
    });

    const calendarResponse = await fetch(`${baseUrl}/internal/feishu/user-calendar-event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-internal-token': 'token-123',
      },
      body: JSON.stringify({
        gatewayUserId: 'u1',
        summary: '评审会',
        startTime: '2026-03-10T09:00:00+08:00',
        endTime: '2026-03-10T10:00:00+08:00',
      }),
    });
    expect(calendarResponse.status).toBe(404);

    const oauthStartResponse = await fetch(`${baseUrl}/feishu/oauth/start?gateway_user_id=u1`);
    expect(oauthStartResponse.status).toBe(404);

    const taskResponse = await fetch(`${baseUrl}/internal/feishu/user-task`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-internal-token': 'token-123',
      },
      body: JSON.stringify({
        gatewayUserId: 'u1',
        summary: '整理周报',
      }),
    });
    expect(taskResponse.status).toBe(404);
  });
});

describe('createApp internal desktop execute', () => {
  it('does not expose the deprecated desktop gateway endpoint', async () => {
    const baseUrl = await startTestServer({
      internalApiToken: 'token-123',
      browserAutomation: {
        execute: vi.fn(async () => ({ text: 'ok' })),
      },
    });

    const response = await fetch(`${baseUrl}/internal/desktop/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-internal-token': 'token-123',
      },
      body: JSON.stringify({ command: 'frontmost-app', args: {} }),
    });

    expect(response.status).toBe(404);
  });
});

describe('createApp opencode oauth callback proxy', () => {
  it('forwards the public callback request back to the local opencode callback server', async () => {
    const realFetch = globalThis.fetch;
    const upstreamFetch = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
      text: async () => 'Authorization received. You can close this tab.',
    }));
    vi.stubGlobal('fetch', upstreamFetch);
    const baseUrl = await startTestServer();

    const response = await realFetch(
      `${baseUrl}/opencode/oauth/callback?gateway_target=%2Fcallback&code=code_123&state=state_456`,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe('Authorization received. You can close this tab.');
    expect(upstreamFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1455/callback?code=code_123&state=state_456',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
      }),
    );
    vi.stubGlobal('fetch', realFetch);
  });
});

describe('createApp feishu callback', () => {
  it('does not expose webhook endpoint when long connection mode is enabled', async () => {
    const baseUrl = await startTestServer({
      feishuLongConnection: true,
      feishuVerificationToken: 'expected-token',
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
  });

  it('rejects url_verification when token mismatch', async () => {
    const baseUrl = await startTestServer({ feishuVerificationToken: 'expected-token' });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url_verification',
        token: 'wrong-token',
        challenge: 'ping',
      }),
    });
    const payload = await response.json() as { code?: number; msg?: string };

    expect(response.status).toBe(403);
    expect(payload.code).toBe(403);
    expect(payload.msg).toBe('token mismatch');
  });

  it('accepts url_verification when token matches', async () => {
    const baseUrl = await startTestServer({ feishuVerificationToken: 'expected-token' });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url_verification',
        token: 'expected-token',
        challenge: 'ping',
      }),
    });
    const payload = await response.json() as { challenge?: string };

    expect(response.status).toBe(200);
    expect(payload.challenge).toBe('ping');
  });

  it('accepts image message and forwards normalized content', async () => {
    const handleText = vi.fn(async () => undefined);
    const baseUrl = await startTestServer({
      feishuVerificationToken: 'expected-token',
      handleText,
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          token: 'expected-token',
          event_type: 'im.message.receive_v1',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_1',
            chat_id: 'oc_dm_1',
            chat_type: 'p2p',
            message_type: 'image',
            content: JSON.stringify({ image_key: 'img_1' }),
          },
        },
      }),
    });
    const payload = await response.json() as { code?: number; msg?: string };

    expect(response.status).toBe(200);
    expect(payload.code).toBe(0);
    expect(payload.msg).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_1',
      content: '[飞书图片] image_key=img_1\nmessage_id=om_1',
      sourceMessageId: 'om_1',
      allowReply: true,
      replyTargetId: 'ou_1',
      replyTargetType: 'open_id',
    });
  });

  it('accepts card.action.trigger and forwards gateway command', async () => {
    const handleText = vi.fn(async () => undefined);
    const baseUrl = await startTestServer({
      feishuVerificationToken: 'expected-token',
      handleText,
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          token: 'expected-token',
          event_type: 'card.action.trigger',
        },
        event: {
          open_message_id: 'om_card_1',
          operator: {
            operator_id: {
              open_id: 'ou_card_1',
            },
          },
          context: {
            chat_id: 'oc_group_1',
          },
          action: {
            value: {
              gateway_cmd: '/skills global',
            },
          },
        },
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual({});
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_card_1',
      content: '/skills global',
      replyTargetId: 'oc_group_1',
      replyTargetType: 'chat_id',
    });
  });

  it('accepts card.action.trigger and routes gateway action without forwarding text', async () => {
    const handleText = vi.fn(async () => undefined);
    const handleFeishuCardAction = vi.fn(async () => undefined);
    const baseUrl = await startTestServer({
      feishuVerificationToken: 'expected-token',
      handleText,
      handleFeishuCardAction,
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          token: 'expected-token',
          event_type: 'card.action.trigger',
        },
        event: {
          operator: {
            operator_id: {
              open_id: 'ou_card_2',
            },
          },
          context: {
            chat_id: 'oc_group_2',
          },
          action: {
            value: {
              gateway_action: 'codex_login.open_api_form',
              base_url: 'https://codex.ai02.cn',
            },
          },
        },
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual({});
    expect(handleText).not.toHaveBeenCalled();
    expect(handleFeishuCardAction).toHaveBeenCalledWith({
      userId: 'ou_card_2',
      chatId: 'oc_group_2',
      publicBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      action: 'codex_login.open_api_form',
      value: {
        gateway_action: 'codex_login.open_api_form',
        base_url: 'https://codex.ai02.cn',
      },
    });
  });

  it('accepts device auth card action and routes it without forwarding text', async () => {
    const handleText = vi.fn(async () => undefined);
    const handleFeishuCardAction = vi.fn(async () => undefined);
    const baseUrl = await startTestServer({
      feishuVerificationToken: 'expected-token',
      handleText,
      handleFeishuCardAction,
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          token: 'expected-token',
          event_type: 'card.action.trigger',
        },
        event: {
          operator: {
            operator_id: {
              open_id: 'ou_card_3',
            },
          },
          context: {
            chat_id: 'oc_group_3',
          },
          action: {
            value: {
              gateway_action: 'codex_login.start_device_auth',
            },
          },
        },
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual({});
    expect(handleText).not.toHaveBeenCalled();
    expect(handleFeishuCardAction).toHaveBeenCalledWith({
      userId: 'ou_card_3',
      chatId: 'oc_group_3',
      publicBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      action: 'codex_login.start_device_auth',
      value: {
        gateway_action: 'codex_login.start_device_auth',
      },
    });
  });

  it('accepts opencode oauth fallback input card action and routes it without forwarding text', async () => {
    const handleText = vi.fn(async () => undefined);
    const handleFeishuCardAction = vi.fn(async () => undefined);
    const baseUrl = await startTestServer({
      feishuVerificationToken: 'expected-token',
      handleText,
      handleFeishuCardAction,
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          token: 'expected-token',
          event_type: 'card.action.trigger',
        },
        event: {
          operator: {
            operator_id: {
              open_id: 'ou_card_4',
            },
          },
          context: {
            chat_id: 'oc_group_4',
          },
          action: {
            value: {
              gateway_action: 'opencode_login.submit_auth_input',
              auth_input: '123456',
              provider_id: 'openai',
            },
          },
        },
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual({});
    expect(handleText).not.toHaveBeenCalled();
    expect(handleFeishuCardAction).toHaveBeenCalledWith({
      userId: 'ou_card_4',
      chatId: 'oc_group_4',
      publicBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      action: 'opencode_login.submit_auth_input',
      value: {
        gateway_action: 'opencode_login.submit_auth_input',
        auth_input: '123456',
        provider_id: 'openai',
      },
    });
  });

  it('merges feishu form_value into controlled card actions', async () => {
    const handleText = vi.fn(async () => undefined);
    const handleFeishuCardAction = vi.fn(async () => undefined);
    const baseUrl = await startTestServer({
      feishuVerificationToken: 'expected-token',
      handleText,
      handleFeishuCardAction,
    });

    const response = await fetch(`${baseUrl}/feishu/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: '2.0',
        header: {
          token: 'expected-token',
          event_type: 'card.action.trigger',
        },
        event: {
          operator: {
            operator_id: {
              open_id: 'ou_card_5',
            },
          },
          context: {
            chat_id: 'oc_group_5',
          },
          action: {
            value: {
              gateway_action: 'codex_login.submit_api_credentials',
            },
            form_value: {
              base_url: {
                default_value: 'https://api.openai.com/v1',
              },
              api_key: {
                value: 'sk-test',
              },
              model: {
                default_value: 'gpt-5',
              },
            },
          },
        },
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual({});
    expect(handleText).not.toHaveBeenCalled();
    expect(handleFeishuCardAction).toHaveBeenCalledWith({
      userId: 'ou_card_5',
      chatId: 'oc_group_5',
      publicBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      action: 'codex_login.submit_api_credentials',
      value: {
        gateway_action: 'codex_login.submit_api_credentials',
        base_url: {
          default_value: 'https://api.openai.com/v1',
        },
        api_key: {
          value: 'sk-test',
        },
        model: {
          default_value: 'gpt-5',
        },
      },
    });
  });
});

describe('dispatchFeishuMessageReceiveEvent', () => {
  it('accepts long connection event payload and forwards normalized content', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: false,
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_ws_1' } },
      message: {
        message_id: 'om_ws_1',
        chat_id: 'oc_dm_2',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello from ws' }),
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_ws_1',
      content: 'hello from ws',
      sourceMessageId: 'om_ws_1',
      allowReply: true,
      replyTargetId: 'ou_ws_1',
      replyTargetType: 'open_id',
    });
  });

  it('accepts long connection payloads whose content is already an object', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: false,
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_ws_2' } },
      message: {
        message_id: 'om_ws_2',
        chat_id: 'oc_dm_3',
        chat_type: 'p2p',
        message_type: 'text',
        content: { text: 'hello from object payload' },
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_ws_2',
      content: 'hello from object payload',
      sourceMessageId: 'om_ws_2',
      allowReply: true,
      replyTargetId: 'ou_ws_2',
      replyTargetType: 'open_id',
    });
  });

  it('uses chat_id as reply target for group messages', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: false,
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_1' } },
      message: {
        message_id: 'om_group_1',
        chat_id: 'oc_group_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello group' }),
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_group_1',
      content: 'hello group',
      sourceMessageId: 'om_group_1',
      allowReply: true,
      replyTargetId: 'oc_group_1',
      replyTargetType: 'chat_id',
    });
  });

  it('ignores group messages without @ mention when mention trigger is enabled', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: true,
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_2' } },
      message: {
        message_id: 'om_group_2',
        chat_id: 'oc_group_2',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'plain group message' }),
      },
    });

    expect(result).toBe('success');
    expect(handleText).not.toHaveBeenCalled();
  });

  it('accepts group messages with text_without_at_bot when mention trigger is enabled', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: true,
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_3' } },
      message: {
        message_id: 'om_group_3',
        chat_id: 'oc_group_3',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: '@机器人 帮我总结',
          text_without_at_bot: '帮我总结',
        }),
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_group_3',
      content: '帮我总结',
      sourceMessageId: 'om_group_3',
      allowReply: true,
      replyTargetId: 'oc_group_3',
      replyTargetType: 'chat_id',
    });
  });

  it('accepts group messages with bot mention id when text_without_at_bot is absent', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: true,
      feishuBotOpenId: 'ou_bot_1',
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_5' } },
      message: {
        message_id: 'om_group_5',
        chat_id: 'oc_group_5',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 在吗' }),
        mentions: [
          {
            key: '@_user_1',
            id: 'ou_bot_1',
            id_type: 'open_id',
            name: '机器人',
          },
        ],
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_group_5',
      content: '@_user_1 在吗',
      sourceMessageId: 'om_group_5',
      allowReply: true,
      replyTargetId: 'oc_group_5',
      replyTargetType: 'chat_id',
    });
  });

  it('accepts group post messages with bot mention id and preserves markdown-style content', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: true,
      feishuBotOpenId: 'ou_bot_post_1',
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_post_1' } },
      message: {
        message_id: 'om_group_post_1',
        chat_id: 'oc_group_post_1',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            title: '问题清单',
            content: [[{
              tag: 'md',
              text: '1. 第一项\n2. 第二项',
            }]],
          },
        }),
        mentions: [
          {
            key: '@_user_1',
            id: 'ou_bot_post_1',
            id_type: 'open_id',
            name: '机器人',
          },
        ],
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_group_post_1',
      content: expect.stringContaining('1. 第一项'),
      sourceMessageId: 'om_group_post_1',
      allowReply: true,
      replyTargetId: 'oc_group_post_1',
      replyTargetType: 'chat_id',
    });
  });

  it('accepts p2p root-level post payloads and preserves ordered text content', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_post_root_1' } },
      message: {
        message_id: 'om_post_root_1',
        chat_id: 'oc_post_root_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          title: '',
          content: [
            [
              { tag: 'text', text: '1. ', style: [] },
              { tag: 'text', text: '为什么是用 npm 来安装依赖和运行？', style: [] },
            ],
            [
              { tag: 'text', text: '2. ', style: [] },
              { tag: 'text', text: '为什么 deploy.sh 会不存在？', style: [] },
            ],
          ],
        }),
      },
    });

    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_post_root_1',
      content: expect.stringContaining('1. 为什么是用 npm 来安装依赖和运行？'),
      sourceMessageId: 'om_post_root_1',
      allowReply: true,
      replyTargetId: 'ou_post_root_1',
      replyTargetType: 'open_id',
    });
  });

  it('ignores group messages that only @ other users when mention trigger is enabled', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: true,
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_4' } },
      message: {
        message_id: 'om_group_4',
        chat_id: 'oc_group_4',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@张三 帮我看下' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_other_user' },
            name: '张三',
            tenant_key: 'tenant_x',
          },
        ],
      },
    });

    expect(result).toBe('success');
    expect(handleText).not.toHaveBeenCalled();
  });

  it('ignores group messages that @ others when bot open id is configured', async () => {
    const handleText = vi.fn(async () => undefined);

    const result = dispatchFeishuMessageReceiveEvent({
      allowFrom: '*',
      feishuGroupRequireMention: true,
      feishuBotOpenId: 'ou_bot_2',
      isDuplicateMessage: () => false,
      handleText,
    }, {
      sender: { sender_id: { open_id: 'ou_group_6' } },
      message: {
        message_id: 'om_group_6',
        chat_id: 'oc_group_6',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 帮忙看看' }),
        mentions: [
          {
            key: '@_user_1',
            id: 'ou_other_6',
            id_type: 'open_id',
            name: '其他同学',
          },
        ],
      },
    });

    expect(result).toBe('success');
    expect(handleText).not.toHaveBeenCalled();
  });
});

describe('dispatchFeishuCardActionEvent', () => {
  it('forwards card command to chat handler', async () => {
    const handleText = vi.fn(async () => undefined);
    const result = dispatchFeishuCardActionEvent({
      allowFrom: '*',
      isDuplicateMessage: () => false,
      handleText,
    }, {
      operator: {
        operator_id: {
          open_id: 'ou_2',
        },
      },
      context: {
        chat_id: 'oc_2',
      },
      action: {
        value: {
          gateway_cmd: '/agents',
        },
      },
    });
    expect(result).toBe('success');
    expect(handleText).toHaveBeenCalledWith({
      channel: 'feishu',
      userId: 'ou_2',
      content: '/agents',
      replyTargetId: 'oc_2',
      replyTargetType: 'chat_id',
    });
  });

  it('passes the configured public base url through controlled card actions', async () => {
    const handleFeishuCardAction = vi.fn(async () => undefined);

    const result = dispatchFeishuCardActionEvent({
      allowFrom: '*',
      isDuplicateMessage: () => false,
      handleText: vi.fn(async () => undefined),
      handleFeishuCardAction,
    }, {
      operator: {
        operator_id: {
          open_id: 'ou_3',
        },
      },
      context: {
        chat_id: 'oc_3',
      },
      action: {
        value: {
          gateway_action: 'opencode_login.start_provider_auth',
          provider_id: 'openai',
        },
      },
    }, {
      publicBaseUrl: 'https://gateway.example.com',
    });

    expect(result).toBe('success');
    expect(handleFeishuCardAction).toHaveBeenCalledWith({
      userId: 'ou_3',
      chatId: 'oc_3',
      publicBaseUrl: 'https://gateway.example.com',
      action: 'opencode_login.start_provider_auth',
      value: {
        gateway_action: 'opencode_login.start_provider_auth',
        provider_id: 'openai',
      },
    });
  });
});
