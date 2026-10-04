import {
  MINT_URL,
  MODELS_URL,
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTH_URL,
  OAUTH_DEVICE_GRANT,
  OAUTH_TOKEN_URL,
  REASONING_EFFORTS,
  USER_AGENT,
} from "./constants.ts"

export type DeviceAuth = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export type TokenResponse = {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export type SubsUsage = {
  window?: { used_percent?: number; window_duration_mins?: number; resets_at?: number }
  weekly?: { used_percent?: number; resets_at?: number }
  tier?: string
}

export type MintResponse = {
  api_key: string
  base_url: string
  user_full_name?: string
  user_email?: string
  has_payment_method?: boolean
  require_payment?: boolean
  is_subs_active?: boolean
  can_subscribe?: boolean
  show_subs_upsell?: boolean
  action_url?: string | null
  subs_tier_id?: string
  subs_tier_name?: string
  is_subs_upgrade_available?: boolean
  subs_usage?: SubsUsage
}

export type MuseModelMeta = {
  name: string
  family?: string
  release_date?: string
  is_hidden?: boolean
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  options?: Record<string, unknown>
  description?: string | null
  variants?: Record<string, Record<string, unknown>>
}

export type MuseModelInfo = {
  id: string
  metadata?: { "muse-code"?: MuseModelMeta }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const REQUEST_TIMEOUT_MS = 60_000

export type OAuthError = Error & { code?: string; status?: number }

function oauthError(message: string, code?: unknown, status?: number): OAuthError {
  const err = new Error(message) as OAuthError
  if (typeof code === "string") err.code = code
  if (status !== undefined) err.status = status
  return err
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

async function readJson(res: Response, url: string): Promise<any> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw oauthError(
      `muse oauth: non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`,
      undefined,
      res.status,
    )
  }
}

function throwForStatus(json: any, url: string, status: number): never {
  const code = json?.error ?? json?.title ?? status
  const detail = json?.error_description ?? json?.Detail ?? json?.error?.message ?? `HTTP ${status}`
  throw oauthError(`muse oauth ${code}: ${detail} (${url})`, json?.error, status)
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const json = await readJson(res, url)
  if (!res.ok) throwForStatus(json, url, res.status)
  return json as T
}

async function withRetries<T>(label: string, work: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await work()
    } catch (err) {
      const status = (err as { status?: number }).status
      const retryable = status === undefined || RETRYABLE_STATUSES.has(status)
      lastError = err
      if (!retryable || attempt === MAX_RETRIES - 1) throw err
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`muse ${label} failed`)
}

/**
 * Starts the RFC 8628 device flow, exactly like `muse login`: only
 * `client_id` is sent, no scope.
 */
export async function startDeviceAuth(): Promise<DeviceAuth> {
  const json = await postForm<Record<string, unknown>>(OAUTH_DEVICE_AUTH_URL, {
    client_id: OAUTH_CLIENT_ID,
  })
  const device_code = json.device_code
  const user_code = json.user_code
  const verification_uri = json.verification_uri
  if (typeof device_code !== "string" || !device_code || typeof user_code !== "string" || !user_code) {
    throw oauthError("muse oauth: device authorization response missing device_code or user_code")
  }
  if (typeof verification_uri !== "string" || !verification_uri.startsWith("https://")) {
    throw oauthError("muse oauth: device authorization response missing verification_uri")
  }
  const verification_uri_complete =
    typeof json.verification_uri_complete === "string" &&
    json.verification_uri_complete.startsWith("https://")
      ? json.verification_uri_complete
      : undefined
  let expires_in = typeof json.expires_in === "number" ? json.expires_in : 900
  if (!(expires_in >= 60)) expires_in = 60
  if (expires_in > 1800) expires_in = 1800
  const interval = typeof json.interval === "number" && json.interval > 0 ? json.interval : 5
  return { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
}

/**
 * Polls the token endpoint until the user approves the device code, the code
 * expires, or an unexpected error occurs. Honors `authorization_pending` and
 * `slow_down` per RFC 8628.
 */
export async function pollDeviceToken(device: DeviceAuth): Promise<TokenResponse> {
  let interval = Math.max(1, device.interval ?? 5) * 1000
  const deadline = Date.now() + device.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    try {
      const tokens = await postForm<TokenResponse>(OAUTH_TOKEN_URL, {
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code,
        grant_type: OAUTH_DEVICE_GRANT,
      })
      if (!tokens.access_token) throw oauthError("muse oauth: token response carried an empty access token")
      return tokens
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "authorization_pending") continue
      if (code === "slow_down") {
        interval += 5_000
        continue
      }
      if (code === "access_denied") throw oauthError("muse oauth: the sign-in request was denied")
      if (code === "expired_token") throw oauthError("muse oauth: the sign-in request expired — run login again")
      throw err
    }
  }
  throw oauthError("muse oauth: the sign-in request expired before it was approved")
}

/**
 * Exchanges a `dca:` OAuth access token for a `LLM_` API key, the way the
 * `muse` CLI mints the key it stores next to the login. Minting is
 * idempotent: the same key comes back until it is rotated server-side.
 */
export async function mintApiKey(dcaToken: string): Promise<MintResponse> {
  return withRetries("mint", async () => {
    const res = await fetch(MINT_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${dcaToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const json = await readJson(res, MINT_URL)
    if (res.status === 401 || res.status === 403) {
      throw oauthError(
        "muse oauth: saved login is no longer valid — run `opencode auth login muse` again",
        "invalid_grant",
        res.status,
      )
    }
    if (!res.ok) throwForStatus(json, MINT_URL, res.status)
    if (typeof json.api_key !== "string" || !json.api_key) {
      throw oauthError("muse oauth: mint returned an empty api key")
    }
    return json as MintResponse
  })
}

/**
 * Lists the account's entitled models with opencode-shaped metadata
 * (limits, modalities, options, variants). Called on login and whenever the
 * provider needs fresh model metadata.
 */
export async function listModels(apiKey: string): Promise<MuseModelInfo[]> {
  return withRetries("list-models", async () => {
    const res = await fetch(MODELS_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const json = await readJson(res, MODELS_URL)
    if (!res.ok) throwForStatus(json, MODELS_URL, res.status)
    const data = Array.isArray(json?.data) ? json.data : []
    return data.filter((m: unknown) => typeof (m as { id?: unknown }).id === "string") as MuseModelInfo[]
  })
}

/**
 * Normalizes a user-facing reasoning effort to the wire value for
 * `reasoning_effort`, or undefined when the server default should apply.
 * Unknown values are dropped (never sent) so a typo degrades to the default
 * instead of failing the request.
 */
export function mapEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined
  const normalized = effort.trim().toLowerCase()
  if (normalized === "" || normalized === "auto" || normalized === "default") return undefined
  if (normalized === "off") return "none"
  // The muse CLI advertises `ultra`, but the API rejects it; `max` is the
  // strongest accepted tier.
  if (normalized === "ultra") return "max"
  if (REASONING_EFFORTS.has(normalized)) return normalized
  return undefined
}
