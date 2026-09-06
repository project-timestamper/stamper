export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
