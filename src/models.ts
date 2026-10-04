import { Integration, Model, Provider, type Credential } from "@opencode/plugin"
import {
  API_BASE_URL,
  DEFAULT_MODEL_ID,
  MINT_TTL_MS,
  OAUTH_METHOD_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
  REFRESH_SAFETY_WINDOW_MS,
} from "./constants.ts"
import { mapEffort, type MintResponse, type MuseModelInfo, type MuseModelMeta } from "./oauth.ts"

export function providerID() {
  return Provider.ID.make(PROVIDER_ID)
}

export function providerInfo(): Provider.Info {
  return {
    ...Provider.Info.empty(providerID()),
    name: PROVIDER_NAME,
    activation: "enabled",
    package: PROVIDER_PACKAGE,
    settings: { baseURL: API_BASE_URL },
    integrationID: Integration.ID.make(PROVIDER_ID),
  }
}

function releaseTime(releaseDate: string | undefined): number {
  if (!releaseDate) return 0
  const parsed = Date.parse(`${releaseDate}T00:00:00Z`)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function variantInfos(meta: MuseModelMeta): Model.Info["variants"] {
  const variants: Array<{ id: Model.VariantID; settings: Record<string, unknown> }> = []
  for (const [id, settings] of Object.entries(meta.variants ?? {})) {
    const effort = settings?.reasoningEffort ?? settings?.reasoning_effort
    // Only the effort tier is a valid provider option; anything else the
    // server sends (descriptions, selectors) must not leak into requests.
    const tier = typeof effort === "string" ? (mapEffort(effort) ?? effort) : undefined
    variants.push({ id: Model.VariantID.make(id), settings: tier ? { reasoningEffort: tier } : {} })
  }
  return variants
}

function modelSettings(meta: MuseModelMeta): Record<string, unknown> {
  const options = meta.options ?? {}
  const settings: Record<string, unknown> = {}
  const effort = mapEffort(options.reasoningEffort ?? options.reasoning_effort)
  if (effort) settings.reasoningEffort = effort
  if (typeof options.temperature === "number") settings.temperature = options.temperature
  const topP = options.topP ?? options.top_p
  if (typeof topP === "number") settings.topP = topP
  return settings
}

/**
 * Maps server discovery to a v2 model definition. Cost is left empty: the
 * subscription bills a flat rate, not per token.
 */
export function toModelInfo(info: MuseModelInfo): Model.Info | undefined {
  if (!info.id) return undefined
  const meta: MuseModelMeta = info.metadata?.["muse-code"] ?? { name: info.id }
  const context = meta.limit?.context && meta.limit.context > 0 ? meta.limit.context : 200_000
  const output = meta.limit?.output && meta.limit.output > 0 ? meta.limit.output : 32_000
  return {
    ...Model.Info.default(providerID(), Model.ID.make(info.id)),
    name: meta.name || info.id,
    family: (meta.family ?? info.id) as Model.Info["family"],
    capabilities: {
      tools: meta.tool_call ?? true,
      input: meta.modalities?.input ?? ["text"],
      output: meta.modalities?.output ?? ["text"],
    },
    variants: variantInfos(meta),
    time: { released: releaseTime(meta.release_date) },
    limit: { context, output },
    status: "active",
    enabled: true,
    settings: modelSettings(meta),
  }
}

/**
 * Maps a discovery list to model definitions, skipping hidden models.
 */
export function toModelInfos(discovered: MuseModelInfo[]): Model.Info[] {
  const models: Model.Info[] = []
  for (const info of discovered) {
    if (info.metadata?.["muse-code"]?.is_hidden) continue
    const model = toModelInfo(info)
    if (model) models.push(model)
  }
  return models
}

function staticMeta(
  id: string,
  releaseDate: string,
  extraVariants: Record<string, Record<string, unknown>> = {},
): MuseModelInfo {
  return {
    id,
    metadata: {
      "muse-code": {
        name: id,
        family: "avocado",
        release_date: releaseDate,
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1007997, output: 128000 },
        options: { reasoningEffort: "high", temperature: 0.9, top_p: 0.9 },
        variants: {
          minimal: { reasoningEffort: "minimal" },
          low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" },
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" },
          max: { reasoningEffort: "max" },
          ...extraVariants,
        },
      },
    },
  }
}

/**
 * Static fallback inventory, mirroring live discovery. Used until the first
 * discovery refresh (and when offline); refreshed from the server whenever a
 * credential is available.
 */
export function staticModelInfos(): Model.Info[] {
  return toModelInfos([
    staticMeta("muse-spark-1.3-contributor", "2026-09-02"),
    staticMeta("muse-spark-1.3", "2026-09-02"),
    staticMeta("muse-spark-1.2-contributor", "2026-08-05"),
    staticMeta("muse-spark-1.2", "2026-08-05"),
  ])
}

export function defaultModelID(): string {
  return DEFAULT_MODEL_ID
}

type VariantLike = { id: string; settings?: Record<string, unknown> | undefined }
type ModelLike = {
  settings?: Record<string, unknown> | undefined
  variants?: ReadonlyArray<VariantLike> | undefined
}

function pickEffort(options: Record<string, unknown> | undefined): unknown {
  return options?.reasoningEffort ?? options?.reasoning_effort
}

/**
 * Resolves the semantic `reasoningEffort` for a request from the selected
 * variant (when set) falling back to the model settings. Returns undefined
 * when the server default should apply.
 */
export function resolveEffort(
  ref: { variant?: string | undefined } | undefined,
  model: ModelLike | undefined,
): string | undefined {
  if (!model) return undefined
  const variant = ref?.variant ? model.variants?.find((entry) => entry.id === ref.variant) : undefined
  return mapEffort(pickEffort(variant?.settings) ?? pickEffort(model.settings))
}

/**
 * Builds the stored OAuth credential from a device-flow grant:
 * - `access`: the minted `LLM_` API key, sent as the Bearer token to
 *   `https://api.meta.ai/v1/*`.
 * - `refresh`: the `dca:` OAuth token, used only to mint fresh API keys.
 * - `expires`: the next re-mint checkpoint (minting is idempotent).
 */
export function toOAuthCredential(dcaToken: string, minted: MintResponse): Credential.OAuth {
  const metadata: Record<string, unknown> = {}
  if (minted.user_email) metadata.email = minted.user_email
  if (minted.subs_tier_name) metadata.tier = minted.subs_tier_name
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(OAUTH_METHOD_ID),
    refresh: dcaToken,
    access: minted.api_key,
    expires: Date.now() + MINT_TTL_MS,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  }
}

export function isMuseOAuthCredential(value: unknown): value is Credential.OAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const credential = value as Partial<Credential.OAuth>
  return (
    credential.type === "oauth" &&
    credential.methodID === OAUTH_METHOD_ID &&
    typeof credential.refresh === "string" &&
    typeof credential.access === "string" &&
    typeof credential.expires === "number"
  )
}

export function isCredentialExpiring(expires: number): boolean {
  return expires - Date.now() < REFRESH_SAFETY_WINDOW_MS
}

export function credentialLabel(credential: Credential.OAuth): string | undefined {
  const email = (credential.metadata as Record<string, unknown> | undefined)?.email
  return typeof email === "string" ? email : undefined
}

/**
 * Whether a failed request looks like expired/rotated credentials and is
 * worth exactly one re-mint plus retry.
 */
export function isAuthRetryable(error: { status?: number; type?: string; message?: string }): boolean {
  if (error.status === 401) return true
  return /unauthor|authentication|invalid_api_key|invalid_grant/i.test(`${error.type ?? ""} ${error.message ?? ""}`)
}
