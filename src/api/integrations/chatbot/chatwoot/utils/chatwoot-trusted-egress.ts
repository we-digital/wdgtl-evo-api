export class ChatwootTrustedDestinationError extends Error {
  constructor() {
    super('Chatwoot privileged request destination is not trusted');
    this.name = 'ChatwootTrustedDestinationError';
  }
}

function canonicalOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveTrustedChatwootBaseUrl(providerUrl: string, trustedBaseUrl: string): string | null {
  const providerOrigin = canonicalOrigin(providerUrl);
  const trustedOrigin = canonicalOrigin(trustedBaseUrl);
  if (!providerOrigin || !trustedOrigin || providerOrigin !== trustedOrigin) return null;
  return trustedOrigin;
}

export function requireTrustedChatwootUrl(providerUrl: string, trustedBaseUrl: string, requestPath: string): string {
  const baseUrl = resolveTrustedChatwootBaseUrl(providerUrl, trustedBaseUrl);
  if (!baseUrl || !requestPath.startsWith('/') || requestPath.startsWith('//')) {
    throw new ChatwootTrustedDestinationError();
  }

  const target = new URL(requestPath, `${baseUrl}/`);
  if (target.origin !== baseUrl) throw new ChatwootTrustedDestinationError();
  return target.toString();
}
