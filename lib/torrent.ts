import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import bencode from "bencode";
import parseTorrent from "parse-torrent";
import WebTorrent from "webtorrent";
import { isRecord } from "./util.ts";

const PIECE_HASH_BYTES = 20;

export type TorrentInfo = Record<string, unknown>;

export type TorrentDownload = {
  /** Expected v1 infohash (lowercase hex), from magnet or .torrent file. */
  expectedInfoHash: string;
  /** Raw BitTorrent `info` dict from WebTorrent / parse-torrent. */
  info: TorrentInfo;
  /** Absolute paths to downloaded files, in torrent order. */
  filePaths: string[];
  downloadDir: string;
};

type WebTorrentFile = {
  path: string;
  length: number;
};

type WebTorrentTorrent = {
  infoHash: string;
  info: TorrentInfo | undefined;
  path: string;
  files: WebTorrentFile[];
  /** Fraction downloaded in [0, 1]. */
  progress: number;
  ready: boolean;
  numPeers: number;
  downloadSpeed: number;
  uploaded: number;
  downloaded: number;
  length: number;
  destroy: (
    opts?: { destroyStore?: boolean },
    cb?: (err?: Error | string | null) => void
  ) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

type WebTorrentClient = {
  add: (
    torrentId: string | Uint8Array,
    opts: { path: string; skipVerify?: boolean; destroyStoreOnDestroy?: boolean }
  ) => WebTorrentTorrent;
  destroy: (cb?: (err?: Error | string | null) => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

export const isMagnetUri = (value: string): boolean =>
  value.startsWith("magnet:");

export const isHttpUrl = (value: string): boolean =>
  value.startsWith("https://") || value.startsWith("http://");

const requireV1InfoHash = (infoHash: string | undefined): string => {
  if (infoHash === undefined || infoHash.length !== 40) {
    throw new Error(
      "torrent has no BitTorrent v1 infohash; v2-only torrents are not supported"
    );
  }
  return infoHash.toLowerCase();
};

/** Extract the v1 infohash (lowercase hex) from a magnet URI. */
export const magnetInfoHash = async (magnetUri: string): Promise<string> => {
  const parsed = await parseTorrent(magnetUri);
  return requireV1InfoHash(parsed.infoHash);
};

const USER_AGENT = "stamper/0.1 (Project Timestamper verifier)";

/**
 * Resolve a magnet URI or http(s) .torrent URL into something WebTorrent can add,
 * plus the expected infohash for later verification.
 */
export const resolveTorrentSource = async (
  source: string
): Promise<{ addArg: string | Uint8Array; expectedInfoHash: string }> => {
  if (isMagnetUri(source)) {
    return {
      addArg: source,
      expectedInfoHash: await magnetInfoHash(source),
    };
  }
  if (isHttpUrl(source)) {
    const response = await fetch(source, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(
        `torrent download failed: ${response.status} ${response.statusText} (${source})`
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    let parsed: { infoHash?: string };
    try {
      parsed = await parseTorrent(buf);
    } catch (err) {
      throw new Error(
        `URL did not contain a valid .torrent file (${source}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return {
      addArg: buf,
      expectedInfoHash: requireV1InfoHash(parsed.infoHash),
    };
  }
  throw new Error(
    "torrent source must be a magnet URI or http(s) URL to a .torrent file"
  );
};

const asBuffer = (value: unknown, label: string): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error(`${label} must be a byte string`);
};

const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

/** SHA-1(bencode(info)) — the BitTorrent v1 infohash. */
export const infoHashFromInfo = (info: TorrentInfo): Buffer => {
  const encoded = bencode.encode(info);
  return createHash("sha1").update(encoded).digest();
};

const torrentFileEntries = (
  info: TorrentInfo
): { length: number }[] => {
  if (Array.isArray(info.files)) {
    return info.files.map((file, i) => {
      if (!isRecord(file)) {
        throw new Error(`info.files[${i}] is not a dict`);
      }
      return { length: asNumber(file.length, `info.files[${i}].length`) };
    });
  }
  return [{ length: asNumber(info.length, "info.length") }];
};

/**
 * Verify downloaded payload against torrent metainfo:
 * 1. SHA-1(bencode(info)) equals expectedInfoHash
 * 2–3. Stream files in torrent order and check each piece SHA-1 against info.pieces
 */
export const verifyTorrentContent = async ({
  info,
  expectedInfoHash,
  filePaths,
}: {
  info: TorrentInfo;
  expectedInfoHash: string;
  filePaths: string[];
}): Promise<{ infoHash: Buffer }> => {
  const expected = expectedInfoHash.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    throw new Error(`expected infohash must be 40 hex chars, got "${expectedInfoHash}"`);
  }

  const infoHash = infoHashFromInfo(info);
  const computed = infoHash.toString("hex");
  if (computed !== expected) {
    throw new Error(
      `infohash mismatch: SHA-1(bencode(info))=${computed} != magnet ${expected}`
    );
  }

  const pieceLength = asNumber(info["piece length"], "info['piece length']");
  const pieces = asBuffer(info.pieces, "info.pieces");
  if (pieces.length % PIECE_HASH_BYTES !== 0) {
    throw new Error(
      `info.pieces length ${pieces.length} is not a multiple of ${PIECE_HASH_BYTES}`
    );
  }
  const pieceCount = pieces.length / PIECE_HASH_BYTES;

  const entries = torrentFileEntries(info);
  if (filePaths.length !== entries.length) {
    throw new Error(
      `file count mismatch: metainfo has ${entries.length}, got ${filePaths.length} paths`
    );
  }

  let totalLength = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const filePath = filePaths[i];
    if (entry === undefined || filePath === undefined) {
      throw new Error("internal error: missing file entry");
    }
    const st = await fs.stat(filePath);
    if (st.size !== entry.length) {
      throw new Error(
        `size mismatch for ${filePath}: on disk ${st.size}, metainfo ${entry.length}`
      );
    }
    totalLength += entry.length;
  }

  const expectedPieces = Math.ceil(totalLength / pieceLength);
  if (expectedPieces !== pieceCount) {
    throw new Error(
      `piece count mismatch: length ${totalLength} / pieceLength ${pieceLength} => ${expectedPieces}, but info.pieces has ${pieceCount}`
    );
  }

  let pieceIndex = 0;
  let filled = 0;
  let hasher = createHash("sha1");

  const finishPiece = (isLast: boolean): void => {
    if (pieceIndex >= pieceCount) {
      throw new Error("extra data beyond last piece");
    }
    const digest = hasher.digest();
    const expectedPiece = pieces.subarray(
      pieceIndex * PIECE_HASH_BYTES,
      pieceIndex * PIECE_HASH_BYTES + PIECE_HASH_BYTES
    );
    if (!digest.equals(expectedPiece)) {
      throw new Error(
        `piece ${pieceIndex} hash mismatch` + (isLast ? " (last piece)" : "")
      );
    }
    pieceIndex += 1;
    filled = 0;
    hasher = createHash("sha1");
  };

  for (const filePath of filePaths) {
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buf.length) {
        const need = pieceLength - filled;
        const take = Math.min(need, buf.length - offset);
        hasher.update(buf.subarray(offset, offset + take));
        offset += take;
        filled += take;
        if (filled === pieceLength) {
          finishPiece(false);
        }
      }
    }
  }

  if (filled > 0) {
    finishPiece(true);
  }
  if (pieceIndex !== pieceCount) {
    throw new Error(
      `processed ${pieceIndex} pieces, expected ${pieceCount}`
    );
  }

  return { infoHash };
};

const destroyClient = async (client: WebTorrentClient): Promise<void> =>
  new Promise((resolve, reject) => {
    client.destroy((err) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } else {
        resolve();
      }
    });
  });

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) {
    return "0B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${units[unit]}`;
};

const formatProgressLine = (torrent: WebTorrentTorrent): string => {
  const peers = torrent.numPeers;
  const speed = `${formatBytes(torrent.downloadSpeed)}/s`;
  if (!torrent.ready) {
    // Keep this short: narrow IDE panels wrap long lines and break in-place updates.
    return `dl … meta:no ${peers}p ${speed}`;
  }
  const pct = Math.min(100, Math.max(0, torrent.progress * 100)).toFixed(1);
  const have = formatBytes(torrent.downloaded);
  const total = torrent.length > 0 ? formatBytes(torrent.length) : "?";
  return `dl ${pct}% ${have}/${total} ${peers}p ${speed}`;
};

const writeProgress = (torrent: WebTorrentTorrent, done: boolean): void => {
  const out = process.stderr;
  let line = formatProgressLine(torrent);
  const cols = out.columns ?? 80;
  if (line.length >= cols) {
    line = `${line.slice(0, Math.max(1, cols - 1))}`;
  }
  // Erase full line then return to column 0 (more reliable than \r alone when
  // the previous render wrapped in a narrow panel).
  out.write(`\u001b[2K\r${line}`);
  if (done) {
    out.write("\n");
  }
};

/**
 * Download via WebTorrent from a magnet URI or http(s) .torrent URL
 * (no trust in WebTorrent's piece checks).
 * Caller should run {@link verifyTorrentContent} on the result.
 */
export const downloadTorrent = async (
  source: string,
  opts: { downloadDir: string }
): Promise<TorrentDownload> => {
  console.log(`fetching torrent metainfo from ${source}`);
  const { addArg, expectedInfoHash } = await resolveTorrentSource(source);
  console.log(`infohash ${expectedInfoHash}`);
  await fs.mkdir(opts.downloadDir, { recursive: true });

  const client = new WebTorrent() as unknown as WebTorrentClient;
  try {
    const torrent = client.add(addArg, {
      path: opts.downloadDir,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(progressTimer);
        writeProgress(torrent, true);
        if (err !== undefined) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      };

      const onError = (err: unknown): void => {
        finish(err);
      };

      writeProgress(torrent, false);
      const progressTimer = setInterval(() => {
        writeProgress(torrent, false);
      }, 500);

      client.on("error", onError);
      torrent.on("error", onError);
      torrent.on("done", () => {
        finish();
      });
    });

    if (!isRecord(torrent.info)) {
      throw new Error("WebTorrent did not provide an info dict");
    }

    const filePaths = torrent.files.map((file) =>
      path.resolve(torrent.path, file.path)
    );

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const file = torrent.files[i];
      if (filePath === undefined || file === undefined) {
        throw new Error("internal error: missing torrent file entry");
      }
      const st = await fs.stat(filePath);
      if (st.size !== file.length) {
        throw new Error(
          `downloaded size mismatch for ${filePath}: got ${st.size}, expected ${file.length}`
        );
      }
    }

    return {
      expectedInfoHash,
      info: torrent.info,
      filePaths,
      downloadDir: opts.downloadDir,
    };
  } finally {
    await destroyClient(client);
  }
};

/** Alias kept for call sites that still say "magnet". */
export const downloadMagnet = downloadTorrent;
