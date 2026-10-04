import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "node:test"
import { OAUTH_CLIENT_ID, OAUTH_DEVICE_AUTH_URL, OAUTH_TOKEN_URL } from "../src/constants.ts"
import {
  listModels,
  mapEffort,
  mintApiKey,
  pollDeviceToken,
  startDeviceAuth,
} from "../src/oauth.ts"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("mapEffort", () => {
  it("passes valid tiers through lowercased", () => {
    assert.equal(mapEffort("high"), "high")
    assert.equal(mapEffort("HIGH"), "high")
    assert.equal(mapEffort("xhigh"), "xhigh")
    assert.equal(mapEffort("none"), "none")
    assert.equal(mapEffort("max"), "max")
  })
  it("maps aliases", () => {
    assert.equal(mapEffort("off"), "none")
    assert.equal(mapEffort("OFF"), "none")
    assert.equal(mapEffort("ultra"), "max")
  })
  it("returns undefined for auto/unset/unknown", () => {
    assert.equal(mapEffort(undefined), undefined)
    assert.equal(mapEffort("auto"), undefined)
    assert.equal(mapEffort(""), undefined)
    assert.equal(mapEffort("bogus"), undefined)
    assert.equal(mapEffort(42), undefined)
  })
})

describe("startDeviceAuth", () => {
  it("posts client_id and parses the device response", async () => {
    let seenUrl = ""
    let seenBody = ""
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenBody = String(init?.body ?? "")
      return jsonResponse({
        device_code: "dc",
        user_code: "UC-1",
        verification_uri: "https://example.com/verify",
        verification_uri_complete: "https://example.com/verify?code=UC-1",
        expires_in: 900,
        interval: 5,
      })
    }) as typeof fetch

    const device = await startDeviceAuth()
    assert.equal(seenUrl, OAUTH_DEVICE_AUTH_URL)
    assert.ok(seenBody.includes(`client_id=${OAUTH_CLIENT_ID}`))
    assert.equal(device.device_code, "dc")
    assert.equal(device.user_code, "UC-1")
    assert.equal(device.verification_uri_complete, "https://example.com/verify?code=UC-1")
    assert.equal(device.expires_in, 900)
    assert.equal(device.interval, 5)
  })

  it("rejects responses missing codes", async () => {
    globalThis.fetch = (async () => jsonResponse({ user_code: "x" })) as typeof fetch
    await assert.rejects(startDeviceAuth, /device_code or user_code/)
  })
})

describe("pollDeviceToken", () => {
  it("polls through pending then returns tokens", async () => {
    let calls = 0
    globalThis.fetch = (async (url: any, init: any) => {
      calls++
      assert.equal(String(url), OAUTH_TOKEN_URL)
      assert.ok(String(init?.body ?? "").includes("device_code"))
      if (calls < 3) return jsonResponse({ error: "authorization_pending" }, 400)
      return jsonResponse({ access_token: "dca:test" })
    }) as typeof fetch

    const tokens = await pollDeviceToken({
      device_code: "dc",
      user_code: "UC",
      verification_uri: "https://example.com",
      expires_in: 60,
      interval: 0,
    })
    assert.equal(tokens.access_token, "dca:test")
    assert.equal(calls, 3)
  })

  it("throws a friendly error on denial", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "access_denied" }, 400)) as typeof fetch
    await assert.rejects(
      pollDeviceToken({
        device_code: "dc",
        user_code: "UC",
        verification_uri: "https://example.com",
        expires_in: 60,
        interval: 0,
      }),
      /denied/,
    )
  })

  it("throws when the code already expired", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse({ access_token: "dca:late" })
    }) as typeof fetch
    await assert.rejects(
      pollDeviceToken({
        device_code: "dc",
        user_code: "UC",
        verification_uri: "https://example.com",
        expires_in: 0,
        interval: 0,
      }),
      /expired/,
    )
    assert.equal(calls, 0)
  })
})

describe("mintApiKey", () => {
  it("mints with the dca token and parses subscription fields", async () => {
    let seenAuth = ""
    globalThis.fetch = (async (_url: any, init: any) => {
      seenAuth = new Headers(init?.headers).get("authorization") ?? ""
      return jsonResponse({
        api_key: "LLM_test",
        base_url: "https://api.meta.ai/v1",
        user_email: "a@b.c",
        is_subs_active: true,
        subs_tier_name: "Tier",
        subs_usage: { window: { used_percent: 5 } },
      })
    }) as typeof fetch

    const minted = await mintApiKey("dca:test")
    assert.equal(seenAuth, "Bearer dca:test")
    assert.equal(minted.api_key, "LLM_test")
    assert.equal(minted.subs_tier_name, "Tier")
    assert.equal(minted.subs_usage?.window?.used_percent, 5)
  })

  it("maps 401 to a re-login error without retrying", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse({ title: "Authentication Error" }, 401)
    }) as typeof fetch
    await assert.rejects(mintApiKey("dca:dead"), /no longer valid/)
    assert.equal(calls, 1)
  })
})

describe("listModels", () => {
  it("returns entries with string ids", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ data: [{ id: "a" }, { id: 42 }, {}] })) as typeof fetch
    const models = await listModels("LLM_test")
    assert.deepEqual(models.map((m) => m.id), ["a"])
  })

  it("surfaces 401 with status", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: "x" } }, 401)) as typeof fetch
    const err = await listModels("LLM_dead").then(
      () => undefined,
      (e: unknown) => e as { status?: number },
    )
    assert.equal(err?.status, 401)
  })
})
