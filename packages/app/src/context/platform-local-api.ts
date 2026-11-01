/**
 * Desktop: the Blame API the app runs on this computer, so it works without
 * an account. Each start issues a new token.
 */
export type LocalApiClient = {
  session(): Promise<{ url: string; token: string }>
}
