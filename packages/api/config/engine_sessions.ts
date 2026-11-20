import env from '#start/env'

const mebibyte = 1024 * 1024

/**
 * Limits of the engine session log endpoints. The engine pushes at most 256
 * records or about 2 MiB of JSON at a time, and a blob is an image or a large
 * tool output of a few MiB; the defaults leave room above that and nothing
 * more, so one client cannot make a single request unbounded.
 */
export function engineSessionsConfig() {
  return {
    /** Records a single push may carry. */
    maxPushRecords: env.get('ENGINE_LOG_MAX_PUSH_RECORDS') ?? 256,
    /** Bytes of JSON a single push may carry (the whole request body). */
    maxPushBytes: env.get('ENGINE_LOG_MAX_PUSH_BYTES') ?? 8 * mebibyte,
    /** Records a pull returns at most, whatever the client asks for. */
    maxPullRecords: env.get('ENGINE_LOG_MAX_PULL_RECORDS') ?? 512,
    /** A pull stops adding records once the page reaches this many bytes. */
    maxPullBytes: env.get('ENGINE_LOG_MAX_PULL_BYTES') ?? 4 * mebibyte,
    /** Bytes of one blob. */
    maxBlobBytes: env.get('ENGINE_BLOB_MAX_BYTES') ?? 25 * mebibyte,
  }
}
