#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectSome, DEFAULT_SERVERS, type ElectrumClient } from "./lib/electrum.ts";
import {
  CHECKPOINT,
  HeaderStore,
  syncHeaders,
  verifyCheckpoint,
} from "./lib/headers.ts";
import { hashFile, isBitcoinLeaf, isPendingLeaf, parseOts } from "./lib/ots.ts";
import { errorMessage } from "./lib/util.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

type Command = "verify" | "checkpoint";

type CliArgs = {
  cache: string;
  command: Command;
  file: string;
  help: boolean;
};

const usage = (): void => {
  console.error(`Usage:
  npx tsx verify.ts [--cache DIR] <file>
  npx tsx verify.ts checkpoint

<file>     Hash <file>, parse <file>.ots, sync headers from the Sept 2024
           checkpoint, and verify the Merkle path against that chain.

checkpoint Walk every header from genesis to the checkpoint, check proof of
           work, and confirm the hardcoded checkpoint hash. Does not store
           the pre-checkpoint chain.
`);
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    cache: path.join(here, "cache"),
    command: "verify",
    file: "my_file",
    help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--cache") {
      const dir = argv[i + 1];
      if (dir === undefined) {
        throw new Error("--cache requires a directory");
      }
      args.cache = dir;
      i += 1;
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else {
      rest.push(a);
    }
  }
  const first = rest[0];
  if (first === "checkpoint") args.command = "checkpoint";
  else if (first !== undefined) args.file = first;
  return args;
};

const formatTime = (unix: number): string =>
  new Date(unix * 1000).toISOString().replace(".000Z", "Z");

const withClients = async <T>(
  fn: (clients: ElectrumClient[]) => Promise<T>
): Promise<T> => {
  const clients = await connectSome(DEFAULT_SERVERS, {
    min: 2,
    timeoutMs: 120_000,
  });
  console.error(`connected to ${clients.length} Electrum server(s)`);
  try {
    return await fn(clients);
  } finally {
    for (const c of clients) c.close();
  }
};

const cmdCheckpoint = async (): Promise<void> => {
  const result = await withClients((clients) => verifyCheckpoint(clients));
  console.log(
    `Checkpoint is real: block ${result.height} ${result.hash} at ${formatTime(result.time)}`
  );
};

const cmdVerify = async (args: CliArgs): Promise<void> => {
  const filePath = path.resolve(args.file);
  const otsPath = `${filePath}.ots`;
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing file: ${filePath}`);
  }
  if (!fs.existsSync(otsPath)) {
    throw new Error(`missing proof: ${otsPath}`);
  }

  const ots = parseOts(fs.readFileSync(otsPath));
  const fileDigest = hashFile(filePath, ots.hashName);
  console.log(
    `${ots.hashName}(${path.basename(filePath)}) = ${fileDigest.toString("hex")}`
  );
  console.log(`ots file digest                 = ${ots.fileDigest.toString("hex")}`);
  if (!fileDigest.equals(ots.fileDigest)) {
    console.log("FAIL: file hash does not match the digest in the .ots proof");
    process.exit(1);
  }

  const bitcoinAttestations = ots.attestations.filter(isBitcoinLeaf);
  if (bitcoinAttestations.length === 0) {
    const pending = ots.attestations.filter(isPendingLeaf);
    if (pending.length > 0) {
      console.log("FAIL: proof is not complete (pending calendar attestation only)");
      for (const p of pending) console.log(`  calendar: ${p.attestation.uri}`);
    } else {
      console.log("FAIL: no Bitcoin block-header attestation in the proof");
    }
    process.exit(1);
  }

  for (const { attestation } of bitcoinAttestations) {
    if (attestation.height < CHECKPOINT.height) {
      console.log(
        `FAIL: attestation at height ${attestation.height} is before checkpoint ${CHECKPOINT.height}`
      );
      process.exit(1);
    }
  }

  const store = new HeaderStore(args.cache);
  const chain = await withClients((clients) => syncHeaders(store, clients));

  let best: { height: number; time: number; hash: string } | null = null;
  for (const { msg, attestation } of bitcoinAttestations) {
    const header = chain.at(attestation.height);
    const match = msg.equals(header.merkleRoot);
    const line = match
      ? `OK  Bitcoin block ${attestation.height} merkle root matches`
      : `FAIL Bitcoin block ${attestation.height}: proof root ${msg.toString("hex")} != header ${header.merkleRoot.toString("hex")}`;
    console.log(line);
    if (match && (best === null || attestation.height < best.height)) {
      best = { height: attestation.height, time: header.time, hash: header.id };
    }
  }

  if (best === null) {
    console.log("Verification failed.");
    process.exit(1);
  }

  console.log(
    `Success! Bitcoin block ${best.height} (${best.hash}) attests the file existed as of ${formatTime(best.time)}`
  );
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (args.command === "checkpoint") await cmdCheckpoint();
  else await cmdVerify(args);
};

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
