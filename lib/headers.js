import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HEADER_SIZE = 80;
export const RETARGET_INTERVAL = 2016;
export const TARGET_TIMESPAN = 14 * 24 * 60 * 60;
export const MAX_BITS = 0x1d00ffff;
export const GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

/** Last difficulty retarget before September 2024. */
export const CHECKPOINT = {
  height: 858816,
  hash: "00000000000000000000fcddd3a12dff20bb1a246e073b3d7caccb0453e24ac2",
};

export const compactToTarget = (bits) => {
  const exp = bits >>> 24;
  const mant = bits & 0x007fffff;
  if (exp <= 3) {
    return BigInt(mant) >> BigInt(8 * (3 - exp));
  }
  return BigInt(mant) << BigInt(8 * (exp - 3));
};

const MAX_TARGET = compactToTarget(MAX_BITS);

export const doubleSha256 = (buf) =>
  createHash("sha256")
    .update(createHash("sha256").update(buf).digest())
    .digest();

export const hashToId = (hashLe) => Buffer.from(hashLe).reverse().toString("hex");

export const targetToCompact = (target) => {
  if (target === 0n) return 0;
  let hex = target.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let size = hex.length / 2;
  let compact;
  if (size <= 3) {
    compact = Number(target) << (8 * (3 - size));
  } else {
    compact = Number(target >> BigInt(8 * (size - 3)));
  }
  if (compact & 0x00800000) {
    compact >>= 8;
    size += 1;
  }
  return (size << 24) | compact;
}

export const parseHeader = (buf, offset = 0) => {
  const raw = buf.subarray(offset, offset + HEADER_SIZE);
  if (raw.length !== HEADER_SIZE) {
    throw new Error("truncated header");
  }
  const hash = doubleSha256(raw);
  return {
    raw: Buffer.from(raw),
    version: raw.readUInt32LE(0),
    prevHash: Buffer.from(raw.subarray(4, 36)),
    merkleRoot: Buffer.from(raw.subarray(36, 68)),
    time: raw.readUInt32LE(68),
    bits: raw.readUInt32LE(72),
    nonce: raw.readUInt32LE(76),
    hash,
    id: hashToId(hash),
  };
}

const hashAsInt = (hashLe) => BigInt("0x" + hashToId(hashLe));

const retargetBits = (first, last) => {
  let timespan = last.time - first.time;
  const min = Math.floor(TARGET_TIMESPAN / 4);
  const max = TARGET_TIMESPAN * 4;
  if (timespan < min) timespan = min;
  if (timespan > max) timespan = max;
  let next =
    (compactToTarget(first.bits) * BigInt(timespan)) / BigInt(TARGET_TIMESPAN);
  if (next > MAX_TARGET) next = MAX_TARGET;
  return targetToCompact(next);
}

export const verifyHeader = (header, height, prev, lookup) => {
  if (hashAsInt(header.hash) > compactToTarget(header.bits)) {
    throw new Error(`insufficient proof of work at height ${height}`);
  }
  if (height === 0) {
    if (header.id !== GENESIS_HASH) {
      throw new Error(`bad genesis hash ${header.id}`);
    }
    return;
  }
  if (!prev) {
    if (height === CHECKPOINT.height) {
      if (header.id !== CHECKPOINT.hash) {
        throw new Error(
          `checkpoint mismatch: ${header.id} != ${CHECKPOINT.hash}`
        );
      }
      return;
    }
    throw new Error(`missing previous header at height ${height}`);
  }
  if (!header.prevHash.equals(prev.hash)) {
    throw new Error(`prev-hash mismatch at height ${height}`);
  }
  if (height % RETARGET_INTERVAL !== 0) {
    if (header.bits !== prev.bits) {
      throw new Error(`difficulty mismatch at height ${height}`);
    }
    return;
  }
  const first = lookup(height - RETARGET_INTERVAL);
  if (!first) {
    return;
  }
  const want = retargetBits(first, prev);
  if (compactToTarget(header.bits) !== compactToTarget(want)) {
    throw new Error(`difficulty mismatch at height ${height}`);
  }
}

export class HeaderChain {
  constructor(buf, startHeight) {
    this.buf = buf;
    this.startHeight = startHeight;
  }

  get count() {
    return this.buf.length / HEADER_SIZE;
  }

  get tipHeight() {
    return this.count === 0 ? this.startHeight - 1 : this.startHeight + this.count - 1;
  }

