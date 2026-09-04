import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { lookupCollection } from "../lib/collections.ts";
import { verifyDetachedOts } from "../lib/verify-ots.ts";

/** Yersinia pestis CO92 genomic FASTA (gzipped) from NCBI RefSeq. */
const YERSINIA_PESTIS_URL =
  "https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/009/065/GCF_000009065.1_ASM906v1/GCF_000009065.1_ASM906v1_genomic.fna.gz";

/** SHA-256 of the gunzipped FASTA (also in ncbi_genomes/E95). */
const EXPECTED_SHA256 =
  "e9530e18294fd1bc36b4e66f8af576274fe6d4d7cc0b5277449fbd9b93ba8990";

const PAGES_BASE = "https://project-timestamper.github.io/timestamper";
const HASH_BYTES = 32;

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, "cache");

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url, {
    headers: { "user-agent": "stamper/0.1 (Project Timestamper verifier)" },
    redirect: "follow",
  });
  assert.ok(
    response.ok,
    `download failed: ${response.status} ${response.statusText} (${url})`
  );
  return Buffer.from(await response.arrayBuffer());
};

const hashListContains = (list: Buffer, digest: Buffer): boolean => {
  assert.equal(digest.length, HASH_BYTES);
  assert.equal(list.length % HASH_BYTES, 0);
  for (let offset = 0; offset < list.length; offset += HASH_BYTES) {
    if (list.subarray(offset, offset + HASH_BYTES).equals(digest)) {
      return true;
    }
  }
  return false;
};

test(
  "NCBI Yersinia pestis genome is attested in ncbi_genomes",
  { timeout: 300_000 },
  async () => {
    const meta = lookupCollection("ncbi_genomes");
    assert.equal(meta.hashName, "sha256");
    assert.equal(meta.hashBytes, HASH_BYTES);
    assert.equal(meta.prefixHexDigits, 3);
    assert.equal(meta.gunzipBeforeHash, true);

    const gz = await download(YERSINIA_PESTIS_URL);
    const fasta = gunzipSync(gz);
    const digest = createHash("sha256").update(fasta).digest();
    assert.equal(digest.toString("hex"), EXPECTED_SHA256);

    const prefix = EXPECTED_SHA256.slice(0, meta.prefixHexDigits).toUpperCase();
    assert.equal(prefix, "E95");

    const listUrl = `${PAGES_BASE}/ncbi_genomes/${prefix}`;
    const list = await download(listUrl);
    assert.ok(
      hashListContains(list, digest),
      `digest not found in ${listUrl}`
    );

    const otsBytes = await download(`${listUrl}.ots`);
    const best = await verifyDetachedOts({
      fileBytes: list,
      otsBytes,
      label: prefix,
      cacheDir,
    });

    assert.ok(best.height > 0);
    assert.match(best.hash, /^[0-9a-f]{64}$/);
    assert.ok(best.time > 0);
  }
);
