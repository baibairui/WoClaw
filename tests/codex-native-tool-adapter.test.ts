import { describe, expect, it, vi } from 'vitest';

import {
  createGatewayNativeToolHandler,
  formatBrowserAutomationResponse,
} from '../src/services/codex-native-tool-adapter.js';

describe('createGatewayNativeToolHandler', () => {
  it('wraps gateway browser execution in the official dynamic tool response format', async () => {
    const execute = vi.fn(async () => ({
      text: 'Page title\n- button "Submit" [ref=e1]',
      data: {
        page: 'https://example.test',
        local_image_path: '/tmp/gateway-browser.png',
      },
    }));
    const handler = createGatewayNativeToolHandler({
      browserAutomation: { execute },
    });

    const response = await handler({
      id: 7,
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_1',
        namespace: 'gateway-browser',
        tool: 'snapshot',
        arguments: {},
      },
    });

    expect(execute).toHaveBeenCalledWith('snapshot', {});
    expect(response).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: expect.stringContaining('Page title'),
        },
        {
          type: 'inputImage',
          imageUrl: 'file:///tmp/gateway-browser.png',
        },
      ],
      success: true,
    });
  });

  it('supports native tool calls that pass command and args in arguments', async () => {
    const execute = vi.fn(async () => ({
      text: 'OK',
    }));
    const handler = createGatewayNativeToolHandler({
      browserAutomation: { execute },
    });

    const response = await handler({
      id: 'browser-call',
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_2',
        namespace: 'browser-use',
        tool: 'run',
        arguments: {
          command: 'open',
          args: {
            url: 'https://example.test',
          },
        },
      },
    });

    expect(execute).toHaveBeenCalledWith('navigate', { url: 'https://example.test' });
    expect(response).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'OK',
        },
      ],
      success: true,
    });
  });

  it('returns a failed official response for unsupported native tools', async () => {
    const handler = createGatewayNativeToolHandler({});

    const response = await handler({
      id: 9,
      method: 'item/tool/call',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_3',
        namespace: 'unknown',
        tool: 'doThing',
        arguments: {},
      },
    });

    expect(response).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'Unsupported native tool call: unknown.doThing.',
        },
      ],
      success: false,
    });
  });
});

describe('formatBrowserAutomationResponse', () => {
  it('keeps data in text content and only adds image items for image paths', () => {
    const response = formatBrowserAutomationResponse({
      text: 'recording saved',
      data: {
        outputPath: '/tmp/demo.mp4',
        frames: 3,
      },
    });

    expect(response.contentItems).toHaveLength(1);
    expect(response.contentItems[0]).toEqual({
      type: 'inputText',
      text: expect.stringContaining('"frames": 3'),
    });
    expect(response.success).toBe(true);
  });
});
