/**
 * Fork-local admission policy for the Slack bot-inbound guard.
 *
 * The guard (slack-a2a-guard.ts) drops every bot-authored message unless a
 * policy admits it. Our status/alert bots (CI failure alerts, review requests)
 * post into the agent's channel and must reach it, so this policy admits
 * exactly the `<channel>:<bot>` pairs listed in `.env`:
 *
 *   SLACK_BOT_ALLOWLIST=C0ANU3G28KA:U0BAK5EH0F4,C0XXXXXXX:U0YYYYYYY
 *
 * Everything else bot-authored stays dropped. The sender id is left as-is
 * (`slack:<bot>`), so the messaging group's member/unknown-sender gate still
 * applies downstream — admission here only gets the message past the guard.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { setBotInboundPolicy, type SlackBotInboundPolicy } from './slack-a2a-guard.js';

export function parseSlackBotAllowlist(raw: string | undefined): Set<string> {
  const pairs = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const [channel, bot] = entry.trim().split(':');
    if (channel && bot) pairs.add(`${channel}:${bot}`);
    else if (entry.trim()) log.warn('Ignoring malformed SLACK_BOT_ALLOWLIST entry', { entry });
  }
  return pairs;
}

export function createSlackBotAllowlistPolicy(pairs: Set<string>): SlackBotInboundPolicy {
  return {
    decideBotInbound({ platformId, botId }) {
      const channel = platformId.replace(/^slack:/, '');
      return pairs.has(`${channel}:${botId}`)
        ? { action: 'admit' }
        : { action: 'drop', reason: 'not in SLACK_BOT_ALLOWLIST' };
    },
  };
}

const allowlist = parseSlackBotAllowlist(readEnvFile(['SLACK_BOT_ALLOWLIST']).SLACK_BOT_ALLOWLIST);
if (allowlist.size > 0) {
  setBotInboundPolicy(createSlackBotAllowlistPolicy(allowlist));
  log.info('Slack bot allowlist installed', { pairs: [...allowlist] });
}
