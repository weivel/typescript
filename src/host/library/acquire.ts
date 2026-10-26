import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginError } from "../../engine/index.js";
import type { PluginError } from "../../index.js";
import { parseDeclaration } from "./declaration.js";
import type { LibraryDeclaration } from "./declaration.js";

/**
 * Which release of which library a host loads, and the digest every file of it must have.
 *
 * @remarks
 * `sha256` is keyed by `library.json` and by platform key (`win32-x64`, `linux-x64`), each value
 * the hex SHA-256 of that asset as the release's `SHA256SUMS` lists it. The embedding host holds
 * the pins, so a release rebuilt under the same tag is refused rather than loaded.
 */
export interface LibraryPin {
  repository: string;
  tag: string;
  sha256: Record<string, string>;
}

/** A verified declaration and the verified binary it describes, both in the cache. */
export interface AcquiredLibrary {
  declaration: LibraryDeclaration;
  binaryPath: string;
}

const DECLARATION_ASSET = "library.json";
const RELEASE_HOST = "https://github.com";
const BINARY_EXTENSION: Readonly<Record<string, string>> = { win32: "dll", linux: "so", darwin: "dylib" };
const PATH_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.+-]+$/;

/** The platform key this process loads binaries for, in the form a release names them. */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function labelOf(pin: LibraryPin): string {
  return `${pin.repository}@${pin.tag}`;
}

function refusal(pin: LibraryPin, detail: string, fix: string): PluginError {
  return pluginError(labelOf(pin), detail, fix);
}

/** @implNote The repository and tag become cache path segments, so neither may climb out of the cache. */
function assertPinShape(pin: LibraryPin): void {
  const segments = [...pin.repository.split("/"), pin.tag];
  if (segments.length === 3 && segments.every((segment) => PATH_SEGMENT.test(segment))) return;
  throw refusal(pin, "the pin's repository must be owner/name and its tag a plain release tag", "pin the library as { repository: \"owner/name\", tag: \"v1.2.3\" }");
}

function pinnedDigest(pin: LibraryPin, key: string, missingFix: string): string {
  const digest = pin.sha256[key];
  if (typeof digest === "string" && /^[0-9a-fA-F]{64}$/.test(digest)) return digest.toLowerCase();
  throw refusal(pin, `the pin carries no SHA-256 for ${key}, so ${labelOf(pin)} has nothing verifiable to load for it`, missingFix);
}

function binaryAssetFor(pin: LibraryPin, declaration: LibraryDeclaration, platformKey: string): string {
  const extension = BINARY_EXTENSION[platformKey.split("-")[0]];
  if (extension) return `${declaration.binary}-${platformKey}.${extension}`;
  throw refusal(pin, `no shared-library format is known for platform ${platformKey}`, "run the host on Windows, Linux or macOS");
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function download(pin: LibraryPin, url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw refusal(pin, `${url} could not be fetched: ${(error as Error).message}`, "check the network, then start the host again");
  }
  if (!response.ok) {
    throw refusal(pin, `${url} answered HTTP ${response.status}`, `check that release ${pin.tag} of ${pin.repository} publishes this asset`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * @implNote Written beside its final name and renamed into place, so a run killed mid-write leaves
 * a stray temporary file rather than a truncated asset under the real name.
 */
async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The bytes of one release asset whose digest matches its pin, from the cache or freshly downloaded.
 *
 * @remarks
 * A cached file is hashed on every read and never trusted for existing: a mismatch downloads again,
 * and a download that also mismatches is refused without being written.
 */
async function verifiedAsset(
  pin: LibraryPin,
  asset: string,
  digest: string,
  directory: string,
  fetchImpl: typeof fetch,
): Promise<{ path: string; bytes: Uint8Array }> {
  const path = join(directory, asset);
  const cached = await readIfPresent(path);
  if (cached && sha256Of(cached) === digest) return { path, bytes: cached };
  const url = `${RELEASE_HOST}/${pin.repository}/releases/download/${pin.tag}/${asset}`;
  const downloaded = await download(pin, url, fetchImpl);
  const actual = sha256Of(downloaded);
  if (actual !== digest) {
    throw refusal(pin, `${asset} from ${url} has SHA-256 ${actual}, but the pin says ${digest}`, "never load it: correct the pin only if the release was rebuilt on purpose");
  }
  await mkdir(directory, { recursive: true });
  await writeAtomically(path, downloaded);
  return { path, bytes: downloaded };
}

function declarationOf(pin: LibraryPin, bytes: Uint8Array): LibraryDeclaration {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refusal(pin, `${DECLARATION_ASSET} is not UTF-8`, "publish library.json as UTF-8");
  }
  return parseDeclaration(text);
}

/**
 * Fetches a pinned library's declaration and one platform's binary into the cache, verifying both.
 *
 * @param platformKey - the binary to acquire, this process's own by default
 * @throws a `PluginError` naming the release when an asset is unpinned, unreachable or mismatched
 */
export async function acquireLibrary(
  pin: LibraryPin,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
  platformKey: string = currentPlatformKey(),
): Promise<AcquiredLibrary> {
  assertPinShape(pin);
  const binaryDigest = pinnedDigest(pin, platformKey, `add the ${platformKey} digest from the release's SHA256SUMS to the pin, or run on a platform the library is built for`);
  const declarationDigest = pinnedDigest(pin, DECLARATION_ASSET, "add the library.json digest from the release's SHA256SUMS to the pin");
  const directory = join(cacheDir, ...pin.repository.split("/"), pin.tag);
  const declarationAsset = await verifiedAsset(pin, DECLARATION_ASSET, declarationDigest, directory, fetchImpl);
  const declaration = declarationOf(pin, declarationAsset.bytes);
  const binary = await verifiedAsset(pin, binaryAssetFor(pin, declaration, platformKey), binaryDigest, directory, fetchImpl);
  return { declaration, binaryPath: binary.path };
}
