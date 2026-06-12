import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserAutomationResult } from './browser-service.js';
import type {
  CodexDynamicToolCallResponse,
  CodexServerRequest,
  CodexServerRequestHandler,
} from './codex-app-server-client.js';

interface BrowserAutomationBackend {
  execute(command: string, args: Record<string, unknown>): Promise<BrowserAutomationResult>;
}

export interface GatewayNativeToolHandlerOptions {
  browserAutomation?: BrowserAutomationBackend;
}

interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export function createGatewayNativeToolHandler(
  options: GatewayNativeToolHandlerOptions,
): CodexServerRequestHandler {
  return async (request) => {
    if (request.method !== 'item/tool/call') {
      return undefined;
    }

    const params = parseDynamicToolCallParams(request);
    if (!params) {
      return formatNativeToolErrorResponse('Invalid native tool call payload.');
    }

    if (isBrowserToolCall(params)) {
      if (!options.browserAutomation) {
        return formatNativeToolErrorResponse('Gateway browser native tool is not enabled.');
      }
      try {
        const { command, args } = resolveBrowserCommand(params);
        const result = await options.browserAutomation.execute(command, args);
        return formatBrowserAutomationResponse(result);
      } catch (error) {
        return formatNativeToolErrorResponse(error instanceof Error ? error.message : String(error));
      }
    }

    return formatNativeToolErrorResponse(`Unsupported native tool call: ${describeDynamicToolCall(params)}.`);
  };
}

export function formatBrowserAutomationResponse(
  result: BrowserAutomationResult,
): CodexDynamicToolCallResponse {
  const contentItems: CodexDynamicToolCallResponse['contentItems'] = [];
  const text = formatBrowserAutomationText(result);
  if (text) {
    contentItems.push({
      type: 'inputText',
      text,
    });
  }

  const imageUrl = findImageUrl(result.data);
  if (imageUrl) {
    contentItems.push({
      type: 'inputImage',
      imageUrl,
    });
  }

  if (contentItems.length === 0) {
    contentItems.push({
      type: 'inputText',
      text: 'OK',
    });
  }

  return {
    contentItems,
    success: true,
  };
}

export function formatNativeToolErrorResponse(message: string): CodexDynamicToolCallResponse {
  return {
    contentItems: [
      {
        type: 'inputText',
        text: message || 'Native tool call failed.',
      },
    ],
    success: false,
  };
}

function parseDynamicToolCallParams(request: CodexServerRequest): DynamicToolCallParams | undefined {
  const params = request.params;
  if (!params || typeof params !== 'object') {
    return undefined;
  }
  const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
  const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
  const callId = typeof params.callId === 'string' ? params.callId : undefined;
  const namespace = typeof params.namespace === 'string' || params.namespace === null ? params.namespace : null;
  const tool = typeof params.tool === 'string' ? params.tool : undefined;
  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: params.arguments,
  };
}

function isBrowserToolCall(params: DynamicToolCallParams): boolean {
  const namespace = normalizeToolToken(params.namespace ?? '');
  const tool = normalizeToolToken(params.tool);
  return namespace.includes('browser') || tool.startsWith('gateway-browser.') || tool.startsWith('browser.');
}

function resolveBrowserCommand(params: DynamicToolCallParams): {
  command: string;
  args: Record<string, unknown>;
} {
  const args = asRecord(params.arguments);
  const explicitCommand = typeof args.command === 'string' ? normalizeBrowserCommand(args.command) : undefined;
  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: asOptionalRecord(args.args) ?? omitKeys(args, ['command', 'args']),
    };
  }

  return {
    command: normalizeBrowserCommand(lastToolSegment(params.tool)),
    args,
  };
}

function normalizeBrowserCommand(command: string): string {
  const normalized = command.trim().replaceAll('_', '-').toLowerCase();
  const aliases: Record<string, string> = {
    back: 'navigate-back',
    goback: 'navigate-back',
    'go-back': 'navigate-back',
    navigateback: 'navigate-back',
    open: 'navigate',
    press: 'press-key',
    select: 'select-option',
    upload: 'file-upload',
  };
  return aliases[normalized] ?? normalized;
}

function lastToolSegment(tool: string): string {
  const normalized = tool
    .trim()
    .replaceAll('/', '.')
    .replaceAll(':', '.');
  const segments = normalized.split('.').filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function formatBrowserAutomationText(result: BrowserAutomationResult): string {
  const parts = [result.text.trim()].filter(Boolean);
  if (result.data && Object.keys(result.data).length > 0) {
    const dataText = clipText(JSON.stringify(result.data, null, 2), 12_000);
    parts.push(`Data:\n${dataText}`);
  }
  return parts.join('\n\n');
}

function findImageUrl(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const candidates = [
    data.localImagePath,
    data.local_image_path,
    data.path,
    data.outputPath,
  ];
  const imagePath = candidates.find((value): value is string => typeof value === 'string' && isImagePath(value));
  if (!imagePath) {
    return undefined;
  }
  if (/^https?:\/\//i.test(imagePath) || imagePath.startsWith('file://')) {
    return imagePath;
  }
  return pathToFileURL(path.resolve(imagePath)).href;
}

function isImagePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(filePath.trim());
}

function asRecord(value: unknown): Record<string, unknown> {
  return asOptionalRecord(value) ?? {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function omitKeys(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function normalizeToolToken(value: string): string {
  return value.trim().replaceAll('_', '-').replaceAll(':', '.').replaceAll('/', '.').toLowerCase();
}

function describeDynamicToolCall(params: DynamicToolCallParams): string {
  return [params.namespace, params.tool].filter(Boolean).join('.') || params.tool;
}

function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}
