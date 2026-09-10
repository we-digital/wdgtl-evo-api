import mimeTypes from 'mime-types';

type MediaType = 'image' | 'document' | 'video' | 'audio' | 'ptv';

type MediaMessageMetadataInput = {
  mediaType: MediaType;
  mediaUrl?: string;
  fileName?: string;
  mimetype?: string;
  responseContentType?: unknown;
};

type MediaMessageMetadata = {
  fileName?: string;
  mimetype?: string;
};

type MediaResponseContentTypeLoader = () => Promise<unknown>;

type MediaPreparationLogEvent = 'whatsapp_media_duration_error' | 'whatsapp_media_prepare_error';

const MAX_FILE_NAME_LENGTH = 180;
const MIME_ESSENCE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const UNSAFE_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;

const decodeUrlPathname = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

export const sanitizeMediaFileName = (value?: string): string | undefined => {
  if (!value) return undefined;

  let candidate = value;
  let decodePercentEncoding = false;
  try {
    const parsed = new URL(value);
    candidate = parsed.pathname;
    decodePercentEncoding = true;
  } catch {
    candidate = value.split(/[?#]/, 1)[0];
  }

  if (decodePercentEncoding) candidate = decodeUrlPathname(candidate);
  const pathSegments = candidate.replace(/\\/g, '/').split('/').filter(Boolean);
  const baseName = pathSegments[pathSegments.length - 1];
  if (!baseName) return undefined;

  const sanitized = baseName
    .normalize('NFC')
    .replace(UNSAFE_FILE_NAME_CHARACTERS, '_')
    .replace(/_+/g, '_')
    .replace(/^[.\s_]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_FILE_NAME_LENGTH);

  return sanitized || undefined;
};

const normalizeMimeType = (value: unknown, preserveParameters = false): string | undefined => {
  if (typeof value !== 'string' || value.length > 200 || /\p{Cc}/u.test(value)) return undefined;

  const trimmed = value.trim();
  const essence = trimmed.split(';', 1)[0].trim().toLowerCase();
  if (!MIME_ESSENCE.test(essence)) return undefined;
  if (essence === 'application/mp4') return 'video/mp4';

  return preserveParameters ? trimmed : essence;
};

export const resolveMediaMessageMetadata = ({
  mediaType,
  mediaUrl,
  fileName,
  mimetype,
  responseContentType,
}: MediaMessageMetadataInput): MediaMessageMetadata => {
  let safeFileName = sanitizeMediaFileName(fileName);

  if (!safeFileName && mediaType === 'document' && mediaUrl) {
    safeFileName = sanitizeMediaFileName(mediaUrl);
  }
  if (!safeFileName && mediaType === 'document') safeFileName = 'document';
  if (!safeFileName && mediaType === 'image') safeFileName = 'image.jpg';
  if (!safeFileName && mediaType === 'video') safeFileName = 'video.mp4';

  const fileNameMimeType = safeFileName ? mimeTypes.lookup(safeFileName) : false;
  const resolvedMimeType =
    normalizeMimeType(mimetype, true) ?? normalizeMimeType(fileNameMimeType) ?? normalizeMimeType(responseContentType);

  return {
    fileName: safeFileName,
    mimetype: resolvedMimeType,
  };
};

export const resolveChatwootAttachmentMetadata = async (
  mediaUrl: string,
  loadResponseContentType: MediaResponseContentTypeLoader,
): Promise<MediaMessageMetadata> => {
  const urlMetadata = resolveMediaMessageMetadata({
    mediaType: 'document',
    mediaUrl,
  });
  if (urlMetadata.mimetype) return urlMetadata;

  return resolveMediaMessageMetadata({
    mediaType: 'document',
    mediaUrl,
    responseContentType: await loadResponseContentType(),
  });
};

export const formatMediaPreparationErrorLog = (event: MediaPreparationLogEvent, error: unknown): string => {
  const candidate = typeof (error as { name?: unknown })?.name === 'string' ? (error as { name: string }).name : '';
  const errorClass = SAFE_ERROR_CLASS.test(candidate) ? candidate : 'Error';

  return JSON.stringify({ event, errorClass });
};
