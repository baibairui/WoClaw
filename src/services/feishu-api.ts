import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client as LarkClient, Domain as LarkDomain, LoggerLevel as LarkLoggerLevel } from '@larksuiteoapi/node-sdk';

import { createLogger } from '../utils/logger.js';

const log = createLogger('FeishuApi');

interface FeishuApiOptions {
  appId: string;
  appSecret: string;
  timeoutMs?: number;
  retryOnTimeout?: boolean;
  imageCacheDir?: string;
  sdkClient?: FeishuSdkClient;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

export interface FeishuReceiveTarget {
  receiveId: string;
  receiveIdType: 'open_id' | 'chat_id';
}

export interface FeishuOutgoingMessage {
  msgType: string;
  content: Record<string, unknown> | string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}

export interface FeishuMessageUpdateInput {
  messageId: string;
  msgType: 'text' | 'markdown' | 'post' | 'interactive';
  content: Record<string, unknown> | string;
}

interface FeishuSdkClient {
  im: {
    message: {
      create: (payload: {
        params: { receive_id_type: 'open_id' | 'chat_id' };
        data: {
          receive_id: string;
          msg_type: string;
          content: string;
          uuid?: string;
        };
      }) => Promise<{
        code?: number;
        msg?: string;
        data?: {
          message_id?: string;
        };
      }>;
      reply: (payload: {
        path: { message_id: string };
        data: {
          content: string;
          msg_type: string;
          reply_in_thread?: boolean;
          uuid?: string;
        };
      }) => Promise<{
        code?: number;
        msg?: string;
        data?: {
          message_id?: string;
        };
      }>;
      update: (payload: {
        path: { message_id: string };
        data: {
          msg_type: string;
          content: string;
        };
      }) => Promise<{
        code?: number;
        msg?: string;
      }>;
    };
    image: {
      create: (payload: {
        data: {
          image_type: 'message' | 'avatar';
          image: Buffer | fs.ReadStream;
        };
      }) => Promise<{
        image_key?: string;
      } | null>;
    };
    file: {
      create: (payload: {
        data: {
          file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
          file_name: string;
          duration?: number;
          file: Buffer | fs.ReadStream;
        };
      }) => Promise<{
        file_key?: string;
      } | null>;
    };
    messageResource: {
      get: (payload: {
        params: { type: string };
        path: { message_id: string; file_key: string };
      }) => Promise<{
        writeFile: (filePath: string) => Promise<unknown>;
        headers?: unknown;
      }>;
    };
  };
}

const DEFAULT_TEXT_CHUNK_BYTES = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function utf8Bytes(input: string): number {
  return Buffer.byteLength(input, 'utf8');
}

export function splitFeishuTextByUtf8Bytes(content: string, maxBytes = DEFAULT_TEXT_CHUNK_BYTES): string[] {
  if (!content) {
    return [''];
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const ch of content) {
    const bytes = utf8Bytes(ch);
    if (currentBytes + bytes > maxBytes && current) {
      chunks.push(current);
      current = ch;
      currentBytes = bytes;
      continue;
    }
    current += ch;
    currentBytes += bytes;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export class FeishuApi {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;
  private readonly retryOnTimeout: boolean;
  private readonly imageCacheDir: string;
  private readonly sdkClient: FeishuSdkClient;
  private tokenCache?: TokenCache;
  private tokenInFlight?: Promise<string>;

  constructor(options: FeishuApiOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retryOnTimeout = options.retryOnTimeout ?? false;
    this.imageCacheDir = options.imageCacheDir ?? path.resolve(process.cwd(), '.data', 'feishu-images');
    this.sdkClient = options.sdkClient ?? new LarkClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: LarkDomain.Feishu,
      loggerLevel: LarkLoggerLevel.error,
    });
    fs.mkdirSync(this.imageCacheDir, { recursive: true });
    log.debug('FeishuApi 构造完成', {
      appId: this.appId,
      timeoutMs: this.timeoutMs,
      retryOnTimeout: this.retryOnTimeout,
      imageCacheDir: this.imageCacheDir,
    });
  }

  async sendText(
    target: string | FeishuReceiveTarget,
    content: string,
    options?: { replyToMessageId?: string; replyInThread?: boolean },
  ): Promise<string | undefined> {
    const receiveTarget = resolveFeishuReceiveTarget(target);
    const textContent = requireNonEmptyText(content, 'feishu send failed: text content is required');
    const markdownContent = extractAgentMarkdownCardBody(textContent) ?? textContent;
    const chunks = splitFeishuTextByUtf8Bytes(markdownContent);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      lastMessageId = await this.sendSingleMessage(receiveTarget, {
        msgType: 'interactive',
        content: buildMarkdownCardContent(chunk),
        replyToMessageId: options?.replyToMessageId,
        replyInThread: options?.replyInThread,
      });
    }
    return lastMessageId;
  }

