import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { DEFAULT_MODEL_ID, MINT_TTL_MS, OAUTH_METHOD_ID, PROVIDER_ID } from "../src/constants.ts"
import {
  credentialLabel,
  isAuthRetryable,
  isCredentialExpiring,
  isMuseOAuthCredential,
  providerInfo,
  resolveEffort,
  staticModelInfos,
  toModelInfo,
  toModelInfos,
  toOAuthCredential,
} from "../src/models.ts"
import type { MintResponse, MuseModelInfo } from "../src/oauth.ts"

function meta(overrides = {}) {
  return {
    name: "m",
    family: "avocado",
    release_date: "2026-09-02",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1007997, output: 128000 },
    options: { reasoningEffort: "high", temperature: 0.9, top_p: 0.9 },
    variants: {
      low: { reasoningEffort: "low" },
      xhigh: { reasoningEffort: "xhigh", selector: { description: "deep" } },
    },
    ...overrides,
  }
}

describe("providerInfo", () => {
  it("registers the openai-compatible package with baseURL", () => {
    const info = providerInfo()
    assert.equal(info.id, PROVIDER_ID)
    assert.equal(info.package, "@opencode/ai/providers/openai-compatible")
    assert.equal((info.settings as Record<string, unknown>).baseURL, "https://api.meta.ai/v1")
    assert.equal(info.integrationID, PROVIDER_ID)
    assert.equal(info.activation, "enabled")
  })
})

describe("toModelInfo", () => {
  it("maps discovery metadata to capabilities, limits, and settings", () => {
    const model = toModelInfo({ id: "m", metadata: { "muse-code": meta() } })!
    assert.equal(model.id, "m")
    assert.equal(model.providerID, PROVIDER_ID)
    assert.equal(model.name, "m")
    assert.equal(model.capabilities.tools, true)
    assert.deepEqual(model.capabilities.input, ["text", "image"])
    assert.deepEqual(model.capabilities.output, ["text"])
    assert.equal(model.limit.context, 1007997)
    assert.equal(model.limit.output, 128000)
    assert.equal(model.status, "active")
    assert.equal(model.enabled, true)
    const settings = model.settings as Record<string, unknown>
    assert.equal(settings.reasoningEffort, "high")
    assert.equal(settings.temperature, 0.9)
    assert.equal(settings.topP, 0.9)
  })

  it("maps variants to id/settings pairs without extra fields", () => {
    const model = toModelInfo({ id: "m", metadata: { "muse-code": meta() } })!
    const low = model.variants.find((v) => v.id === "low")
    assert.deepEqual((low as { settings: unknown }).settings, { reasoningEffort: "low" })
    const xhigh = model.variants.find((v) => v.id === "xhigh")
    assert.deepEqual((xhigh as { settings: unknown }).settings, { reasoningEffort: "xhigh" })
  })

  it("falls back when metadata is missing", () => {
    const model = toModelInfo({ id: "m" })!
    assert.equal(model.name, "m")
    assert.ok(model.limit.context > 0)
    assert.ok(model.limit.output > 0)
  })

  it("skips hidden models in lists", () => {
    const discovered: MuseModelInfo[] = [
      { id: "a", metadata: { "muse-code": meta({ name: "a" }) } },
      { id: "hidden", metadata: { "muse-code": meta({ name: "hidden", is_hidden: true }) } },
    ]
    const models = toModelInfos(discovered)
    assert.deepEqual(models.map((m) => m.id), ["a"])
  })
})

describe("staticModelInfos", () => {
  it("contains the default model with full limits and tiers", () => {
    const models = staticModelInfos()
    const current = models.find((m) => m.id === DEFAULT_MODEL_ID)!
    assert.ok(current)
    assert.ok(current.limit.context > 0)
    assert.ok(current.limit.output > 0)
    assert.deepEqual(
      current.variants.map((v) => v.id).sort(),
      ["high", "low", "max", "medium", "minimal", "xhigh"],
    )
  })
})

describe("resolveEffort", () => {
  const model = {
    settings: { reasoningEffort: "high" },
    variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
  }
  it("prefers the selected variant then model settings", () => {
    assert.equal(resolveEffort({ variant: "low" }, model), "low")
    assert.equal(resolveEffort({}, model), "high")
    assert.equal(resolveEffort({ variant: "missing" }, model), "high")
  })
  it("returns undefined when nothing applies", () => {
    assert.equal(resolveEffort({}, undefined), undefined)
    assert.equal(resolveEffort({}, {}), undefined)
    assert.equal(resolveEffort({}, { settings: { reasoningEffort: "bogus" } }), undefined)
  })
})

describe("credentials", () => {
  const minted = {
    api_key: "LLM_test",
    base_url: "https://api.meta.ai/v1",
    user_email: "a@b.c",
    subs_tier_name: "Tier",
  } as MintResponse

  it("builds a stored oauth credential from a grant", () => {
    const before = Date.now()
    const credential = toOAuthCredential("dca:test", minted)
    assert.equal(credential.type, "oauth")
    assert.equal(credential.methodID, OAUTH_METHOD_ID)
    assert.equal(credential.refresh, "dca:test")
    assert.equal(credential.access, "LLM_test")
    assert.ok(credential.expires >= before + MINT_TTL_MS)
    assert.equal(credentialLabel(credential), "a@b.c")
  })

  it("recognizes muse oauth credentials", () => {
    assert.equal(isMuseOAuthCredential(toOAuthCredential("dca:x", minted)), true)
    assert.equal(isMuseOAuthCredential({ type: "oauth", methodID: "other" }), false)
    assert.equal(isMuseOAuthCredential({ type: "key", key: "x" }), false)
    assert.equal(isMuseOAuthCredential(undefined), false)
  })

  it("detects expiring checkpoints", () => {
    assert.equal(isCredentialExpiring(Date.now() + MINT_TTL_MS), false)
    assert.equal(isCredentialExpiring(Date.now() - 1000), true)
  })
})

describe("isAuthRetryable", () => {
  it("matches 401s and auth messages only", () => {
    assert.equal(isAuthRetryable({ status: 401 }), true)
    assert.equal(isAuthRetryable({ status: 400, message: "bad request" }), false)
    assert.equal(isAuthRetryable({ message: "Unauthorized" }), true)
    assert.equal(isAuthRetryable({ type: "authentication_error", message: "x" }), true)
    assert.equal(isAuthRetryable({ status: 500, message: "boom" }), false)
  })
})
