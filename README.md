# opencode-muse

Use your **Muse Code subscription** in [OpenCode](https://opencode.ai) — OAuth device
flow, exactly like the `muse` CLI. No API keys to paste.

## How it works

The `muse` CLI authenticates in three steps, and this plugin mirrors each one:

1. **Device flow** against `https://auth.meta.com` (same client ID and endpoints as
   `muse login`) → short `dca:` OAuth token.
2. **Mint** an API key via `POST https://api.meta.ai/muse-code/key` with that token.
3. **Chat** against the OpenAI-compatible `https://api.meta.ai/v1/chat/completions`
   with the minted key.

The plugin registers a `muse` provider plus the account's live model inventory
(limits, image support, reasoning tiers), keeps the minted key fresh, and maps
opencode model variants (`#minimal` … `#max`) to the API's `reasoning_effort`.

If you already ran `muse login`, opencode reuses that login (read-only) and skips
the browser approval entirely.

## Requirements

- OpenCode v2 (`opencode --version` shows `2.x`)
- A Muse Code subscription (or a Meta account eligible for one)

## Install

```sh
git clone https://github.com/danzilberdan/opencode-muse.git
cd opencode-muse
npm install
npm run build
cp dist/muse.js ~/.config/opencode/plugins/muse.js
opencode reload
```

No config changes are needed: the provider, models, and login method are all
contributed by the plugin.

## Log in

```sh
opencode auth login
```

Choose **muse**, then **Muse Code (device flow)**:

- If `muse login` already succeeded on this machine, the login completes
  immediately with no browser step.
- Otherwise, open the shown URL and approve the shown code. The CLI continues
  automatically once approved.

Non-interactive equivalent:

```sh
opencode auth login muse --method muse-code
```

On success the plugin prints your subscription tier and current usage window.

## Use

```sh
opencode run --model muse/muse-spark-1.3-contributor "Explain this repo"
```

Available models come from your account (currently `muse-spark-1.3-contributor`,
`muse-spark-1.3`, `muse-spark-1.2-contributor`, `muse-spark-1.2`) with reasoning
variants:

```sh
opencode run --model muse/muse-spark-1.3-contributor#minimal "Quick question"
opencode run --model muse/muse-spark-1.3-contributor#max "Think hard about this"
```

Valid tiers: `minimal`, `low`, `medium`, `high` (default), `xhigh`, `max`.

## Troubleshooting

- **`muse: not logged in`** — run `opencode auth login` (or `muse login`) again.
- **Login says the saved login is no longer valid** — the Meta-side grant was
  revoked or expired; run `opencode auth login` again.
- **Subscription action required** — the account needs a subscription or payment
  method; follow the printed link
  (`https://accountscenter.meta.com/muse_code/`), then log in again.
- **A request fails once with a 401** — the plugin re-mints and retries once
  automatically; if it persists, re-run the login.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test
npm run build       # dist/muse.js single-file bundle for local installs
```

Layout:

- `src/index.ts` — v2 plugin definition (provider/integration transforms, session hooks)
- `src/oauth.ts` — device flow, key minting, model discovery, effort mapping
- `src/models.ts` — discovery → opencode model mapping, credential helpers
- `src/muse-store.ts` — read-only reuse of an existing `muse` CLI login
- `src/constants.ts` — endpoints and pinned values mirroring the `muse` launcher
- `test/` — unit tests (OAuth flows with stubbed fetch, mapping logic)

The `client_id` in `src/constants.ts` is a public constant shipped inside the
official `muse` launcher, not a secret.

## License

MIT
