# selective-memory-brain

A portable, vendor-neutral AI memory — an MCP server that gives any AI
(Claude, ChatGPT, Gemini, ...) human-style selective recall over a brain
**you own**: on your device (SQLite), in a private GitHub repo, or in Supabase.

Memories sleep in cold storage until a cue in the conversation wakes them.
The brain owns storage, time, decay, and provenance; the connected AI is
rented cognition — extraction and dreaming are performed by whichever model
is plugged in. No API keys inside the brain.

## Quick start

```bash
npm install
cp brain.config.example.json brain.config.json   # edit: pick backend + brain repo
cp .env.example .env                             # add BRAIN_GITHUB_TOKEN
npx tsx server.ts
```

Secrets are referenced in config as `${VAR}` and resolved from the environment.

## Backends

| backend  | where the brain lives | best for |
|----------|----------------------|----------|
| sqlite   | one file on the device, local embeddings | privacy-max, Android/laptop |
| github   | private repo: one JSON per memory; git history = immutable provenance | free, versioned, human-readable |
| supabase | Postgres + pgvector (see schema in the selective-memory skill) | always-on, large corpus |

## Topology

`brain.config.json` — define brains, bind actors. Default: one shared brain;
every memory is stamped with the writing actor (cross-platform corroboration
counts as independent witnesses). Per-platform isolation = change one binding.

## Connecting AI platforms

Mobile AI apps connect from their cloud, so the server needs a URL:

```bash
cloudflared tunnel --url http://localhost:3111   # or: tailscale funnel 3111
```

Then: Claude → Settings → Connectors → add custom connector (URL).
ChatGPT → Settings → Connectors (MCP). The tool descriptions teach the
connected AI the protocol: wake → sweep per message → write at end → sleep.

## Birth test

1. `brain_write_commit` one memory with a distinctive cue (e.g. "salt water taffy")
2. `brain_sweep` a message containing the cue → must fire
3. `brain_sweep` an unrelated message → must stay silent

The first commit to your brain repo is its birth certificate.
