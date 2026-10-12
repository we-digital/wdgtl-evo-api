import { Readable } from 'node:stream';

export const STORED_MEDIA_READ_LIMIT = 8 * 1024 * 1024;

// Storage length bounds transport; the caller must authenticate the complete
// bytes against the native SHA before using a different reported native size.
export async function readBoundedStoredMedia(
  statObject: () => Promise<{ size: number; metaData?: Record<string, string> }>,
  getObject: () => Promise<Readable>,
  mime: string,
): Promise<Buffer> {
  let stream: Readable | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  try {
    const read = async () => {
      const stat = await statObject();
      if (
        expired ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 1 ||
        stat.size > STORED_MEDIA_READ_LIMIT ||
        stat.metaData?.['content-type'] !== mime
      )
        throw new Error('cached_media_storage_metadata_mismatch');
      stream = await getObject();
      if (expired) {
        stream.destroy();
        throw new Error('cached_media_storage_timeout');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (expired || size > stat.size) throw new Error('cached_media_storage_bound');
        chunks.push(bytes);
      }
      if (size !== stat.size) throw new Error('cached_media_storage_truncated');
      return Buffer.concat(chunks);
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          stream?.destroy();
          reject(new Error('cached_media_storage_timeout'));
        }, 5000);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
    stream?.destroy();
  }
}
