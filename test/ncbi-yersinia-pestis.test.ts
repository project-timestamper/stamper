import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { lookupCollection } from "../lib/collections.ts"
import { PAGES_BASE } from "../lib/fetch.ts"
import { attestDigest, digestHttpWork } from "../lib/work.ts"

/** Yersinia pestis CO92 genomic FASTA (gzipped) from NCBI RefSeq. */
const YERSINIA_PESTIS_URL =
  "https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/009/065/GCF_000009065.1_ASM906v1/GCF_000009065.1_ASM906v1_genomic.fna.gz"

/** SHA-256 of the gunzipped FASTA (also in ncbi_genomes/E95). */
const EXPECTED_SHA256 =
  "e9530e18294fd1bc36b4e66f8af576274fe6d4d7cc0b5277449fbd9b93ba8990"

const here = path.dirname(fileURLToPath(import.meta.url))
const cacheDir = path.join(here, "cache")

test(
  "NCBI Yersinia pestis genome is attested in ncbi_genomes",
  { timeout: 300_000 },
  async () => {
    const meta = lookupCollection("ncbi_genomes")
    assert.equal(meta.hashName, "sha256")
    assert.equal(meta.hashBytes, 32)
    assert.equal(meta.prefixHexDigits, 3)
    assert.equal(meta.gunzipBeforeHash, true)

    const { digest, gunzipped } = await digestHttpWork(
      YERSINIA_PESTIS_URL,
      meta
    )
    assert.equal(gunzipped, true)
    assert.equal(digest.toString("hex"), EXPECTED_SHA256)

    const { prefix, attestation } = await attestDigest({
      digest,
      baseUrl: `${PAGES_BASE}/ncbi_genomes`,
      meta,
      cacheDir,
    })
    assert.equal(prefix, "E95")
    assert.ok(attestation.height > 0)
    assert.match(attestation.hash, /^[0-9a-f]{64}$/)
    assert.ok(attestation.time > 0)
  }
)
