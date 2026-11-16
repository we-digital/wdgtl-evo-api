// HEIC/HEIF media becomes JPEG before it reaches Chatwoot (owner, 2026-11-16, C74).
//
// Chatwoot cannot preview iPhone HEIC photos ("Preview not available"). EVO and
// the Telegram listener share one converter: the recognizer's POST /v1/media/jpeg.
// Detection is local, so other media costs nothing. When the converter is off,
// unreachable, slow or refuses the file, the original bytes are kept.

const HEIC_EXTENSIONS = new Set(['.heic', '.heif', '.hif']);
const HEIC_MIMETYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
// ISO BMFF "ftyp" major brands used by HEIC/HEIF stills and sequences.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
export const MEDIA_CONVERTER_TIMEOUT_MS = 20_000;
export const MEDIA_CONVERTER_MAX_BYTES = 25 * 1024 * 1024;

export type HeicMedia = { bytes: Buffer; fileName: string; mimetype?: string | null };
export type MediaConverterConfig = { url: string; apiKey: string; timeoutMs: number };

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

export function isHeicMedia({ bytes, fileName, mimetype }: HeicMedia): boolean {
  if (mimetype && HEIC_MIMETYPES.has(mimetype.split(';')[0].trim().toLowerCase())) return true;
  if (HEIC_EXTENSIONS.has(extensionOf(fileName))) return true;
  return (
    bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp' && HEIC_BRANDS.has(bytes.toString('latin1', 8, 12))
  );
}

// IMG_1.HEIC -> IMG_1.jpg; a name without a HEIC extension gets .jpg appended.
export function jpegFileName(fileName: string): string {
  const ext = extensionOf(fileName);
  if (HEIC_EXTENSIONS.has(ext)) return `${fileName.slice(0, -ext.length)}.jpg`;
  if (ext === '.') return `${fileName}jpg`;
  return `${fileName}.jpg`;
}

export function mediaConverterConfig(env: NodeJS.ProcessEnv = process.env): MediaConverterConfig | null {
  const url = env.MEDIA_CONVERTER_URL?.trim().replace(/\/+$/, '');
  const apiKey = env.MEDIA_CONVERTER_API_KEY?.trim();
  if (!url || !apiKey) return null;
  const timeout = Number(env.MEDIA_CONVERTER_TIMEOUT_MS);
  return { url, apiKey, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : MEDIA_CONVERTER_TIMEOUT_MS };
}

export class MediaConverterError extends Error {
  constructor(code: string) {
    super(code);
    this.name = code;
  }
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export async function convertToJpeg(
  bytes: Buffer,
  config: MediaConverterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const response = await fetchImpl(`${config.url}/v1/media/jpeg`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new MediaConverterError(`MediaConverterHttp${response.status}`);
  }
  const jpeg = Buffer.from(await response.arrayBuffer());
  if (!isJpeg(jpeg)) throw new MediaConverterError('MediaConverterNotJpeg');
  return jpeg;
}

// Returns JPEG bytes and a .jpg name for HEIC media, or the media unchanged.
// Never throws: a photo that cannot be converted is delivered as it arrived.
export async function heicMediaAsJpeg(
  media: HeicMedia,
  log: (event: string, fields: Record<string, unknown>) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<HeicMedia & { converted: boolean }> {
  const unchanged = { ...media, converted: false };
  const config = mediaConverterConfig(env);
  if (!config || !media.bytes.length || media.bytes.length > MEDIA_CONVERTER_MAX_BYTES || !isHeicMedia(media))
    return unchanged;
  const started = Date.now();
  try {
    const jpeg = await convertToJpeg(media.bytes, config, fetchImpl);
    log('chatwoot_heic_converted', {
      inputBytes: media.bytes.length,
      outputBytes: jpeg.length,
      ms: Date.now() - started,
    });
    return { bytes: jpeg, fileName: jpegFileName(media.fileName), mimetype: 'image/jpeg', converted: true };
  } catch (error) {
    // Error class only: names and bytes are customer data.
    log('chatwoot_heic_convert_failed', { errorClass: (error as Error)?.name || 'Error', ms: Date.now() - started });
    return unchanged;
  }
}
