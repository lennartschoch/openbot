import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("runtime-install");

export async function isCurrentInstallation(verify: () => Promise<void>): Promise<boolean> {
  try {
    await verify();
    return true;
  } catch {
    return false;
  }
}

/**
 * One request, retried. A network error, HTTP 429 or HTTP 5xx gets four more attempts, because a
 * release runner can lose its connection (v0.40.0 timed out on the Grok runtime) and because a
 * release asset download through the edge can return 504. The delay doubles per attempt and
 * jitters, so a fleet of runners does not stampede the same origin.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  init?: RequestInit,
): Promise<Response> {
  const attempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await fetchImpl(url, { ...init, redirect: "follow" });
      if (response.ok) return response;
    } catch (error) {
      failure = error;
    }
    if (response && !response.ok) {
      failure = new Error(`${label} request failed with HTTP ${response.status}.`);
      if (response.status !== 429 && response.status < 500) throw failure;
      await response.body?.cancel();
    }
    if (attempt === attempts) throw failure;
    logger.warn(`${label} request failed (attempt ${attempt} of ${attempts}): ${String(failure)}`);
    await sleepWithJitter(attempt);
  }
}

function sleepWithJitter(attempt: number): Promise<void> {
  const base = Math.min(5_000 * 2 ** (attempt - 1), 40_000);
  return new Promise((resolveDelay) => setTimeout(resolveDelay, base + Math.random() * 2_000));
}

/** Downloads one file. The caller checks the SHA-256 of the result, so a retry cannot change what it installs. */
export async function download(fetchImpl: typeof fetch, url: string, label: string): Promise<Buffer> {
  const response = await fetchWithRetry(fetchImpl, url, label, {
    headers: { "User-Agent": "OpenBot-runtime-installer" },
  });
  return Buffer.from(await response.arrayBuffer());
}

/** Splits a relative archive path into parts and rejects absolute, drive, `.` and `..` paths. */
export function safeArchivePathParts(name: string, label: string): string[] {
  if (name.includes("\0") || name.includes("\\")) throw new Error(`Unsafe ${label} archive path: ${name}`);
  const normalized = name.replace(/\/+$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`Unsafe ${label} archive path: ${name}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe ${label} archive path: ${name}`);
  }
  return parts;
}

export async function installValidatedTree(source: string, destination: string): Promise<void> {
  const temporaryTarget = join(dirname(destination), `.${destination.split(/[\\/]/u).at(-1)}.installing`);
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporaryTarget, { recursive: true, force: true });
  await cp(source, temporaryTarget, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporaryTarget, destination);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
