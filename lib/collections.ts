/** Layout metadata from Project Timestamper README collections table. */
export type WorkHashName = "sha256" | "sha1" | "md5"

export type CollectionMeta = {
  hashName: WorkHashName;
  hashBytes: number;
  prefixHexDigits: number;
  /** If set, gunzip the download before hashing (e.g. NCBI *.fna.gz). */
  gunzipBeforeHash?: boolean;
}

export const COLLECTIONS: Readonly<Record<string, CollectionMeta>> = {
  gutenberg_books: { hashName: "sha256", hashBytes: 32, prefixHexDigits: 2 },
  libgen_fiction: { hashName: "sha256", hashBytes: 32, prefixHexDigits: 3 },
  libgen_nonfiction: { hashName: "sha256", hashBytes: 32, prefixHexDigits: 3 },
  scihub_articles: { hashName: "md5", hashBytes: 16, prefixHexDigits: 4 },
  tpb_movies: { hashName: "sha1", hashBytes: 20, prefixHexDigits: 3 },
  wikiart_works: { hashName: "sha256", hashBytes: 32, prefixHexDigits: 2 },
  yts_movies: { hashName: "sha1", hashBytes: 20, prefixHexDigits: 3 },
  annas_music: { hashName: "sha256", hashBytes: 32, prefixHexDigits: 4 },
  annas_music_with_embedded_meta: {
    hashName: "sha256",
    hashBytes: 32,
    prefixHexDigits: 4,
  },
  ncbi_genomes: {
    hashName: "sha256",
    hashBytes: 32,
    prefixHexDigits: 3,
    gunzipBeforeHash: true,
  },
}

export const DEFAULT_COLLECTION = "wikiart_works"

export const collectionNames = (): string[] => Object.keys(COLLECTIONS)

export const lookupCollection = (name: string): CollectionMeta => {
  const meta = COLLECTIONS[name]
  if (meta === undefined) {
    throw new Error(
      `unknown collection "${name}"; known: ${collectionNames().join(", ")}`
    )
  }
  return meta
}
