import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lookupCollection } from "../lib/collections.ts";
import { PAGES_BASE } from "../lib/fetch.ts";
import { attestDigest, digestHttpWork } from "../lib/work.ts";

/** Schroedinger 1926 Annalen der Physik paper from Sci-Hub mirror. */
const SCHROEDINGER_URL =
  "https://sci.bban.top/pdf/10.1002/andp.19263851302.pdf";

/** Known MD5 of the PDF above (also in scihub_articles/8E02). */
const EXPECTED_MD5 = "8e02ac5ef08a7d7613b1cb151ad0bc22";

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, "cache");

test(
  "Sci-Hub Schroedinger PDF is attested in scihub_articles",
  { timeout: 300_000 },
  async () => {
    const meta = lookupCollection("scihub_articles");
    assert.equal(meta.hashName, "md5");
    assert.equal(meta.hashBytes, 16);
    assert.equal(meta.prefixHexDigits, 4);

    const { digest } = await digestHttpWork(SCHROEDINGER_URL, meta);
    assert.equal(digest.toString("hex"), EXPECTED_MD5);

    const { prefix, attestation } = await attestDigest({
      digest,
      baseUrl: `${PAGES_BASE}/scihub_articles`,
      meta,
      cacheDir,
    });
    assert.equal(prefix, "8E02");
    assert.ok(attestation.height > 0);
    assert.match(attestation.hash, /^[0-9a-f]{64}$/);
    assert.ok(attestation.time > 0);
  }
);
