import { ConfigService, S3 } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import * as MinIo from 'minio';
import { join } from 'path';
import { Readable, Transform } from 'stream';

const logger = new Logger('S3 Service');

const BUCKET = new ConfigService().get<S3>('S3');

interface Metadata extends MinIo.ItemBucketMetadata {
  'Content-Type': string;
}

const minioClient = (() => {
  if (BUCKET?.ENABLE) {
    return new MinIo.Client({
      endPoint: BUCKET.ENDPOINT,
      port: BUCKET.PORT,
      useSSL: BUCKET.USE_SSL,
      accessKey: BUCKET.ACCESS_KEY,
      secretKey: BUCKET.SECRET_KEY,
      region: BUCKET.REGION,
    });
  }
})();

const bucketName = BUCKET.BUCKET_NAME;

const bucketExists = async () => {
  if (minioClient) {
    try {
      const list = await minioClient.listBuckets();
      return list.find((bucket) => bucket.name === bucketName);
    } catch {
      return false;
    }
  }
};

const setBucketPolicy = async () => {
  if (minioClient) {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };
    await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
  }
};

const createBucket = async () => {
  if (minioClient) {
    try {
      const exists = await bucketExists();
      if (!exists) {
        await minioClient.makeBucket(bucketName);
      }
      if (!BUCKET.SKIP_POLICY) {
        await setBucketPolicy();
      }
      logger.info(`S3 Bucket ${bucketName} - ON`);
      return true;
    } catch (error) {
      logger.error('S3 ERROR:');
      logger.error(error);
      return false;
    }
  }
};

createBucket();

const uploadFile = async (fileName: string, file: Buffer | Transform | Readable, size: number, metadata: Metadata) => {
  if (minioClient) {
    const objectName = join('evolution-api', fileName);
    try {
      metadata['custom-header-application'] = 'evolution-api';
      return await minioClient.putObject(bucketName, objectName, file, size, metadata);
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

const getObjectUrl = async (fileName: string, expiry?: number) => {
  if (minioClient) {
    try {
      const objectName = join('evolution-api', fileName);
      if (expiry) {
        return await minioClient.presignedGetObject(bucketName, objectName, expiry);
      }
      return await minioClient.presignedGetObject(bucketName, objectName);
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }
};

const uploadTempFile = async (
  folder: string,
  fileName: string,
  file: Buffer | Transform | Readable,
  size: number,
  metadata: Metadata,
) => {
  if (minioClient) {
    const objectName = join(folder, fileName);
    try {
      metadata['custom-header-application'] = 'evolution-api';
      return await minioClient.putObject(bucketName, objectName, file, size, metadata);
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

// Read only an authenticated native Media object. Recovery never follows a
// payload URL or asks WhatsApp to refresh/download expired provider media.
const readStoredFile = async (fileName: string, limit: number, mime: string): Promise<Buffer> => {
  if (!minioClient || !Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) {
    throw new Error('cached_media_storage_unavailable');
  }
  try {
    const objectName = join('evolution-api', fileName);
    const stat = await minioClient.statObject(bucketName, objectName);
    if (stat.size !== limit || stat.metaData?.['content-type'] !== mime) {
      throw new Error('cached_media_storage_metadata_mismatch');
    }
    const stream = await minioClient.getObject(bucketName, objectName);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) throw new Error('cached_media_storage_bound');
        chunks.push(bytes);
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(chunks);
  } catch {
    throw new Error('cached_media_storage_read_unconfirmed');
  }
};

const deleteFile = async (folder: string, fileName: string) => {
  if (minioClient) {
    const objectName = join(folder, fileName);
    try {
      return await minioClient.removeObject(bucketName, objectName);
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

export { BUCKET, deleteFile, getObjectUrl, readStoredFile, uploadFile, uploadTempFile };