  at(height) {
    const index = height - this.startHeight;
    const offset = index * HEADER_SIZE;
    if (index < 0 || offset + HEADER_SIZE > this.buf.length) {
      throw new Error(`header ${height} not in local chain`);
    }
    return parseHeader(this.buf, offset);
  }

  verifyRange(fromHeight, toHeight) {
    if (!Number.isInteger(this.count)) {
      throw new Error("header cache is not a multiple of 80 bytes");
    }
    for (let height = fromHeight; height <= toHeight; height++) {
      const header = this.at(height);
      const prev = height > this.startHeight ? this.at(height - 1) : null;
      verifyHeader(header, height, prev, (h) => {
        if (h < this.startHeight) return null;
        return this.at(h);
      });
      if (height === CHECKPOINT.height && header.id !== CHECKPOINT.hash) {
        throw new Error(
          `checkpoint mismatch at ${height}: ${header.id} != ${CHECKPOINT.hash}`
        );
      }
    }
  }
}

export const headerAt = (chain, height, startHeight = CHECKPOINT.height) => {
  if (chain instanceof HeaderChain) return chain.at(height);
  return new HeaderChain(chain, startHeight).at(height);
};

const headersFromRaw = (raw, count) => {
  const got = Math.min(count, Math.floor(raw.length / HEADER_SIZE));
  if (got <= 0) throw new Error("server returned no headers");
  return raw.subarray(0, got * HEADER_SIZE);
}

export class HeaderStore {
  constructor(dir) {
    this.dir = dir;
    this.binPath = path.join(dir, "headers.bin");
    this.metaPath = path.join(dir, "meta.json");
  }

  load() {
    if (!fs.existsSync(this.binPath)) {
      return new HeaderChain(Buffer.alloc(0), CHECKPOINT.height);
    }
    let buf = fs.readFileSync(this.binPath);
    const first = parseHeader(buf, 0);
    if (first.id === CHECKPOINT.hash) {
      return new HeaderChain(buf, CHECKPOINT.height);
    }
    if (first.id === GENESIS_HASH) {
      const offset = CHECKPOINT.height * HEADER_SIZE;
      if (buf.length < offset + HEADER_SIZE) {
        throw new Error(
          "cache looks like a genesis chain but does not reach the checkpoint"
        );
      }
      const cp = parseHeader(buf, offset);
      if (cp.id !== CHECKPOINT.hash) {
        throw new Error("genesis cache does not contain the expected checkpoint");
      }
      buf = Buffer.from(buf.subarray(offset));
      fs.writeFileSync(this.binPath, buf);
      return new HeaderChain(buf, CHECKPOINT.height);
    }
    throw new Error(
      `unexpected first header ${first.id}; delete ${this.binPath} and re-sync`
    );
  }

  append(piece) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.binPath, piece);
  }

  writeMeta(chain) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tip = chain.count ? chain.at(chain.tipHeight) : null;
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify(
        {
          startHeight: chain.startHeight,
          count: chain.count,
          checkpoint: CHECKPOINT,
          tipHash: tip?.id ?? null,
          tipTime: tip?.time ?? null,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }
}

const downloadRange = async (client, fromHeight, toHeight, onHeaders, { log }) => {
  let height = fromHeight;
  let chunkSize = 2016;
  while (height <= toHeight) {
    const remaining = toHeight - height + 1;
    const { raw, count, max } = await client.getHeaders(
      height,
      Math.min(chunkSize, remaining)
    );
    const piece = headersFromRaw(raw, count);
    const got = piece.length / HEADER_SIZE;
    onHeaders(piece, height, got);
    height += got;
    chunkSize = max || chunkSize;
    if (height % (chunkSize * 10) < got || height > toHeight) {
      log(`verified ${height} / ${toHeight + 1} headers`);
    }
  }
}

