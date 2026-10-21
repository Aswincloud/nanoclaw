import { describe, expect, it } from 'vitest';

import { createSlackBotAllowlistPolicy, parseSlackBotAllowlist } from './slack-bot-allowlist.js';

const ctx = (platformId: string, botId: string) => ({
  instanceKey: 'slack',
  platformId,
  threadId: null,
  botId,
  message: {} as never,
});

describe('slack bot allowlist', () => {
  it('parses channel:bot pairs and skips malformed entries', () => {
    expect([...parseSlackBotAllowlist(' C1:U1, bad ,C2:U2,')]).toEqual(['C1:U1', 'C2:U2']);
    expect(parseSlackBotAllowlist(undefined).size).toBe(0);
  });

  it('admits only a listed bot in its listed channel', () => {
    const policy = createSlackBotAllowlistPolicy(parseSlackBotAllowlist('C1:U1'));
    expect(policy.decideBotInbound(ctx('slack:C1', 'U1')).action).toBe('admit');
    expect(policy.decideBotInbound(ctx('slack:C2', 'U1')).action).toBe('drop');
    expect(policy.decideBotInbound(ctx('slack:C1', 'U2')).action).toBe('drop');
  });
});
