type Channel = 'wecom' | 'feishu' | 'weixin';

interface FeishuStreamingTextSenderDeps {
  sendText(channel: Channel, userId: string, content: string): Promise<string | undefined>;
  patchCardMessage(input: {
    messageId: string;
    content: Record<string, unknown> | string;
  }): Promise<void>;
  maxPatchContentBytes?: number;
  onPatchError?: (error: Error, context: { userId: string; streamId: string; messageId: string }) => void;
}

interface FeishuStreamState {
  lastContent: string;
}

export function createFeishuStreamingTextSender(deps: FeishuStreamingTextSenderDeps) {
  const streams = new Map<string, FeishuStreamState>();

  return async function sendStreamingText(
    channel: Channel,
    userId: string,
    streamId: string,
    content: string,
    done: boolean,
  ): Promise<void> {
    if (channel !== 'feishu') {
      await deps.sendText(channel, userId, content);
      return;
    }

    const key = `${userId}:${streamId}`;
    const existing = streams.get(key);
    if (existing?.lastContent !== content) {
      await deps.sendText(channel, userId, content);
      streams.set(key, { lastContent: content });
    }

    if (done) {
      streams.delete(key);
    }
  };
}
