import path from "node:path";
import fs from "node:fs";
import { connectSome, DEFAULT_SERVERS, type ElectrumClient } from "./electrum.ts";
import { CHECKPOINT, HeaderStore, syncHeaders } from "./headers.ts";
import { hashFile, isBitcoinLeaf, isPendingLeaf, parseOts } from "./ots.ts";

export type OtsVerifySuccess = {
  height: number;
  hash: string;
  time: number;
};

export const formatTime = (unix: number): string =>
  new Date(unix * 1000).toISOString().replace(".000Z", "Z");

export const withClients = async <T>(
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
    for (const client of clients) client.close();
  }
};

export const verifyDetachedOts = async ({
  filePath,
  otsPath = `${filePath}.ots`,
  cacheDir,
}: {
  filePath: string;
  otsPath?: string;
  cacheDir: string;
}): Promise<OtsVerifySuccess> => {
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
    throw new Error("file hash does not match the digest in the .ots proof");
  }

  const bitcoinAttestations = ots.attestations.filter(isBitcoinLeaf);
  if (bitcoinAttestations.length === 0) {
    const pending = ots.attestations.filter(isPendingLeaf);
    if (pending.length > 0) {
      const calendars = pending
        .map((leaf) => `  calendar: ${leaf.attestation.uri}`)
        .join("\n");
      throw new Error(
        `proof is not complete (pending calendar attestation only)\n${calendars}`
      );
    }
    throw new Error("no Bitcoin block-header attestation in the proof");
  }

  for (const { attestation } of bitcoinAttestations) {
    if (attestation.height < CHECKPOINT.height) {
      throw new Error(
        `attestation at height ${attestation.height} is before checkpoint ${CHECKPOINT.height}`
      );
    }
  }

  const store = new HeaderStore(cacheDir);
  const chain = await withClients((clients) => syncHeaders(store, clients));

  let best: OtsVerifySuccess | null = null;
  for (const { msg, attestation } of bitcoinAttestations) {
    const header = chain.at(attestation.height);
    const match = msg.equals(header.merkleRoot);
    if (match) {
      console.log(`OK  Bitcoin block ${attestation.height} merkle root matches`);
      if (best === null || attestation.height < best.height) {
        best = {
          height: attestation.height,
          time: header.time,
          hash: header.id,
        };
      }
    } else {
      console.log(
        `FAIL Bitcoin block ${attestation.height}: proof root ${msg.toString("hex")} != header ${header.merkleRoot.toString("hex")}`
      );
    }
  }

  if (best === null) {
    throw new Error("OpenTimestamps verification failed");
  }
  return best;
};
