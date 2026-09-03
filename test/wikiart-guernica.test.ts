import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lookupCollection } from "../lib/collections.ts";
import { verifyDetachedOts } from "../lib/verify-ots.ts";

const GUERNICA_URL =
  "https://uploads0.wikiart.org/00139/images/pablo-picasso/guernica-by-pablo-picasso.jpg";

/** Known SHA-256 of the WikiArt Guernica JPEG above (also in wikiart_works/2F). */
const EXPECTED_SHA256 =
  "2f29e8b37c2c6ffc5ea1d1acf3fcbe712455b861d96faf4ced159f9ef118773d";

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
  "wikiart Guernica JPEG is attested in wikiart_works",
  { timeout: 300_000 },
  async () => {
    const meta = lookupCollection("wikiart_works");
    assert.equal(meta.hashName, "sha256");
    assert.equal(meta.hashBytes, HASH_BYTES);
    assert.equal(meta.prefixHexDigits, 2);

    const bytes = await download(GUERNICA_URL);
    const digest = createHash("sha256").update(bytes).digest();
    assert.equal(digest.toString("hex"), EXPECTED_SHA256);

    const prefix = EXPECTED_SHA256.slice(0, meta.prefixHexDigits).toUpperCase();
    assert.equal(prefix, "2F");

    const listUrl = `${PAGES_BASE}/wikiart_works/${prefix}`;
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
