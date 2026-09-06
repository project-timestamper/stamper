import { createHash } from "node:crypto"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import {
  lookupCollection,
  type CollectionMeta,
} from "./collections.ts"
import { download, PAGES_BASE } from "./fetch.ts"
import { hashListContains } from "./hashlist.ts"
import {
  downloadTorrent,
  isHttpUrl,
  isMagnetUri,
  verifyTorrentContent,
} from "./torrent.ts"
import {
  verifyDetachedOts,
  type OtsVerifySuccess,
} from "./verify-ots.ts"

export type DigestHttpWorkResult = {
  kind: "http";
  digest: Buffer;
  downloadedBytes: number;
  hashedBytes: number;
  gunzipped: boolean;
}

export type DigestTorrentWorkResult = {
  kind: "torrent";
  digest: Buffer;
  downloadDir: string;
}

export type DigestWorkResult = DigestHttpWorkResult | DigestTorrentWorkResult

export const isTorrentCollection = (meta: CollectionMeta): boolean =>
  meta.hashName === "sha1" && meta.hashBytes === 20

export const isWorkTarget = (value: string): boolean =>
  isHttpUrl(value) || isMagnetUri(value)

/** True when the target should be digested as a torrent (magnet or .torrent URL). */
export const isTorrentWorkTarget = (
  target: string,
  meta: CollectionMeta
): boolean =>
  isMagnetUri(target) || (isTorrentCollection(meta) && isHttpUrl(target))

/** Download an HTTP(S) work and hash it per collection rules. */
export const digestHttpWork = async (
  url: string,
  meta: CollectionMeta
): Promise<DigestHttpWorkResult> => {
  const bytes = await download(url)
  const payload = meta.gunzipBeforeHash ? gunzipSync(bytes) : bytes
  return {
    kind: "http",
    digest: createHash(meta.hashName).update(payload).digest(),
    downloadedBytes: bytes.length,
    hashedBytes: payload.length,
    gunzipped: Boolean(meta.gunzipBeforeHash),
  }
}

/**
 * Download torrent content via WebTorrent, verify infohash + piece hashes,
 * and return the infohash as the work digest.
 */
export const digestTorrentWork = async (
  source: string,
  meta: CollectionMeta,
  opts: { downloadDir: string; collectionName?: string }
): Promise<DigestTorrentWorkResult> => {
  if (!isTorrentCollection(meta)) {
    const label = opts.collectionName ?? "collection"
    throw new Error(
      `magnet/.torrent URLs require a torrent infohash collection (sha1, 20 bytes); got ${label} (${meta.hashName}, ${meta.hashBytes} bytes)`
    )
  }
  const downloaded = await downloadTorrent(source, {
    downloadDir: opts.downloadDir,
  })
  const { infoHash } = await verifyTorrentContent({
    info: downloaded.info,
    expectedInfoHash: downloaded.expectedInfoHash,
    filePaths: downloaded.filePaths,
  })
  return {
    kind: "torrent",
    digest: infoHash,
    downloadDir: opts.downloadDir,
  }
}

/**
 * Digest a work target: magnet / .torrent URL for torrent collections,
 * otherwise an HTTP(S) file URL.
 */
export const digestWork = async (
  target: string,
  meta: CollectionMeta,
  opts: { cacheDir: string; collectionName?: string }
): Promise<DigestWorkResult> => {
  if (isTorrentWorkTarget(target, meta)) {
    return digestTorrentWork(target, meta, {
      downloadDir: path.join(opts.cacheDir, "torrents"),
      collectionName: opts.collectionName,
    })
  }

  return digestHttpWork(target, meta)
}

/** Resolve collection name (for metadata) and fetch base URL. */
export const resolveCollection = (
  collection: string
): { name: string; baseUrl: string; meta: CollectionMeta } => {
  if (isHttpUrl(collection)) {
    const baseUrl = collection.replace(/\/$/, "")
    const name = baseUrl.split("/").pop()
    if (name === undefined || name === "") {
      throw new Error(`could not derive collection name from URL: ${collection}`)
    }
    return { name, baseUrl, meta: lookupCollection(name) }
  }
  return {
    name: collection,
    baseUrl: `${PAGES_BASE}/${collection}`,
    meta: lookupCollection(collection),
  }
}

export type AttestDigestResult = {
  prefix: string;
  attestation: OtsVerifySuccess;
}

/** Find digest in the remote hash list and verify the detached OTS proof. */
export const attestDigest = async (opts: {
  digest: Buffer;
  baseUrl: string;
  meta: CollectionMeta;
  cacheDir: string;
}): Promise<AttestDigestResult> => {
  const { digest, baseUrl, meta, cacheDir } = opts
  if (digest.length !== meta.hashBytes) {
    throw new Error(
      `digest length ${digest.length} does not match collection ${meta.hashBytes}`
    )
  }
  const hex = digest.toString("hex")
  const prefix = hex.slice(0, meta.prefixHexDigits).toUpperCase()
  console.log(`prefix = ${prefix}`)
  const listUrl = `${baseUrl}/${prefix}`
  const list = await download(listUrl)
  if (!hashListContains(list, digest, meta.hashBytes)) {
    throw new Error(`digest not found in ${listUrl}`)
  }
  const hashCount = list.length / meta.hashBytes
  console.log(
    `digest found in ${listUrl} (found among ${hashCount} hashes)`
  )
  console.log('verifying OTS proof...')
  const otsUrl = `${listUrl}.ots`
  const otsBytes = await download(otsUrl)
  const attestation = await verifyDetachedOts({
    fileBytes: list,
    otsBytes,
    label: prefix,
    cacheDir,
  })
  return {
    prefix,
    attestation,
  }
}
