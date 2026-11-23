// The OpenRouter key the person already connected in Settings → Models. The
// API keeps it encrypted and hands it only to its owner; the desktop copies
// it once into its own keychain storage, so the renderer never holds it.

export type ProviderConnection = { token?: string | null; url: string };

export async function resolveOpenRouterProviderKey(
  connection: ProviderConnection,
  fetcher: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await fetcher(
      `${connection.url.replace(/\/$/, "")}/providers/credentials/resolve`,
      {
        body: JSON.stringify({ providerId: "openrouter" }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(connection.token
            ? { Authorization: `Bearer ${connection.token}` }
            : {}),
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const body: unknown = await response.json().catch(() => null);
  const data = (body as { data?: unknown } | null)?.data ?? body;
  const key = (data as { apiKey?: unknown } | null)?.apiKey;
  return typeof key === "string" && key ? key : undefined;
}
