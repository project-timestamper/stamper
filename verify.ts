import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  DEFAULT_COLLECTION,
  collectionNames,
  lookupCollection,
  type CollectionMeta,
} from "./lib/collections.ts";
import { verifyCheckpoint } from "./lib/headers.ts";
import {
  downloadTorrent,
  isHttpUrl,
  isMagnetUri,
  verifyTorrentContent,
} from "./lib/torrent.ts";
import { errorMessage } from "./lib/util.ts";
import {
  formatTime,
  verifyDetachedOts,
  withClients,
} from "./lib/verify-ots.ts";

const PAGES_BASE = "https://project-timestamper.github.io/timestamper";

const here = path.dirname(fileURLToPath(import.meta.url));

type Command = "checkpoint" | "hashlist" | "work";

type CliArgs = {
  cache: string;
  collection: string;
  command: Command;
  target: string;
  help: boolean;
};

const usage = (): void => {
  console.error(`Usage:
  npx tsx verify.ts [--cache DIR] <hashlist>
  npx tsx verify.ts [--cache DIR] [--collection NAME] <url|magnet|.torrent-url>
  npx tsx verify.ts checkpoint

<hashlist>  Verify a Project Timestamper hash list file against <hashlist>.ots.

<url>       Download a work, digest it with the collection hash algorithm,
            find it in project-timestamper.github.io/timestamper/$COLLECTION/$PREFIX,
            then verify PREFIX.ots. Default collection is ${DEFAULT_COLLECTION}.

<magnet> / <.torrent-url>
            For torrent collections (yts_movies, tpb_movies): download via
            WebTorrent from a magnet or an http(s) .torrent URL, verify
            infohash + piece hashes, then look up the infohash in the collection.

            Collections: ${collectionNames().join(", ")}.

checkpoint  Walk every header from genesis to the SPV checkpoint.
`);
};

