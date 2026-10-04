import { Plugin } from "@opencode/plugin"
import {
  ACCOUNT_URL,
  MINT_TTL_MS,
  OAUTH_METHOD_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  SUBSCRIBE_URL,
} from "./constants.ts"
import {
  credentialLabel,
  isAuthRetryable,
  isCredentialExpiring,
  isMuseOAuthCredential,
  providerInfo,
  resolveEffort,
  staticModelInfos,
  toModelInfos,
  toOAuthCredential,
} from "./models.ts"
import { readMuseCliAuth } from "./muse-store.ts"
import {
  listModels,
  mintApiKey,
  pollDeviceToken,
  startDeviceAuth,
  type MintResponse,
} from "./oauth.ts"

// IMPORTANT: this module's default export is the whole plugin definition.
// Keep supporting modules beside it; the loader treats every top-level file
// as a plugin candidate, so only this file may default-export a definition.

/**
 * One-line subscription summary for the login screen (plugin stdout is not
 * surfaced anywhere, so the visible `instructions` field carries it).
 */
function subscriptionSummary(minted: MintResponse): string {
  const parts: string[] = []
  if (minted.subs_tier_name) parts.push(minted.subs_tier_name)
  const window = minted.subs_usage?.window
  const weekly = minted.subs_usage?.weekly
  const usage: string[] = []
  if (window?.used_percent !== undefined) usage.push(`${window.used_percent}% window`)
  if (weekly?.used_percent !== undefined) usage.push(`${weekly.used_percent}% weekly`)
  if (usage.length > 0) parts.push(`usage ${usage.join(", ")}`)
  if (minted.require_payment || minted.is_subs_active === false) {
    parts.push(`action required: ${minted.action_url ?? SUBSCRIBE_URL}`)
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : ""
}

/**
 * Muse subscription for opencode, mirroring the official `muse` CLI:
 *
 * - `provider.transform` contributes the `muse` OpenAI-compatible provider
 *   (`https://api.meta.ai/v1`) with the account's model inventory, refreshed
 *   from `/muse-code/models` whenever a credential is available.
 * - `integration.transform` registers the device-flow OAuth login (the same
 *   flow as `muse login`). When `muse login` was already run, its token is
 *   reused read-only and no browser approval is needed.
 * - `http.request` sets the minted API key on every request, re-minting past
 *   the checkpoint; `retry` re-mints once more on a 401 and retries.
 * - `context`/`compaction`/`generate`/`title` resolve the semantic
 *   `reasoningEffort` from the selected variant/model settings.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const source = { models: staticModelInfos() }
    let override: { access: string; expiresAt: number } | undefined
    let mintPromise: Promise<string> | undefined
    const retried = new Set<string>()

    const loadInventory = async (apiKey: string) => {
      try {
        const mapped = toModelInfos(await listModels(apiKey))
        return mapped.length > 0 ? mapped : undefined
      } catch {
        return undefined
      }
    }

    const refreshModels = async (apiKey: string) => {
      const mapped = await loadInventory(apiKey)
      if (!mapped) return
      source.models = mapped
      await ctx.provider.reload().catch(() => undefined)
    }

    const mintFresh = async (dcaToken: string): Promise<string> => {
      if (mintPromise) return mintPromise
      mintPromise = (async () => {
        try {
          const minted = await mintApiKey(dcaToken)
          override = { access: minted.api_key, expiresAt: Date.now() + MINT_TTL_MS }
          return minted.api_key
        } finally {
          mintPromise = undefined
        }
      })()
      return mintPromise
    }

    const resolveCredential = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
      const credential = connection
        ? await ctx.integration.connection.resolve(connection).catch(() => undefined)
        : undefined
      return isMuseOAuthCredential(credential) ? credential : undefined
    }

    const resolveAccess = async (): Promise<string> => {
      if (override && override.expiresAt > Date.now()) return override.access
      const credential = await resolveCredential()
      if (credential) {
        if (!isCredentialExpiring(credential.expires)) return credential.access
        try {
          return await mintFresh(credential.refresh)
        } catch {
          return credential.access
        }
      }
      // Zero-login path: an existing `muse login` is enough to mint from.
      const museCli = await readMuseCliAuth()
      if (museCli) {
        try {
          return await mintFresh(museCli.accessToken)
        } catch {
          // Fall through to the login error below.
        }
      }
      throw new Error(
        "muse: not logged in — run `opencode auth login`, choose Muse, and approve the device code (or run `muse login` first)",
      )
    }

    // Load account-specific inventory before registering the source.
    try {
      const credential = await resolveCredential()
      if (credential) {
        const mapped = await loadInventory(credential.access)
        if (mapped) source.models = mapped
      } else {
        const museCli = await readMuseCliAuth()
        if (museCli) {
          try {
            const minted = await mintApiKey(museCli.accessToken)
            override = { access: minted.api_key, expiresAt: Date.now() + MINT_TTL_MS }
            const mapped = await loadInventory(minted.api_key)
            if (mapped) source.models = mapped
          } catch {
            // Static inventory; requests re-attempt the mint.
          }
        }
      }
    } catch {
      // Static inventory.
    }

    await ctx.provider.transform((editor) => {
      if (!editor.get(PROVIDER_ID)) {
        editor.add({ info: providerInfo(), models: source.models })
      }
    })

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: "oauth",
          label: "Muse Code (device flow)",
        },
        authorize: async () => {
          // Fast path: reuse an existing `muse login` with no browser.
          const museCli = await readMuseCliAuth()
          if (museCli) {
            try {
              const minted = await mintApiKey(museCli.accessToken)
              const credential = toOAuthCredential(museCli.accessToken, minted)
              await refreshModels(minted.api_key)
              return {
                url: ACCOUNT_URL,
                instructions: `Found an existing muse CLI login — reusing it, no browser approval needed.${subscriptionSummary(minted)}`,
                mode: "auto",
                callback: Promise.resolve(credential),
              } as const
            } catch {
              // Fall through to the device flow below.
            }
          }

          const device = await startDeviceAuth()
          return {
            url: device.verification_uri_complete ?? device.verification_uri,
            instructions: `Open the URL and approve code ${device.user_code}. This continues automatically once approved.`,
            mode: "auto",
            callback: (async () => {
              const tokens = await pollDeviceToken(device)
              const minted = await mintApiKey(tokens.access_token)
              const credential = toOAuthCredential(tokens.access_token, minted)
              await refreshModels(minted.api_key)
              return credential
            })(),
          } as const
        },
        refresh: async (credential) => {
          const minted = await mintApiKey(credential.refresh)
          override = { access: minted.api_key, expiresAt: Date.now() + MINT_TTL_MS }
          void refreshModels(minted.api_key)
          return { ...credential, access: minted.api_key, expires: Date.now() + MINT_TTL_MS }
        },
        label: (credential) => credentialLabel(credential),
      })
    })

    await ctx.session.hook(
      "http.request",
      async (event) => {
        const access = await resolveAccess()
        const headers = new Headers(event.request.headers)
        headers.set("authorization", `Bearer ${access}`)
        event.request = new Request(event.request, { headers })
      },
      { providerID: PROVIDER_ID },
    )

    await ctx.session.hook(
      "retry",
      async (event) => {
        if (
          !isAuthRetryable({ status: event.error.status, type: event.error.type, message: event.error.message })
        ) {
          return
        }
        const key = `${event.sessionID}:${event.attempt}`
        if (retried.has(key)) return
        try {
          const credential = await resolveCredential()
          const dca = credential?.refresh ?? (await readMuseCliAuth())?.accessToken
          if (!dca) return
          await mintFresh(dca)
          retried.add(key)
          event.decision = { retry: true, delay: 0 }
        } catch {
          // Let the original error stand.
        }
      },
      { providerID: PROVIDER_ID },
    )

    const applyEffort = async (event: {
      model: { id: string; variant?: string | undefined }
      options: Record<string, unknown>
    }) => {
      try {
        const { data: models } = await ctx.model.list()
        const model = models.find((entry) => entry.providerID === PROVIDER_ID && entry.id === event.model.id)
        const effort = resolveEffort(event.model, model)
        if (effort) event.options.reasoningEffort = effort
      } catch {
        // Server default applies.
      }
    }
    for (const name of ["context", "compaction", "generate", "title"] as const) {
      await ctx.session.hook(name, applyEffort, { providerID: PROVIDER_ID })
    }
  },
})
