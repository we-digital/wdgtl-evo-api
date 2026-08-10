export const CHATWOOT_CONTACT_ENRICHMENT_BATCH_LIMIT = 25;

type ChatwootContact = {
  id?: number;
  identifier?: string;
  phone_number?: string;
  [key: string]: unknown;
};

export const extractChatwootContacts = (response: unknown): ChatwootContact[] => {
  if (Array.isArray(response)) {
    return response;
  }

  if (response && typeof response === 'object') {
    const result = response as { payload?: unknown; data?: { payload?: unknown } };
    if (Array.isArray(result.payload)) {
      return result.payload;
    }
    if (Array.isArray(result.data?.payload)) {
      return result.data.payload;
    }
  }

  return [];
};

export const shouldEnrichChatwootContacts = (contactCount: number, requested = true) =>
  requested && contactCount > 0 && contactCount <= CHATWOOT_CONTACT_ENRICHMENT_BATCH_LIMIT;

export const shouldForwardChatwootMessageUpsert = (type: string) => type === 'notify';
