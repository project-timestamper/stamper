import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckpoint } from "./lib/headers.ts";
import { errorMessage } from "./lib/util.ts";
import {
  formatTime,
  verifyDetachedOts,
  withClients,
} from "./lib/verify-ots.ts";

const HASH_BYTES = 32;
const PREFIX_HEX_DIGITS = 2;
const DEFAULT_COLLECTION = path.join(
  os.homedir(),
  "timestamper",
  "docs",
  "wikiart_works"
);

const here = path.dirname(fileURLToPath(import.meta.url));

type Command = "checkpoint" | "hashlist" | "work";

type CliArgs = {
  cache: string;
  collectionDir: string;
  command: Command;
  target: string;
  help: boolean;
};

const usage = (): void => {
  console.error(`Usage:
  npx tsx verify.ts [--cache DIR] <hashlist>
  npx tsx verify.ts [--cache DIR] [--collection DIR] <url>
  npx tsx verify.ts checkpoint

<hashlist>  Verify a Project Timestamper hash list file against <hashlist>.ots.

<url>       Download a work (e.g. a WikiArt painting), SHA-256 it, find it in
            ~/timestamper/docs/wikiart_works/$PREFIX, then verify PREFIX.ots.

checkpoint  Walk every header from genesis to the SPV checkpoint.
`);
};

const isUrl = (value: string): boolean =>
  value.startsWith("https://") || value.startsWith("http://");

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    cache: path.join(here, "cache"),
    collectionDir: DEFAULT_COLLECTION,
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
      const dir = argv[i + 1];
      if (dir === undefined) {
        throw new Error("--collection requires a directory");
      }
      args.collectionDir = dir;
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
    args.command = isUrl(first) ? "work" : "hashlist";
  }
  return args;
};

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url, {
    headers: { "user-agent": "stamper/0.1 (Project Timestamper verifier)" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const hashListContains = (list: Buffer, digest: Buffer): boolean => {
  if (digest.length !== HASH_BYTES) {
    throw new Error(`expected ${HASH_BYTES}-byte digest`);
  }
  if (list.length % HASH_BYTES !== 0) {
    throw new Error(
      `hash list length ${list.length} is not a multiple of ${HASH_BYTES}`
    );
  }
  for (let offset = 0; offset < list.length; offset += HASH_BYTES) {
    if (list.subarray(offset, offset + HASH_BYTES).equals(digest)) {
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

const cmdWork = async (args: CliArgs): Promise<void> => {
  console.log(`downloading ${args.target}`);
  const bytes = await download(args.target);
  const digest = createHash("sha256").update(bytes).digest();
  const hex = digest.toString("hex");
  const prefix = hex.slice(0, PREFIX_HEX_DIGITS).toUpperCase();
  console.log(`sha256 = ${hex}`);
  console.log(`prefix = ${prefix}`);

  const listPath = path.join(args.collectionDir, prefix);
  const otsPath = `${listPath}.ots`;
  if (!fs.existsSync(listPath)) {
    throw new Error(`missing hash list: ${listPath}`);
  }
  const list = fs.readFileSync(listPath);
  if (!hashListContains(list, digest)) {
    throw new Error(`digest not found in ${listPath}`);
  }
  console.log(`digest found in ${listPath} (${list.length / HASH_BYTES} hashes)`);

  const best = await verifyDetachedOts({
    filePath: listPath,
    otsPath,
    cacheDir: args.cache,
  });
  console.log(
    `Success! The work's SHA-256 is in ${prefix}, and Bitcoin block ${best.height} (${best.hash}) attests that hash list existed as of ${formatTime(best.time)}`
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

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
