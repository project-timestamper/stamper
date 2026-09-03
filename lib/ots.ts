import { createHash } from "node:crypto";
import fs from "node:fs";

const MAGIC = Buffer.from(
  "\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94",
  "latin1"
);

const TAG_ATTESTATION = 0x00;
const TAG_FORK = 0xff;
const TAG_APPEND = 0xf0;
const TAG_PREPEND = 0xf1;
const TAG_REVERSE = 0xf2;
const TAG_HEXLIFY = 0xf3;
const TAG_SHA1 = 0x02;
const TAG_RIPEMD160 = 0x03;
const TAG_SHA256 = 0x08;
const TAG_KECCAK256 = 0x67;

const BITCOIN_ATTESTATION_TAG = Buffer.from("0588960d73d71901", "hex");
const PENDING_ATTESTATION_TAG = Buffer.from("83dfe30d2ef90c8e", "hex");

type Cursor = {
  buf: Buffer;
  off: number;
};

export type BitcoinAttestation = {
  type: "bitcoin";
  height: number;
};

export type PendingAttestation = {
  type: "pending";
  uri: string;
};

export type UnknownAttestation = {
  type: "unknown";
  tag: string;
};

export type TimeAttestation =
  | BitcoinAttestation
  | PendingAttestation
  | UnknownAttestation;

export type TimestampLeaf = {
  msg: Buffer;
  attestation: TimeAttestation;
};

export type FileHashName = "sha1" | "ripemd160" | "sha256";

export type OtsProof = {
  fileHashOp: number;
  hashName: FileHashName;
  fileDigest: Buffer;
  attestations: TimestampLeaf[];
};

const cursor = (buf: Buffer): Cursor => ({ buf, off: 0 });

const remaining = (cur: Cursor): number => cur.buf.length - cur.off;

const read = (cur: Cursor, n: number): Buffer => {
  if (cur.off + n > cur.buf.length) {
    throw new Error("unexpected end of OTS file");
  }
  const slice = cur.buf.subarray(cur.off, cur.off + n);
  cur.off += n;
  return slice;
};

const readByte = (cur: Cursor): number => {
  const byte = read(cur, 1)[0];
  if (byte === undefined) {
    throw new Error("unexpected end of OTS file");
  }
  return byte;
};

const readVaruint = (cur: Cursor): number => {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = readByte(cur);
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      return value;
    }
    shift += 7;
    if (shift > 63) {
      throw new Error("varuint too large");
    }
  }
};

const readVarbytes = (cur: Cursor, max = 4096): Buffer => {
  const len = readVaruint(cur);
  if (len > max) {
    throw new Error(`varbytes too long: ${len}`);
  }
  return read(cur, len);
};

const hashNamed = (name: FileHashName, data: Buffer): Buffer =>
  createHash(name).update(data).digest();

const applyOp = (tag: number, cur: Cursor, msg: Buffer): Buffer => {
  switch (tag) {
    case TAG_SHA1:
      return hashNamed("sha1", msg);
    case TAG_RIPEMD160:
      return hashNamed("ripemd160", msg);
    case TAG_SHA256:
      return hashNamed("sha256", msg);
    case TAG_KECCAK256:
      throw new Error("keccak256 operations are not supported");
    case TAG_REVERSE:
      return Buffer.from(msg).reverse();
    case TAG_HEXLIFY:
      return Buffer.from(Buffer.from(msg).toString("hex"), "ascii");
    case TAG_APPEND:
      return Buffer.concat([msg, readVarbytes(cur)]);
    case TAG_PREPEND:
      return Buffer.concat([readVarbytes(cur), msg]);
    default:
      throw new Error(`unknown OTS operation 0x${tag.toString(16)}`);
  }
};

const digestLengthForTag = (tag: number): number => {
  switch (tag) {
    case TAG_SHA1:
    case TAG_RIPEMD160:
      return 20;
    case TAG_SHA256:
    case TAG_KECCAK256:
      return 32;
    default:
      throw new Error(`OTS file hash op is not a hash: 0x${tag.toString(16)}`);
  }
};

const hashNameForTag = (tag: number): FileHashName => {
  switch (tag) {
    case TAG_SHA1:
      return "sha1";
    case TAG_RIPEMD160:
      return "ripemd160";
    case TAG_SHA256:
      return "sha256";
    default:
      throw new Error(`unsupported file hash op 0x${tag.toString(16)}`);
  }
};

const parseAttestation = (cur: Cursor): TimeAttestation => {
  const tag = read(cur, 8);
  const payload = readVarbytes(cur, 8192);
  const body = cursor(payload);
  if (tag.equals(BITCOIN_ATTESTATION_TAG)) {
    return { type: "bitcoin", height: readVaruint(body) };
  }
  if (tag.equals(PENDING_ATTESTATION_TAG)) {
    return { type: "pending", uri: readVarbytes(body, 1000).toString("ascii") };
  }
  return { type: "unknown", tag: tag.toString("hex") };
};

const parseTag = (
  cur: Cursor,
  tag: number,
  msg: Buffer,
  attestations: TimestampLeaf[]
): void => {
  if (tag === TAG_ATTESTATION) {
    attestations.push({ msg, attestation: parseAttestation(cur) });
    return;
  }
  parseTimestamp(cur, applyOp(tag, cur, msg), attestations);
};

const parseTimestamp = (
  cur: Cursor,
  msg: Buffer,
  attestations: TimestampLeaf[]
): void => {
  let tag = readByte(cur);
  while (tag === TAG_FORK) {
    parseTag(cur, readByte(cur), msg, attestations);
    tag = readByte(cur);
  }
  parseTag(cur, tag, msg, attestations);
};

export const parseOts = (buf: Buffer): OtsProof => {
  const cur = cursor(buf);
  const magic = read(cur, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error("not an OpenTimestamps proof (bad magic)");
  }
  const version = readVaruint(cur);
  if (version !== 1) {
    throw new Error(`unsupported OTS version ${version}`);
  }
  const fileHashOp = readByte(cur);
  const digestLen = digestLengthForTag(fileHashOp);
  const fileDigest = Buffer.from(read(cur, digestLen));
  const attestations: TimestampLeaf[] = [];
  parseTimestamp(cur, fileDigest, attestations);
  if (remaining(cur) !== 0) {
    throw new Error("trailing bytes in OTS file");
  }
  return {
    fileHashOp,
    hashName: hashNameForTag(fileHashOp),
    fileDigest,
    attestations,
  };
};

export const hashFile = (filePath: string, hashName: FileHashName): Buffer => {
  const data = fs.readFileSync(filePath);
  return createHash(hashName).update(data).digest();
};

export const isBitcoinLeaf = (
  leaf: TimestampLeaf
): leaf is TimestampLeaf & { attestation: BitcoinAttestation } =>
  leaf.attestation.type === "bitcoin";

export const isPendingLeaf = (
  leaf: TimestampLeaf
): leaf is TimestampLeaf & { attestation: PendingAttestation } =>
  leaf.attestation.type === "pending";
