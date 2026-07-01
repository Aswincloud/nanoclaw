// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

// Custom Anthropic-compatible endpoint (LiteLLM proxy) — activates providers/claude.ts
// which reads ANTHROPIC_BASE_URL from .env and passes it into the container env.
import './claude.js';