  async sendMessage(target: string | FeishuReceiveTarget, message: FeishuOutgoingMessage): Promise<string | undefined> {
    const receiveTarget = resolveFeishuReceiveTarget(target);
    const msgType = message.msgType.trim().toLowerCase();
    if (!msgType) {
      throw new Error('feishu send failed: msgType is required');
    }

    if (msgType === 'text') {
      const textContent = requireNonEmptyText(
        extractTextContent(message.content),
        'feishu send failed: text content is required',
      );
      return this.sendText(receiveTarget, textContent, {
        replyToMessageId: message.replyToMessageId,
        replyInThread: message.replyInThread,
      });
    }

    return this.sendSingleMessage(receiveTarget, {
      ...message,
      msgType,
    });
  }

  async updateMessage(input: FeishuMessageUpdateInput): Promise<void>;
  async updateMessage(
    messageId: string,
    msgType: FeishuMessageUpdateInput['msgType'],
    content: Record<string, unknown> | string,
  ): Promise<void>;
  async updateMessage(
    inputOrMessageId: string | FeishuMessageUpdateInput,
    maybeMsgType?: FeishuMessageUpdateInput['msgType'],
    maybeContent?: Record<string, unknown> | string,
  ): Promise<void> {
    const { messageId, msgType, content } = normalizeMessageUpdateInput(inputOrMessageId, maybeMsgType, maybeContent);
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      throw new Error('feishu update failed: messageId is required');
    }
    const transportMessage = normalizeFeishuTransportMessage(msgType, content);
    const payload = await this.resolveOutgoingContentPayload(transportMessage.msgType, transportMessage.content);
    const response = await this.sdkClient.im.message.update({
      path: { message_id: normalizedMessageId },
      data: {
        msg_type: transportMessage.msgType,
        content: payload,
      },
    });
    if (response.code !== 0) {
      throw new Error(`feishu update failed: ${response.code ?? 'unknown'} ${response.msg ?? 'unknown'}`);
    }
  }

  async patchCardMessage(input: {
    messageId: string;
    content: Record<string, unknown> | string;
  }): Promise<void> {
    const normalizedMessageId = input.messageId.trim();
    if (!normalizedMessageId) {
      throw new Error('feishu patch failed: messageId is required');
    }
    const payload = await this.resolveOutgoingContentPayload('interactive', input.content);
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(normalizedMessageId)}`,
      {
        method: 'PATCH',
        headers: new Headers({
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        }),
        body: JSON.stringify({
          content: payload,
        }),
      },
    );
    const body = await response.json().catch(() => ({})) as {
      code?: number;
      msg?: string;
    };
    if (!response.ok || (Object.keys(body).length > 0 && body.code !== 0)) {
      if (response.status === 401 || response.status === 403) {
        this.tokenCache = undefined;
      }
      throw new Error(`feishu patch failed: ${response.status} ${body.code ?? 'unknown'} ${body.msg ?? 'unknown'}`);
    }
  }

  async recallMessage(messageId: string): Promise<void> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      throw new Error('feishu recall failed: messageId is required');
    }
    const token = await this.getTenantAccessToken();
    const response = await this.fetchWithTimeout(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(normalizedMessageId)}`,
      {
        method: 'DELETE',
        headers: new Headers({
          Authorization: `Bearer ${token}`,
        }),
      },
    );
    const body = await response.json().catch(() => ({})) as {
      code?: number;
      msg?: string;
    };
    if (!response.ok || (Object.keys(body).length > 0 && body.code !== 0)) {
      if (response.status === 401 || response.status === 403) {
        this.tokenCache = undefined;
      }
      throw new Error(`feishu recall failed: ${response.status} ${body.code ?? 'unknown'} ${body.msg ?? 'unknown'}`);
    }
  }

  async downloadImage(imageKey: string): Promise<string> {
    const key = imageKey.trim();
    if (!key) {
      throw new Error('feishu image download failed: imageKey is required');
    }
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const token = await this.getTenantAccessToken();
        const response = await this.fetchWithTimeout(
          `https://open.feishu.cn/open-apis/im/v1/images/${encodeURIComponent(key)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 401 || response.status === 403) {
            this.tokenCache = undefined;
          }
          throw new Error(`feishu image download failed: ${response.status} ${clipText(text, 200)}`);
        }
        return await writeFeishuBinaryToFile(this.imageCacheDir, key, response, 'image');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('feishu image download failed: unknown');
  }

  async downloadFile(fileKey: string): Promise<string> {
    const key = fileKey.trim();
    if (!key) {
      throw new Error('feishu file download failed: fileKey is required');
    }
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const token = await this.getTenantAccessToken();
        const response = await this.fetchWithTimeout(
          `https://open.feishu.cn/open-apis/im/v1/files/${encodeURIComponent(key)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 401 || response.status === 403) {
            this.tokenCache = undefined;
          }
          throw new Error(`feishu file download failed: ${response.status} ${clipText(text, 200)}`);
        }
        return await writeFeishuBinaryToFile(this.imageCacheDir, key, response, 'file');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('feishu file download failed: unknown');
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: 'image' | 'file' | ReadonlyArray<'image' | 'file'>;
  }): Promise<string> {
    const messageId = input.messageId.trim();
    const fileKey = input.fileKey.trim();
    if (!messageId || !fileKey) {
      throw new Error('feishu message resource download failed: messageId and fileKey are required');
    }
    const types = normalizeResourceTypes(input.type);
    let lastError: Error | undefined;
    for (const candidateType of types) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await this.sdkClient.im.messageResource.get({
            params: { type: candidateType },
            path: {
              message_id: messageId,
              file_key: fileKey,
            },
          });
          const contentType = resolveSdkHeadersContentType(response.headers);
          const ext = resolveGenericExtension(contentType);
          const filePath = path.join(
            this.imageCacheDir,
            `${Date.now()}-${candidateType}-${sanitizeKey(fileKey)}.${ext}`,
          );
          await response.writeFile(filePath);
          return filePath;
        } catch (error) {
          if (shouldTryNextResourceTypeFromError(error)) {
            lastError = toError(error);
            break;
          }
          lastError = toError(error);
        }
      }
    }
    throw lastError ?? new Error(`feishu message resource download failed: unsupported type ${types.join(',')}`);
  }

  private async sendSingleMessage(
    target: FeishuReceiveTarget,
    message: FeishuOutgoingMessage,
  ): Promise<string | undefined> {
    const transportMessage = normalizeFeishuTransportMessage(message.msgType, message.content);
    let lastError: Error | undefined;
    let lastMessageId: string | undefined;
    log.info('feishu send start', {
      msgType: transportMessage.msgType,
      receiveIdType: target.receiveIdType,
      receiveId: target.receiveId,
      hasReplyToMessageId: !!message.replyToMessageId,
      replyToMessageId: message.replyToMessageId ?? '(none)',
      replyInThread: message.replyInThread === true,
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const content = await this.resolveOutgoingContentPayload(transportMessage.msgType, transportMessage.content);
        log.debug('feishu send payload resolved', {
          attempt,
          msgType: transportMessage.msgType,
          contentPreview: clipText(content),
        });
        if (message.replyToMessageId) {
          try {
            const response = await this.sdkClient.im.message.reply({
              path: { message_id: message.replyToMessageId },
              data: {
                content,
                msg_type: transportMessage.msgType,
                reply_in_thread: message.replyInThread === true,
                uuid: randomUUID(),
              },
            });
            log.info('feishu reply response', {
              attempt,
              code: response.code ?? null,
              msg: response.msg ?? null,
              messageId: response.data?.message_id ?? null,
            });
            if (response.code === 0) {
              lastMessageId = response.data?.message_id;
              return lastMessageId;
            }
            lastError = new Error(`feishu send failed: reply ${response.code ?? 'unknown'} ${response.msg ?? 'unknown'}`);
          } catch (replyError) {
            lastError = toError(replyError);
            log.warn('feishu reply failed, fallback to create', {
              msgType: transportMessage.msgType,
              replyToMessageId: message.replyToMessageId,
              error: lastError.message,
            });
          }
        }
        const response = await this.sdkClient.im.message.create({
          params: {
            receive_id_type: target.receiveIdType,
          },
          data: {
            receive_id: target.receiveId,
            msg_type: transportMessage.msgType,
            content,
            uuid: randomUUID(),
          },
        });
        log.info('feishu create response', {
          attempt,
          code: response.code ?? null,
          msg: response.msg ?? null,
          messageId: response.data?.message_id ?? null,
          receiveIdType: target.receiveIdType,
          receiveId: target.receiveId,
        });
        if (response.code === 0) {
          lastMessageId = response.data?.message_id;
          return lastMessageId;
        }
        lastError = new Error(`feishu send failed: create ${response.code ?? 'unknown'} ${response.msg ?? 'unknown'}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log.warn('feishu send exception', {
          attempt,
          msgType: transportMessage.msgType,
          receiveIdType: target.receiveIdType,
          receiveId: target.receiveId,
          error: lastError.message,
          name: lastError.name,
        });
        if (isAbortError(lastError) && !this.retryOnTimeout) {
          throw lastError;
        }
      }

      if (attempt < 3) {
        await sleep(200 * attempt);
      }
    }

    log.error('feishu send exhausted retries', {
      msgType: transportMessage.msgType,
      receiveIdType: target.receiveIdType,
      receiveId: target.receiveId,
      replyToMessageId: message.replyToMessageId ?? '(none)',
      error: lastError?.message ?? 'unknown',
    });
    throw lastError ?? new Error('feishu send failed: unknown');
  }

  private async resolveOutgoingContentPayload(
    msgType: string,
    content: FeishuOutgoingMessage['content'],
  ): Promise<string> {
    if (typeof content === 'string') {
      if (msgType === 'text') {
        return JSON.stringify({ text: content });
      }
      if (msgType === 'post') {
        return JSON.stringify(buildSimplePostContent(content));
      }
      const trimmed = content.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return content;
      }
      return JSON.stringify(resolveSimpleContent(msgType, content));
    }
    const uploaded = await this.resolveUploadBackedContent(msgType, content);
    return JSON.stringify(normalizeStructuredOutgoingContent(msgType, uploaded));
  }

  private async resolveUploadBackedContent(
    msgType: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (msgType === 'image') {
      const localPath = firstString(content.local_image_path, content.local_file_path);
      if (localPath) {
        const imageKey = await this.uploadImageFromPath(localPath);
        return omitLocalPaths({
          ...content,
          image_key: imageKey,
        });
      }
      return content;
    }

    if (msgType === 'file' || msgType === 'audio' || msgType === 'media' || msgType === 'sticker') {
      const localPath = resolveFeishuLocalUploadPath(msgType, content);
      if (localPath) {
        const fileKey = await this.uploadFileFromPath(msgType, localPath, content);
        return omitLocalPaths({
          ...content,
          file_key: fileKey,
        });
      }
      return content;
    }

    return content;
  }

  private async uploadImageFromPath(localPath: string): Promise<string> {
    const normalizedPath = validateLocalPath(localPath);
    const response = await this.sdkClient.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(normalizedPath),
      },
    });
    const imageKey = response?.image_key;
    if (!imageKey) {
      throw new Error(`feishu image upload failed: missing image_key for ${normalizedPath}`);
    }
    return imageKey;
  }

  private async uploadFileFromPath(
    msgType: string,
    localPath: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const normalizedPath = validateLocalPath(localPath);
    const fileName = firstString(content.file_name) ?? path.basename(normalizedPath);
    const duration = toOptionalNumber(content.duration);
    const response = await this.sdkClient.im.file.create({
      data: {
        file_type: inferFeishuUploadFileType(msgType, normalizedPath, fileName),
        file_name: fileName,
        duration,
        file: fs.createReadStream(normalizedPath),
      },
    });
    const fileKey = response?.file_key;
    if (!fileKey) {
      throw new Error(`feishu file upload failed: missing file_key for ${normalizedPath}`);
    }
    return fileKey;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expiresAt) {
      return this.tokenCache.value;
    }

    if (this.tokenInFlight) {
      return this.tokenInFlight;
    }

    this.tokenInFlight = this.fetchTenantAccessToken();
    try {
      return await this.tokenInFlight;
    } finally {
      this.tokenInFlight = undefined;
    }
  }

  private async fetchTenantAccessToken(): Promise<string> {
    const now = Date.now();
    const response = await this.fetchWithTimeout(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
    );

    const body = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (!response.ok || body.code !== 0 || !body.tenant_access_token || !body.expire) {
      throw new Error(`feishu token failed: ${response.status} ${body.code ?? 'unknown'} ${body.msg ?? 'unknown'}`);
    }

    this.tokenCache = {
      value: body.tenant_access_token,
      expiresAt: now + Math.max(0, body.expire - 60) * 1000,
    };
    return this.tokenCache.value;
  }

  private async fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError';
}

function extractTextContent(content: FeishuOutgoingMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  const text = content.text;
  return typeof text === 'string' ? text : '';
}

function extractMarkdownTextContent(content: FeishuOutgoingMessage['content']): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  return firstString(content.content, content.text) ?? '';
}

function resolveFeishuReceiveTarget(target: string | FeishuReceiveTarget): FeishuReceiveTarget {
  if (typeof target === 'string') {
    const receiveId = target.trim();
    if (!receiveId) {
      throw new Error('feishu send failed: receive target is required');
    }
    return {
      receiveId,
      receiveIdType: 'open_id',
    };
  }

  const receiveId = target.receiveId.trim();
  if (!receiveId) {
    throw new Error('feishu send failed: receive target is required');
  }
  return {
    receiveId,
    receiveIdType: target.receiveIdType,
  };
}

function requireNonEmptyText(text: string, errorMessage: string): string {
  if (!text.trim()) {
    throw new Error(errorMessage);
  }
  return text;
}

function normalizeMessageUpdateInput(
  inputOrMessageId: string | FeishuMessageUpdateInput,
  maybeMsgType?: FeishuMessageUpdateInput['msgType'],
  maybeContent?: Record<string, unknown> | string,
): FeishuMessageUpdateInput {
  if (typeof inputOrMessageId === 'string') {
    if (!maybeMsgType) {
      throw new Error('feishu update failed: msgType is required');
    }
    if (!(typeof maybeContent === 'string' || (maybeContent && typeof maybeContent === 'object' && !Array.isArray(maybeContent)))) {
      throw new Error('feishu update failed: content is required');
    }
    return {
      messageId: inputOrMessageId,
      msgType: maybeMsgType,
      content: maybeContent,
    };
  }
  return inputOrMessageId;
}

function normalizeFeishuTransportMessage(
  msgType: string,
  content: FeishuOutgoingMessage['content'],
): {
  msgType: string;
  content: FeishuOutgoingMessage['content'];
} {
  if (msgType === 'markdown') {
    return {
      msgType: 'interactive',
      content: buildMarkdownCardContent(extractMarkdownTextContent(content) || '(empty markdown)'),
    };
  }
  if (msgType === 'post') {
    return {
      msgType: 'interactive',
      content: buildMarkdownCardContent(flattenFeishuPostContent(content)),
    };
  }
  return { msgType, content };
}

function resolveSimpleContent(msgType: string, value: string): Record<string, string> {
  if (msgType === 'image') {
    return { image_key: value };
  }
  if (msgType === 'file' || msgType === 'audio' || msgType === 'sticker') {
    return { file_key: value };
  }
  if (msgType === 'share_chat') {
    return { chat_id: value };
  }
  if (msgType === 'share_user') {
    return { user_id: value };
  }
  if (msgType === 'media') {
    return { file_key: value };
  }
  if (msgType === 'post') {
    return buildSimplePostContent(value) as unknown as Record<string, string>;
  }
  return { text: value };
}

function flattenFeishuPostContent(content: FeishuOutgoingMessage['content']): string {
  if (typeof content === 'string') {
    return content.trim() || '(empty post)';
  }
  const record = asRecord(content);
  if (!record) {
    return '(empty post)';
  }
  const locale = asRecord(record.zh_cn) ?? record;
  const parts: string[] = [];
  const title = firstString(locale.title);
  if (title) {
    parts.push(title);
  }
  const rows = Array.isArray(locale.content) ? locale.content : [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    const line = row
      .map((item) => flattenFeishuPostNode(asRecord(item)))
      .filter(Boolean)
      .join('')
      .trim();
    if (line) {
      parts.push(line);
    }
  }
  const fallbackText = firstString(locale.text, record.text);
  return parts.join('\n\n') || fallbackText || '(empty post)';
}

function flattenFeishuPostNode(node: Record<string, unknown> | undefined): string {
  if (!node) {
    return '';
  }
  const tag = firstString(node.tag)?.toLowerCase();
  if (tag === 'text' || tag === 'md') {
    return firstString(node.text) ?? '';
  }
  if (tag === 'a') {
    return firstString(node.text, node.href) ?? '';
  }
  if (tag === 'at') {
    const mention = firstString(node.user_name, node.user_id);
    return mention ? `@${mention}` : '';
  }
  return '';
}

function resolveFeishuLocalUploadPath(msgType: string, content: Record<string, unknown>): string | undefined {
  if (msgType === 'audio') {
    return firstString(content.local_audio_path, content.local_file_path);
  }
  if (msgType === 'media') {
    return firstString(content.local_media_path, content.local_file_path);
  }
  if (msgType === 'file') {
    return firstString(content.local_file_path, content.local_media_path, content.local_audio_path);
  }
  if (msgType === 'sticker') {
    return firstString(content.local_sticker_path, content.local_file_path);
  }
  return undefined;
}

function validateLocalPath(localPath: string): string {
  const normalizedPath = localPath.trim();
  if (!normalizedPath) {
    throw new Error('feishu upload failed: local path is required');
  }
  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`feishu upload failed: local path not found: ${normalizedPath}`);
  }
  return normalizedPath;
}

function omitLocalPaths(content: Record<string, unknown>): Record<string, unknown> {
  const next = { ...content };
  delete next.local_image_path;
  delete next.local_file_path;
  delete next.local_audio_path;
  delete next.local_media_path;
  delete next.local_sticker_path;
  return next;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inferFeishuUploadFileType(
  msgType: string,
  localPath: string,
  fileName: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(fileName || localPath).toLowerCase();
  if (msgType === 'audio' || ext === '.opus' || ext === '.ogg') {
    return 'opus';
  }
  if (msgType === 'media' || ext === '.mp4') {
    return 'mp4';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext === '.doc' || ext === '.docx') {
    return 'doc';
  }
  if (ext === '.xls' || ext === '.xlsx') {
    return 'xls';
  }
  if (ext === '.ppt' || ext === '.pptx') {
    return 'ppt';
  }
  return 'stream';
}

function buildSimplePostContent(text: string): Record<string, unknown> {
  return {
    zh_cn: {
      title: '',
      content: [[{ tag: 'text', text }]],
    },
  };
}

function buildMarkdownPostContent(text: string): Record<string, unknown> {
  return {
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text }]],
    },
  };
}

function buildMarkdownCardContent(markdownText: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: markdownText,
        },
      ],
    },
  };
}

export function buildFeishuTextCardContent(text: string): Record<string, unknown> {
  return buildMarkdownCardContent(extractAgentMarkdownCardBody(text) ?? text);
}

function extractAgentMarkdownCardBody(text: string): string | undefined {
  const match = text.match(/^(.+?) ·\n([\s\S]+)$/);
  if (!match) {
    return undefined;
  }
  const headerTitle = match[1]?.trim();
  const body = match[2]?.trim();
  if (!headerTitle || !body) {
    return undefined;
  }
  return body;
}

function extractFeishuNoteText(elements: unknown[]): string {
  return elements
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => firstString(item.content, item.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function normalizeFeishuCardElement(value: unknown): Array<Record<string, unknown>> {
  const element = asRecord(value);
  if (!element) {
    return [];
  }
  if (element.tag === 'note') {
    const parts = Array.isArray(element.elements) ? element.elements : [];
    const content = extractFeishuNoteText(parts);
    if (!content) {
      return [];
    }
    return [{
      tag: 'markdown',
      content,
    }];
  }
  if (element.tag === 'action') {
    const actions = Array.isArray(element.actions) ? element.actions : [];
    const columns = actions
      .map((action) => asRecord(action))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((action) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        elements: [normalizeFeishuButtonElement(action)],
      }));
    if (columns.length === 0) {
      return [];
    }
    return [{
      tag: 'column_set',
      flex_mode: 'flow',
      columns,
    }];
  }
  const next = { ...element };
  if (element.tag === 'form' && Array.isArray(element.elements)) {
    next.elements = normalizeFeishuCardElements(element.elements);
  } else if (element.tag === 'column_set' && Array.isArray(element.columns)) {
    next.columns = element.columns
      .map((column) => asRecord(column))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((column) => {
        if (!Array.isArray(column.elements)) {
          return column;
        }
        return {
          ...column,
          elements: normalizeFeishuCardElements(column.elements),
        };
      });
  } else if (element.tag === 'column' && Array.isArray(element.elements)) {
    next.elements = normalizeFeishuCardElements(element.elements);
  }
  return [next];
}

function normalizeFeishuCardElements(elements: unknown[]): Array<Record<string, unknown>> {
  return elements.flatMap((item) => normalizeFeishuCardElement(item));
}

function normalizeFeishuButtonElement(button: Record<string, unknown>): Record<string, unknown> {
  return button.tag === 'button'
    ? { ...button }
    : { ...button, tag: 'button' };
}

function normalizeFeishuInteractiveCardPayload(content: Record<string, unknown>): Record<string, unknown> {
  const body = asRecord(content.body);
  if (!body || !Array.isArray(body.elements)) {
    return content;
  }
  return {
    ...content,
    body: {
      ...body,
      elements: normalizeFeishuCardElements(body.elements),
    },
  };
}

function normalizeStructuredOutgoingContent(msgType: string, content: Record<string, unknown>): Record<string, unknown> {
  if (msgType === 'interactive') {
    const templateId = firstString(content.template_id);
    if (templateId) {
      return {
        type: 'template',
        data: {
          template_id: templateId,
          template_variable: asRecord(content.template_variable) ?? {},
        },
      };
    }
    const body = asRecord(content.body);
    const legacyElements = Array.isArray(content.elements) ? content.elements : undefined;
    if (!content.schema && !body && legacyElements) {
      const normalized: Record<string, unknown> = {
        schema: '2.0',
        body: {
          elements: legacyElements,
        },
      };
      const config = asRecord(content.config);
      const header = asRecord(content.header);
      const cardLink = asRecord(content.card_link);
      if (config) {
        normalized.config = config;
      }
      if (header) {
        normalized.header = header;
      }
      if (cardLink) {
        normalized.card_link = cardLink;
      }
      return normalizeFeishuInteractiveCardPayload(normalized);
    }
    return normalizeFeishuInteractiveCardPayload(content);
  }
  if (msgType === 'post') {
    const text = firstString(content.text);
    if (text) {
      return buildSimplePostContent(text);
    }
  }
  return content;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeResourceTypes(type: 'image' | 'file' | ReadonlyArray<'image' | 'file'>): Array<'image' | 'file'> {
  const list = Array.isArray(type) ? type : [type];
  const seen = new Set<'image' | 'file'>();
  for (const item of list) {
    seen.add(item);
  }
  if (seen.size === 0) {
    return ['file'];
  }
  return [...seen];
}

function extractOpenApiCode(bodyText: string): number | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown };
    if (typeof parsed.code === 'number') {
      return parsed.code;
    }
    if (typeof parsed.code === 'string') {
      const num = Number(parsed.code);
      return Number.isFinite(num) ? num : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function shouldTryNextResourceTypeFromError(error: unknown): boolean {
  const status = extractErrorStatus(error);
  if (status !== 400) {
    return false;
  }
  const bodyText = extractErrorBodyText(error);
  return extractOpenApiCode(bodyText) === 234001;
}

function extractErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const asRecord = error as Record<string, unknown>;
  const directStatus = asRecord.status;
  if (typeof directStatus === 'number') {
    return directStatus;
  }
  const response = asRecord.response;
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  const responseStatus = (response as Record<string, unknown>).status;
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function extractErrorBodyText(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const asRecord = error as Record<string, unknown>;
  const response = asRecord.response;
  if (response && typeof response === 'object') {
    const data = (response as Record<string, unknown>).data;
    if (typeof data === 'string') {
      return data;
    }
    if (data && typeof data === 'object') {
      return JSON.stringify(data);
    }
  }
  const message = asRecord.message;
  return typeof message === 'string' ? message : '';
}

function resolveSdkHeadersContentType(headers: unknown): string {
  if (!headers || typeof headers !== 'object') {
    return 'application/octet-stream';
  }
  const record = headers as Record<string, unknown>;
  const direct =
    record['content-type']
    ?? record['Content-Type']
    ?? record['contentType']
    ?? record['ContentType'];
  if (typeof direct === 'string') {
    return direct;
  }
  if (Array.isArray(direct) && typeof direct[0] === 'string') {
    return direct[0];
  }
  return 'application/octet-stream';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'image';
}

function clipText(text: string, maxLength = 200): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function resolveImageExtension(contentType: string): string {
  if (contentType.includes('image/png')) {
    return 'png';
  }
  if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) {
    return 'jpg';
  }
  if (contentType.includes('image/webp')) {
    return 'webp';
  }
  if (contentType.includes('image/gif')) {
    return 'gif';
  }
  return 'bin';
}

function resolveGenericExtension(contentType: string): string {
  if (contentType.includes('image/')) {
    return resolveImageExtension(contentType);
  }
  if (contentType.includes('audio/mpeg')) {
    return 'mp3';
  }
  if (contentType.includes('audio/wav')) {
    return 'wav';
  }
  if (contentType.includes('audio/ogg')) {
    return 'ogg';
  }
  if (contentType.includes('video/mp4')) {
    return 'mp4';
  }
  if (contentType.includes('application/pdf')) {
    return 'pdf';
  }
  if (contentType.includes('text/plain')) {
    return 'txt';
  }
  return 'bin';
}

async function writeFeishuBinaryToFile(
  dir: string,
  key: string,
  response: Response,
  fallbackPrefix: string,
): Promise<string> {
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const ext = resolveGenericExtension(contentType);
  const bytes = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(dir, `${Date.now()}-${fallbackPrefix}-${sanitizeKey(key)}.${ext}`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}