export const verifyCheckpoint = async (clients, { log = console.error } = {}) => {
  if (clients.length === 0) {
    throw new Error("no Electrum servers");
  }
  const downloader = clients[0];
  log(
    `walking headers from genesis to checkpoint ${CHECKPOINT.height} via ${downloader.label()}`
  );
  log("(this downloads ~70MB once and does not store it)");

  let prev = null;
  const recent = new Map();
  let seen = -1;

  await downloadRange(
    downloader,
    0,
    CHECKPOINT.height,
    (piece, start, got) => {
      for (let i = 0; i < got; i++) {
        const height = start + i;
        const header = parseHeader(piece, i * HEADER_SIZE);
        verifyHeader(header, height, prev, (h) => recent.get(h) ?? null);
        recent.set(height, header);
        recent.delete(height - RETARGET_INTERVAL - 1);
        prev = header;
        seen = height;
      }
    },
    { log }
  );

  if (seen !== CHECKPOINT.height) {
    throw new Error(`stopped at ${seen}, expected ${CHECKPOINT.height}`);
  }
  if (prev.id !== CHECKPOINT.hash) {
    throw new Error(
      `checkpoint hash mismatch: got ${prev.id}, expected ${CHECKPOINT.hash}`
    );
  }

  for (let i = 1; i < clients.length; i++) {
    const peer = clients[i];
    try {
      const { raw } = await peer.getHeaders(CHECKPOINT.height, 1);
      const remote = parseHeader(raw, 0);
      if (remote.id !== CHECKPOINT.hash) {
        throw new Error(`${peer.label()} has ${remote.id}`);
      }
      log(`cross-check OK ${peer.label()} @ ${CHECKPOINT.height}`);
    } catch (err) {
      log(`cross-check ${peer.label()}: ${err.message}`);
      throw err;
    }
  }

  return {
    height: CHECKPOINT.height,
    hash: prev.id,
    time: prev.time,
  };
}

export const syncHeaders = async (store, clients, { log = console.error } = {}) => {
  const tips = [];
  for (const client of clients) {
    try {
      const tip = await client.getTip();
      tips.push({ client, ...tip });
      log(`tip ${client.label()} height=${tip.height}`);
    } catch (err) {
      log(`tip failed ${client.label()}: ${err.message}`);
    }
  }
  if (tips.length === 0) {
    throw new Error("could not read chain tip from any Electrum server");
  }
  tips.sort((a, b) => b.height - a.height);
  const targetHeight = tips[0].height;
  if (targetHeight < CHECKPOINT.height) {
    throw new Error("server tip is below the checkpoint");
  }

  let chain = store.load();
  if (chain.count > 0) {
    log(`cache has ${chain.count} headers from ${chain.startHeight}`);
    chain.verifyRange(chain.tipHeight, chain.tipHeight);
  }

  let have = chain.tipHeight + 1;
  if (have < CHECKPOINT.height) have = CHECKPOINT.height;
  if (have > targetHeight + 1) {
    const keep = (targetHeight - chain.startHeight + 1) * HEADER_SIZE;
    chain = new HeaderChain(Buffer.from(chain.buf.subarray(0, keep)), chain.startHeight);
    fs.writeFileSync(store.binPath, chain.buf);
    have = targetHeight + 1;
  }

  const downloader =
    tips.find((t) => t.height >= targetHeight - 2)?.client ?? tips[0].client;
  log(
    `downloading headers ${have}..${targetHeight} from ${downloader.label()}`
  );

  let buf = chain.buf;
  let len = chain.buf.length;
  const view = () => new HeaderChain(buf.subarray(0, len), CHECKPOINT.height);
  const grow = (piece) => {
    if (len + piece.length > buf.length) {
      const n = Buffer.allocUnsafe(
        Math.max(buf.length * 2, len + piece.length, 1024 * 1024)
      );
      buf.copy(n, 0, 0, len);
      buf = n;
    }
    piece.copy(buf, len);
    len += piece.length;
  }

  if (have <= targetHeight) {
    await downloadRange(
      downloader,
      have,
      targetHeight,
      (piece, start, got) => {
        grow(piece);
        view().verifyRange(start, start + got - 1);
        store.append(piece);
      },
      { log }
    );
  }

  chain = new HeaderChain(Buffer.from(view().buf), CHECKPOINT.height);
  store.writeMeta(chain);

  const checkHeights = [
    CHECKPOINT.height,
    Math.floor((CHECKPOINT.height + targetHeight) / 2),
    targetHeight,
  ].filter((h, i, arr) => arr.indexOf(h) === i);
  for (let i = 1; i < tips.length; i++) {
    const peer = tips[i].client;
    for (const height of checkHeights) {
      try {
        const { raw } = await peer.getHeaders(height, 1);
        const local = chain.at(height);
        const remote = parseHeader(raw, 0);
        if (!local.hash.equals(remote.hash)) {
          throw new Error(
            `${peer.label()} disagrees at height ${height}: ${remote.id} vs ${local.id}`
          );
        }
      } catch (err) {
        log(`cross-check ${peer.label()}@${height}: ${err.message}`);
      }
    }
  }
  return chain;
}
