// Values mirror the official `muse` CLI launcher 1:1. When upstream changes,
// update here; nothing else in the codebase should hard-code these strings.
//
// Source of truth: the `muse` launcher script (auth_url, client_id,
// authorization_endpoint, token_endpoint, device_code_grant).
//
// NOTE: client_id is a public constant shipped inside the official CLI, not a
// secret.

export const USER_AGENT = "opencode-muse/0.1.0"

export const AUTH_HOST = "https://auth.meta.com"
export const OAUTH_DEVICE_AUTH_URL = `${AUTH_HOST}/oidc/device/authorization/`
export const OAUTH_TOKEN_URL = `${AUTH_HOST}/oidc/device/token/`
export const OAUTH_CLIENT_ID = "1031625952748946"
export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

export const API_HOST = "https://api.meta.ai"
export const API_BASE_URL = `${API_HOST}/v1`
export const MINT_URL = `${API_HOST}/muse-code/key`
export const MODELS_URL = `${API_HOST}/muse-code/models`

export const SUBSCRIBE_URL = "https://accountscenter.meta.com/muse_code/"
export const ACCOUNT_URL = "https://accountscenter.meta.com/muse_code/"

// Provider id the user selects in opencode (`muse/<model>`). Intentionally
// NOT "meta": that id is already used for Meta API-key auth, and sharing it
// would surface two auth methods under one login entry and route users onto
// the wrong integration path.
export const PLUGIN_ID = "opencode.provider.muse"
export const OAUTH_METHOD_ID = "muse-code"

export const PROVIDER_ID = "muse"
export const PROVIDER_NAME = "Muse"
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

export const DEFAULT_MODEL_ID = "muse-spark-1.3-contributor"

// Wire values accepted by POST /v1/chat/completions `reasoning_effort`
// (probed against the live API; unknown values 400).
export const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

// Minting is idempotent (same api_key comes back), so the re-mint checkpoint
// is generous: a daily mint plus an immediate re-mint on any 401. Refresh a
// bit before the checkpoint so we never race it.
export const MINT_TTL_MS = 24 * 60 * 60 * 1000
export const REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000
