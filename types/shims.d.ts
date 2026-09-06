declare module "webtorrent" {
  export default class WebTorrent {
    add(
      uri: string,
      opts?: Record<string, unknown>,
      ontorrent?: (torrent: unknown) => void
    ): unknown
    destroy(cb?: (err?: Error | string | null) => void): void
    on(event: string, listener: (...args: unknown[]) => void): this
  }
}

declare module "parse-torrent" {
  type ParsedMagnet = {
    infoHash?: string;
    infoHashBuffer?: Uint8Array;
  }

  export default function parseTorrent(
    torrentId: string | Uint8Array
  ): Promise<ParsedMagnet>
}
