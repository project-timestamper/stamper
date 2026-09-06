import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { lookupCollection } from "../lib/collections.ts"
import { PAGES_BASE } from "../lib/fetch.ts"
import { attestDigest, digestHttpWork } from "../lib/work.ts"

const GUERNICA_URL =
  "https://uploads0.wikiart.org/00139/images/pablo-picasso/guernica-by-pablo-picasso.jpg"

/** Known SHA-256 of the WikiArt Guernica JPEG above (also in wikiart_works/2F). */
const EXPECTED_SHA256 =
  "2f29e8b37c2c6ffc5ea1d1acf3fcbe712455b861d96faf4ced159f9ef118773d"

const here = path.dirname(fileURLToPath(import.meta.url))
const cacheDir = path.join(here, "cache")

test(
  "wikiart Guernica JPEG is attested in wikiart_works",
  { timeout: 300_000 },
  async () => {
    const meta = lookupCollection("wikiart_works")
    assert.equal(meta.hashName, "sha256")
    assert.equal(meta.hashBytes, 32)
    assert.equal(meta.prefixHexDigits, 2)

    const { digest } = await digestHttpWork(GUERNICA_URL, meta)
    assert.equal(digest.toString("hex"), EXPECTED_SHA256)

    const { prefix, attestation } = await attestDigest({
      digest,
      baseUrl: `${PAGES_BASE}/wikiart_works`,
      meta,
      cacheDir,
    })
    assert.equal(prefix, "2F")
    assert.ok(attestation.height > 0)
    assert.match(attestation.hash, /^[0-9a-f]{64}$/)
    assert.ok(attestation.time > 0)
  }
)
