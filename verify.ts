import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COLLECTION,
  collectionNames,
} from "./lib/collections.ts";
import { verifyCheckpoint } from "./lib/headers.ts";
import { errorMessage } from "./lib/util.ts";
import {
  formatTime,
  verifyDetachedOts,
  withClients,
} from "./lib/verify-ots.ts";
import {
  attestDigest,
  digestWork,
  isTorrentWorkTarget,
  isWorkTarget,
  resolveCollection,
} from "./lib/work.ts";

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

const cmdWork = async (args: CliArgs): Promise<void> => {
  const { name, baseUrl, meta } = resolveCollection(args.collection);
  console.log(
    `collection ${name}: ${meta.hashName}, ${meta.hashBytes} bytes/hash, prefix ${meta.prefixHexDigits} hex digits`
  );

  if (isTorrentWorkTarget(args.target, meta)) {
    console.log(
      `downloading torrent content via WebTorrent -> ${path.join(args.cache, "torrents")}`
    );
  } else {
    console.log(`downloading ${args.target}`);
  }

  const digested = await digestWork(args.target, meta, {
    cacheDir: args.cache,
    collectionName: name,
  });
  if (digested.kind === "torrent") {
    console.log(
      `torrent content matches infohash ${digested.digest.toString("hex")}`
    );
  } else if (digested.gunzipped) {
    console.log(
      `gunzipped ${digested.downloadedBytes} -> ${digested.hashedBytes} bytes before hashing`
    );
  }

  const hex = digested.digest.toString("hex");
  console.log(`${meta.hashName} = ${hex}`);

  console.log(`fetching hash list for prefix...`);
  const { prefix, listUrl, hashCount, attestation } = await attestDigest({
    digest: digested.digest,
    baseUrl,
    meta,
    cacheDir: args.cache,
  });
  console.log(`prefix = ${prefix}`);
  console.log(
    `digest found in ${listUrl} (found among ${hashCount} hashes)`
  );
  console.log(
    `Success! The work's ${meta.hashName} is in ${prefix}, and Bitcoin block ${attestation.height} (${attestation.hash}) attests that hash list existed as of ${formatTime(attestation.time)}`
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
