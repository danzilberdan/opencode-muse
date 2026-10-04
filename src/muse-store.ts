import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type MuseCliAuth = {
  accessToken: string
  apiBaseUrl?: string
}

/**
 * Read-only view of the `muse` CLI's credential store. When the user already
 * ran `muse login`, opencode can mint its own API key from that login instead
 * of asking for a second browser approval.
 *
 * This module never writes: like the `muse` launcher, it only reads.
 */
export function museAuthPath(): string {
  if (process.env.MUSE_AUTH_PATH) return process.env.MUSE_AUTH_PATH
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(configHome, "muse", "auth.json")
}

export async function readMuseCliAuth(): Promise<MuseCliAuth | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(museAuthPath(), "utf8")) as {
      providers?: { meta?: Record<string, unknown> }
    }
    const meta = parsed?.providers?.meta
    if (!meta || typeof meta !== "object") return undefined
    if (meta.mechanism !== "oauth") return undefined
    const accessToken = meta.access_token
    if (typeof accessToken !== "string" || !accessToken) return undefined
    const apiBaseUrl = typeof meta.api_base_url === "string" ? meta.api_base_url : undefined
    return { accessToken, apiBaseUrl }
  } catch {
    return undefined
  }
}
