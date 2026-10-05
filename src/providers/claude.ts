/**
 * Host-side container config for the `claude` provider.
 *
 * 1. CLAUDE_CODE_AUTO_COMPACT_WINDOW (upstream): the agent-runner reads it from
 *    the container env, which the host builds from scratch. Pass the operator's
 *    value through (service env, else `.env`, which the host does not load into
 *    process.env).
 *
 * 2. Custom Anthropic-compatible endpoint (fork): when ANTHROPIC_BASE_URL is set
 *    in `.env` (our local LiteLLM rewrite proxy), pass it into the container with
 *    a placeholder auth token — the proxy injects the real credential. When the
 *    endpoint is on the docker bridge, NO_PROXY bypasses the gateway's
 *    HTTPS_PROXY for that hop so the SDK talks to the proxy directly.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const COMPACT_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

registerProviderContainerConfig('claude', (ctx) => {
  const dotenv = readEnvFile([COMPACT_KEY, 'ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};

  const compact = ctx.hostEnv[COMPACT_KEY]?.trim() || dotenv[COMPACT_KEY]?.trim();
  if (compact) {
    if (/^[1-9]\d*$/.test(compact)) {
      env[COMPACT_KEY] = compact;
    } else {
      log.warn(`Ignoring ${COMPACT_KEY}: expected a positive integer token count`, { value: compact });
    }
  }

  const baseUrl = dotenv.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
    if (baseUrl.includes('host.docker.internal')) {
      env.NO_PROXY = 'host.docker.internal,localhost,127.0.0.1';
      env.no_proxy = 'host.docker.internal,localhost,127.0.0.1';
    }
  }

  return Object.keys(env).length ? { env } : {};
});
