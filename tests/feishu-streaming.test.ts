import { describe, expect, it, vi } from 'vitest';

import { createFeishuStreamingTextSender } from '../src/services/feishu-streaming.js';

describe('createFeishuStreamingTextSender', () => {
  it('sends each changed feishu stream snapshot as a separate card', async () => {
    const sendText = vi.fn(async () => 'om_stream_1');
    const patchCardMessage = vi.fn(async () => undefined);
    const sendStreamingText = createFeishuStreamingTextSender({
      sendText,
      patchCardMessage,
    });

    await sendStreamingText('feishu', 'ou_1', 'stream_1', '默认助手 ·\n第一段', false);
    await sendStreamingText('feishu', 'ou_1', 'stream_1', '默认助手 ·\n第一段\n第二段', false);
    await sendStreamingText('feishu', 'ou_1', 'stream_1', '默认助手 ·\n第一段\n第二段', true);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenNthCalledWith(1, 'feishu', 'ou_1', '默认助手 ·\n第一段');
    expect(sendText).toHaveBeenNthCalledWith(2, 'feishu', 'ou_1', '默认助手 ·\n第一段\n第二段');
    expect(patchCardMessage).not.toHaveBeenCalled();
  });

  it('dedupes exact repeated feishu stream snapshots even when no message id is returned', async () => {
    const sendText = vi.fn(async () => undefined);
    const patchCardMessage = vi.fn(async () => undefined);
    const sendStreamingText = createFeishuStreamingTextSender({
      sendText,
      patchCardMessage,
    });

    await sendStreamingText('feishu', 'ou_1', 'stream_1', '第一段', false);
    await sendStreamingText('feishu', 'ou_1', 'stream_1', '第一段', false);
    await sendStreamingText('feishu', 'ou_1', 'stream_1', '第二段', false);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenNthCalledWith(1, 'feishu', 'ou_1', '第一段');
    expect(sendText).toHaveBeenNthCalledWith(2, 'feishu', 'ou_1', '第二段');
    expect(patchCardMessage).not.toHaveBeenCalled();
  });

  it('does not patch large feishu stream snapshots', async () => {
    const sendText = vi.fn(async () => 'om_stream_1');
    const patchCardMessage = vi.fn(async () => undefined);
    const sendStreamingText = createFeishuStreamingTextSender({
      sendText,
      patchCardMessage,
      maxPatchContentBytes: 20,
    });

    await sendStreamingText('feishu', 'ou_1', 'stream_1', 'short', false);
    await sendStreamingText('feishu', 'ou_1', 'stream_1', '默认助手 ·\n这是一段很长很长的内容', false);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(patchCardMessage).not.toHaveBeenCalled();
  });
});
