import tls from "node:tls";

const DEFAULT_SERVERS = [
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

export { DEFAULT_SERVERS };

export class ElectrumClient {
  constructor({ host, port, timeoutMs = 30_000 }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
  }

  label() {
    return `${this.host}:${this.port}`;
  }

  connect() {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.host,
        port: this.port,
        servername: this.host,
      });
      const onError = (err) => {
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
        socket.on("data", (chunk) => this._onData(chunk));
        socket.on("error", (err) => this._failAll(err));
        socket.on("close", () =>
          this._failAll(new Error(`closed ${this.label()}`))
        );
        resolve();
      });
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._failAll(new Error(`closed ${this.label()}`));
  }

  async request(method, params = []) {
    await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout ${method} @ ${this.label()}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(payload);
    });
  }

  async handshake() {
    await this.request("server.version", ["stamper/0.1", "1.4"]);
  }

  async getTip() {
    const tip = await this.request("blockchain.headers.subscribe", []);
    return { height: tip.height, hex: tip.hex };
  }

  async getHeaders(startHeight, count) {
    const result = await this.request("blockchain.block.headers", [
      startHeight,
      count,
    ]);
    const max = result.max ?? 2016;
    let hex = result.hex;
    if (!hex && Array.isArray(result.headers)) {
      hex = result.headers.join("");
    }
    if (!hex) {
      throw new Error(`no headers in response from ${this.label()}`);
    }
    return {
      count: result.count ?? hex.length / 160,
      max,
      raw: Buffer.from(hex, "hex"),
    };
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(
          new Error(
            `${this.label()} ${msg.error.message || JSON.stringify(msg.error)}`
          )
        );
      } else {
        waiter.resolve(msg.result);
      }
    }
  }

  _failAll(err) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

export const connectSome = async (servers, { min = 2, timeoutMs } = {}) => {
  const clients = [];
  const errors = [];
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
      errors.push(`${server.host}: ${err.message}`);
      client.close();
    }
  }
  if (clients.length === 0) {
    throw new Error(`no Electrum servers reachable:\n${errors.join("\n")}`);
  }
  return clients;
}
