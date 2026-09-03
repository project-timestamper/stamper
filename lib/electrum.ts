import tls from "node:tls";
import { errorMessage, isRecord } from "./util.ts";

export type ElectrumServer = {
  host: string;
  port: number;
};

export const DEFAULT_SERVERS: readonly ElectrumServer[] = [
  { host: "electrum.blockstream.info", port: 50002 },
  { host: "blockstream.info", port: 700 },
  { host: "electrum.blockitall.us", port: 50002 },
  { host: "fulcrum.bullbitcoin.com", port: 50002 },
  { host: "electrum.bullbitcoin.com", port: 50002 },
  { host: "btc-electrum.cakewallet.com", port: 50002 },
  { host: "mainnet.nunchuk.io", port: 52002 },
  { host: "fulcrum-core.1209k.com", port: 50002 },
  { host: "b.1209k.com", port: 50002 },
];

type RpcValue = string | number | boolean | null | RpcValue[];

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type ChainTip = {
  height: number;
  hex: string;
};

export type HeaderBatch = {
  count: number;
  max: number;
  raw: Buffer;
};

const rpcErrorMessage = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
};

const parseRpcEnvelope = (
  line: string
): { id: number; error?: unknown; result?: unknown } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "number") {
    return null;
  }
  return {
    id: parsed.id,
    error: parsed.error,
    result: parsed.result,
  };
};

const asChainTip = (value: unknown, label: string): ChainTip => {
  if (!isRecord(value)) {
    throw new Error(`bad tip from ${label}`);
  }
  if (typeof value.height !== "number" || typeof value.hex !== "string") {
    throw new Error(`bad tip from ${label}`);
  }
  return { height: value.height, hex: value.hex };
};

const asHeaderBatch = (value: unknown, label: string): HeaderBatch => {
  if (!isRecord(value)) {
    throw new Error(`bad headers from ${label}`);
  }
  let hex: string | undefined;
  if (typeof value.hex === "string") {
    hex = value.hex;
  } else if (
    Array.isArray(value.headers) &&
    value.headers.every((h): h is string => typeof h === "string")
  ) {
    hex = value.headers.join("");
  }
  if (hex === undefined || hex.length === 0) {
    throw new Error(`no headers in response from ${label}`);
  }
  const count =
    typeof value.count === "number" ? value.count : hex.length / 160;
  const max = typeof value.max === "number" ? value.max : 2016;
  return { count, max, raw: Buffer.from(hex, "hex") };
};

export class ElectrumClient {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  private socket: tls.TLSSocket | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor({
    host,
    port,
    timeoutMs = 30_000,
  }: ElectrumServer & { timeoutMs?: number }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  label(): string {
    return `${this.host}:${this.port}`;
  }

  connect(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.host,
        port: this.port,
        servername: this.host,
      });
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        socket.destroy();
        onError(new Error(`connect timeout ${this.label()}`));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("error", onError);
      };
      socket.once("error", onError);
      socket.once("secureConnect", () => {
        cleanup();
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          this.onData(chunk);
        });
        socket.on("error", (err: Error) => {
          this.failAll(err);
        });
        socket.on("close", () => {
          this.failAll(new Error(`closed ${this.label()}`));
        });
        resolve();
      });
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.failAll(new Error(`closed ${this.label()}`));
  }

  async request(method: string, params: RpcValue[] = []): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (!socket) {
      throw new Error(`not connected to ${this.label()}`);
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout ${method} @ ${this.label()}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      socket.write(payload);
    });
  }

  async handshake(): Promise<void> {
    await this.request("server.version", ["stamper/0.1", "1.4"]);
  }

  async getTip(): Promise<ChainTip> {
    const tip = await this.request("blockchain.headers.subscribe", []);
    return asChainTip(tip, this.label());
  }

  async getHeaders(startHeight: number, count: number): Promise<HeaderBatch> {
    const result = await this.request("blockchain.block.headers", [
      startHeight,
      count,
    ]);
    return asHeaderBatch(result, this.label());
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length > 0) {
        const msg = parseRpcEnvelope(line);
        if (msg !== null) {
          const waiter = this.pending.get(msg.id);
          if (waiter !== undefined) {
            this.pending.delete(msg.id);
            if (msg.error !== undefined) {
              waiter.reject(
                new Error(`${this.label()} ${rpcErrorMessage(msg.error)}`)
              );
            } else {
              waiter.resolve(msg.result);
            }
          }
        }
      }
      nl = this.buf.indexOf("\n");
    }
  }

  private failAll(err: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(err);
    }
    this.pending.clear();
  }
}

export type ConnectOptions = {
  min?: number;
  timeoutMs?: number;
};

export const connectSome = async (
  servers: readonly ElectrumServer[],
  { min = 2, timeoutMs }: ConnectOptions = {}
): Promise<ElectrumClient[]> => {
  const clients: ElectrumClient[] = [];
  const errors: string[] = [];
  for (const server of servers) {
    const client = new ElectrumClient({
      ...server,
      timeoutMs,
    });
    try {
      await client.connect();
      await client.handshake();
      clients.push(client);
      if (clients.length >= min && clients.length >= Math.min(3, servers.length)) {
        break;
      }
    } catch (err) {
      errors.push(`${server.host}: ${errorMessage(err)}`);
      client.close();
    }
  }
  if (clients.length === 0) {
    throw new Error(`no Electrum servers reachable:\n${errors.join("\n")}`);
  }
  return clients;
};
