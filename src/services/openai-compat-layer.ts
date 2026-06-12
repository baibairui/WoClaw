import express from 'express';
import { Readable } from 'node:stream';

export interface OpenAiCompatLayerOptions {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  clientApiKey?: string;
}

interface ChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
}

interface ResponseObject {
  id?: string;
  created_at?: number;
  model?: string;
  status?: string;
  output?: unknown;
  output_text?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export function createOpenAiCompatRouter(options: OpenAiCompatLayerOptions): express.Router {
  const router = express.Router();
  router.use(express.json({ type: 'application/json', limit: '8mb' }));

  router.post('/responses', async (req, res) => {
    if (!authorizeOpenAiCompatRequest(req, res, options)) {
      return;
    }
    await proxyResponsesRequest(req, res, options, req.body);
  });

  router.get('/models', async (req, res) => {
    if (!authorizeOpenAiCompatRequest(req, res, options)) {
      return;
    }
    const upstream = await fetch(upstreamUrl(options.upstreamBaseUrl, 'models'), {
      method: 'GET',
      headers: buildUpstreamHeaders(options.upstreamApiKey, req),
    });
    await forwardUpstreamResponse(upstream, res);
  });

  router.post('/chat/completions', async (req, res) => {
    if (!authorizeOpenAiCompatRequest(req, res, options)) {
      return;
    }

    const chatBody = (req.body ?? {}) as ChatCompletionRequest;
    const responsesBody = convertChatCompletionRequest(chatBody);
    const upstream = await fetch(upstreamUrl(options.upstreamBaseUrl, 'responses'), {
      method: 'POST',
      headers: buildUpstreamHeaders(options.upstreamApiKey, req),
      body: JSON.stringify(responsesBody),
    });

    if (chatBody.stream === true) {
      await streamResponsesAsChatCompletions(upstream, res, String(chatBody.model ?? ''));
      return;
    }

    const payload = await readUpstreamJson(upstream);
    if (!upstream.ok) {
      res.status(upstream.status).json(payload);
      return;
    }
    res.json(convertResponseToChatCompletion(payload as ResponseObject, String(chatBody.model ?? '')));
  });

  return router;
}

async function proxyResponsesRequest(
  req: express.Request,
  res: express.Response,
  options: OpenAiCompatLayerOptions,
  body: unknown,
): Promise<void> {
  const upstream = await fetch(upstreamUrl(options.upstreamBaseUrl, 'responses'), {
    method: 'POST',
    headers: buildUpstreamHeaders(options.upstreamApiKey, req),
    body: JSON.stringify(body ?? {}),
  });
  await forwardUpstreamResponse(upstream, res);
}

function authorizeOpenAiCompatRequest(
  req: express.Request,
  res: express.Response,
  options: OpenAiCompatLayerOptions,
): boolean {
  const expected = (options.clientApiKey?.trim() || options.upstreamApiKey.trim());
  const actual = parseBearerToken(req.header('authorization'));
  if (!expected || actual === expected) {
    return true;
  }
  res.status(401).json({
    error: {
      message: 'Invalid API key provided.',
      type: 'invalid_api_key',
      param: null,
      code: 'invalid_api_key',
    },
  });
  return false;
}

function convertChatCompletionRequest(input: ChatCompletionRequest): Record<string, unknown> {
  const instructions: string[] = [];
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const responseInput = messages.flatMap((message) => {
    const item = asRecord(message);
    const role = typeof item?.role === 'string' ? item.role : 'user';
    const content = item?.content;
    if (role === 'system' || role === 'developer') {
      const text = chatContentToText(content);
      if (text) {
        instructions.push(text);
      }
      return [];
    }
    return [{
      role: role === 'assistant' ? 'assistant' : 'user',
      content: chatContentToResponseContent(content),
    }];
  });

  return removeUndefinedValues({
    model: input.model,
    input: responseInput,
    instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined,
    stream: input.stream === true ? true : undefined,
    temperature: typeof input.temperature === 'number' ? input.temperature : undefined,
    top_p: typeof input.top_p === 'number' ? input.top_p : undefined,
    stop: input.stop,
    max_output_tokens: normalizeMaxOutputTokens(input.max_completion_tokens ?? input.max_tokens),
  });
}

function convertResponseToChatCompletion(response: ResponseObject, fallbackModel: string): Record<string, unknown> {
  const created = typeof response.created_at === 'number' ? response.created_at : Math.floor(Date.now() / 1000);
  const model = typeof response.model === 'string' && response.model ? response.model : fallbackModel;
  const outputText = extractResponseOutputText(response);
  return removeUndefinedValues({
    id: response.id ? `chatcmpl_${response.id}` : `chatcmpl_${created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: outputText,
        },
        finish_reason: response.status === 'incomplete' ? 'length' : 'stop',
      },
    ],
    usage: response.usage ? {
      prompt_tokens: response.usage.input_tokens ?? 0,
      completion_tokens: response.usage.output_tokens ?? 0,
      total_tokens: response.usage.total_tokens ?? 0,
    } : undefined,
  });
}

async function streamResponsesAsChatCompletions(
  upstream: Response,
  res: express.Response,
  fallbackModel: string,
): Promise<void> {
  if (!upstream.ok) {
    const payload = await readUpstreamJson(upstream);
    res.status(upstream.status).json(payload);
    return;
  }

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_${created}`;
  const model = fallbackModel || 'unknown';
  writeChatCompletionChunk(res, { id, created, model, delta: { role: 'assistant' } });

  let done = false;
  for await (const event of iterateSseEvents(upstream)) {
    if (event === '[DONE]') {
      continue;
    }
    const parsed = parseJsonObject(event);
    const type = typeof parsed?.type === 'string' ? parsed.type : '';
    if (type === 'response.output_text.delta' && typeof parsed?.delta === 'string') {
      writeChatCompletionChunk(res, {
        id,
        created,
        model,
        delta: {
          content: parsed.delta,
        },
      });
      continue;
    }
    if (type === 'response.completed') {
      const responseObject = asRecord(parsed?.response);
      writeChatCompletionChunk(res, {
        id: typeof responseObject?.id === 'string' ? `chatcmpl_${responseObject.id}` : id,
        created: typeof responseObject?.created_at === 'number' ? responseObject.created_at : created,
        model: typeof responseObject?.model === 'string' ? responseObject.model : model,
        delta: {},
        finishReason: 'stop',
      });
      done = true;
    }
  }

  if (!done) {
    writeChatCompletionChunk(res, {
      id,
      created,
      model,
      delta: {},
      finishReason: 'stop',
    });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function forwardUpstreamResponse(upstream: Response, res: express.Response): Promise<void> {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('content-type', contentType);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as never).pipe(res);
}

function writeChatCompletionChunk(
  res: express.Response,
  input: {
    id: string;
    created: number;
    model: string;
    delta: Record<string, unknown>;
    finishReason?: string;
  },
): void {
  res.write(`data: ${JSON.stringify({
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
  })}\n\n`);
}

async function* iterateSseEvents(upstream: Response): AsyncGenerator<string> {
  if (!upstream.body) {
    return;
  }
  const stream = Readable.fromWeb(upstream.body as never);
  let buffer = '';
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const eventBlock = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const event = parseSseData(eventBlock);
      if (event) {
        yield event;
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
  const finalEvent = parseSseData(buffer);
  if (finalEvent) {
    yield finalEvent;
  }
}

function parseSseData(block: string): string | undefined {
  const dataLines = block
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

async function readUpstreamJson(upstream: Response): Promise<unknown> {
  const text = await upstream.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text,
        type: 'upstream_error',
      },
    };
  }
}

function buildUpstreamHeaders(apiKey: string, req: express.Request): Headers {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('content-type', 'application/json');
  const accept = req.header('accept');
  if (accept) {
    headers.set('accept', accept);
  }
  return headers;
}

function upstreamUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '/');
}

function parseBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function chatContentToResponseContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: '' }];
  }
  const parts: Array<Record<string, unknown>> = content.flatMap((part): Array<Record<string, unknown>> => {
    const item = asRecord(part);
    if (!item) {
      return [];
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      return [{ type: 'input_text', text: item.text }];
    }
    const imageUrl = asRecord(item.image_url);
    if (item.type === 'image_url' && typeof imageUrl?.url === 'string') {
      return [{ type: 'input_image', image_url: imageUrl.url }];
    }
    return [];
  });
  return parts.length > 0 ? parts : [{ type: 'input_text', text: '' }];
}

function chatContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const item = asRecord(part);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractResponseOutputText(response: ResponseObject): string {
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const outputItem = asRecord(item);
    const content = Array.isArray(outputItem?.content) ? outputItem.content : [];
    for (const contentItem of content) {
      const part = asRecord(contentItem);
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

function normalizeMaxOutputTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function removeUndefinedValues(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