const isWorkTarget = (value: string): boolean =>
  isHttpUrl(value) || isMagnetUri(value);

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    cache: path.join(here, "cache"),
    collection: DEFAULT_COLLECTION,
    command: "hashlist",
    target: "my_file",
    help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) {
      continue;
    }
    if (a === "--cache") {
      const dir = argv[i + 1];
      if (dir === undefined) {
        throw new Error("--cache requires a directory");
      }
      args.cache = dir;
      i += 1;
    } else if (a === "--collection") {
      const name = argv[i + 1];
      if (name === undefined) {
        throw new Error("--collection requires a name or URL");
      }
      args.collection = name;
      i += 1;
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else {
      rest.push(a);
    }
  }
  const first = rest[0];
  if (first === "checkpoint") {
    args.command = "checkpoint";
  } else if (first !== undefined) {
    args.target = first;
    args.command = isWorkTarget(first) ? "work" : "hashlist";
  }
  return args;
};

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url, {
    headers: { "user-agent": "stamper/0.1 (Project Timestamper verifier)" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`);
  }
  return Buffer.from(await response.arrayBuffer());
};

/** Resolve collection name (for metadata) and fetch base URL. */
const resolveCollection = (
  collection: string
): { name: string; baseUrl: string; meta: CollectionMeta } => {
  if (isHttpUrl(collection)) {
    const baseUrl = collection.replace(/\/$/, "");
    const name = baseUrl.split("/").pop();
    if (name === undefined || name === "") {
      throw new Error(`could not derive collection name from URL: ${collection}`);
    }
    return { name, baseUrl, meta: lookupCollection(name) };
  }
  return {
    name: collection,
    baseUrl: `${PAGES_BASE}/${collection}`,
    meta: lookupCollection(collection),
  };
};

const hashListContains = (
  list: Buffer,
  digest: Buffer,
  hashBytes: number
): boolean => {
  if (digest.length !== hashBytes) {
    throw new Error(`expected ${hashBytes}-byte digest`);
  }
  if (list.length % hashBytes !== 0) {
    throw new Error(
      `hash list length ${list.length} is not a multiple of ${hashBytes}`
    );
  }
  for (let offset = 0; offset < list.length; offset += hashBytes) {
    if (list.subarray(offset, offset + hashBytes).equals(digest)) {
      return true;
    }
  }
  return false;
};

const cmdCheckpoint = async (): Promise<void> => {
  const result = await withClients((clients) => verifyCheckpoint(clients));
  console.log(
    `Checkpoint is real: block ${result.height} ${result.hash} at ${formatTime(result.time)}`
  );
};

const cmdHashlist = async (args: CliArgs): Promise<void> => {
  const filePath = path.resolve(args.target);
  const best = await verifyDetachedOts({
    filePath,
    cacheDir: args.cache,
  });
  console.log(
    `Success! Bitcoin block ${best.height} (${best.hash}) attests the hash list existed as of ${formatTime(best.time)}`
  );
};

const isTorrentCollection = (meta: CollectionMeta): boolean =>
  meta.hashName === "sha1" && meta.hashBytes === 20;

const digestWork = async (
  args: CliArgs,
  meta: CollectionMeta
): Promise<Buffer> => {
  const torrentSource =
    isMagnetUri(args.target) ||
    (isTorrentCollection(meta) && isHttpUrl(args.target));

  if (torrentSource) {
    if (!isTorrentCollection(meta)) {
      throw new Error(
        `magnet/.torrent URLs require a torrent infohash collection (sha1, 20 bytes); got ${args.collection} (${meta.hashName}, ${meta.hashBytes} bytes)`
      );
    }
    const downloadDir = path.join(args.cache, "torrents");
    console.log(`downloading torrent content via WebTorrent -> ${downloadDir}`);
    const downloaded = await downloadTorrent(args.target, { downloadDir });
    console.log(`verifying infohash and piece hashes`);
    const { infoHash } = await verifyTorrentContent({
      info: downloaded.info,
      expectedInfoHash: downloaded.expectedInfoHash,
      filePaths: downloaded.filePaths,
    });
    console.log(`torrent content matches infohash ${infoHash.toString("hex")}`);
    return infoHash;
  }

  console.log(`downloading ${args.target}`);
  const bytes = await download(args.target);
  const payload = meta.gunzipBeforeHash ? gunzipSync(bytes) : bytes;
  if (meta.gunzipBeforeHash) {
    console.log(
      `gunzipped ${bytes.length} -> ${payload.length} bytes before hashing`
    );
  }
  return createHash(meta.hashName).update(payload).digest();
};

const cmdWork = async (args: CliArgs): Promise<void> => {
  const { name, baseUrl, meta } = resolveCollection(args.collection);
  console.log(
    `collection ${name}: ${meta.hashName}, ${meta.hashBytes} bytes/hash, prefix ${meta.prefixHexDigits} hex digits`
  );
  const digest = await digestWork(args, meta);
  if (digest.length !== meta.hashBytes) {
    throw new Error(
      `digest length ${digest.length} does not match collection ${meta.hashBytes}`
    );
  }
  const hex = digest.toString("hex");
  const prefix = hex.slice(0, meta.prefixHexDigits).toUpperCase();
  console.log(`${meta.hashName} = ${hex}`);
  console.log(`prefix = ${prefix}`);

  const listUrl = `${baseUrl}/${prefix}`;
  const otsUrl = `${listUrl}.ots`;
  console.log(`fetching ${listUrl}`);
  const list = await download(listUrl);
  if (!hashListContains(list, digest, meta.hashBytes)) {
    throw new Error(`digest not found in ${listUrl}`);
  }
  console.log(
    `digest found in ${listUrl} (found among ${list.length / meta.hashBytes} hashes)`
  );
  console.log(`fetching ${otsUrl}`);
  const otsBytes = await download(otsUrl);

  const best = await verifyDetachedOts({
    fileBytes: list,
    otsBytes,
    label: prefix,
    cacheDir: args.cache,
  });
  console.log(
    `Success! The work's ${meta.hashName} is in ${prefix}, and Bitcoin block ${best.height} (${best.hash}) attests that hash list existed as of ${formatTime(best.time)}`
  );
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (args.command === "checkpoint") {
    await cmdCheckpoint();
  } else if (args.command === "work") {
    await cmdWork(args);
  } else {
    await cmdHashlist(args);
  }
};

main()
  .then(() => {
    // WebTorrent/Electrum can leave sockets that keep the event loop alive.
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
