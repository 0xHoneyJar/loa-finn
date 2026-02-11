// src/bridgebuilder/r2-client.ts
// IR2Client: R2/S3 client wrapper with conditional write support.
// Extends basic get/put/delete with putIfAbsent (If-None-Match: *)
// and putIfMatch (If-Match: etag) for atomic claim acquisition.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3"

export interface R2ClientConfig {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface GetResult {
  data: string
  etag: string
}

export interface PutResult {
  etag: string
}

export interface ConditionalPutResult {
  created: boolean
  etag?: string
}

export interface ConditionalUpdateResult {
  updated: boolean
  etag?: string
}

export interface IR2Client {
  get(key: string): Promise<GetResult | null>
  put(key: string, data: string): Promise<PutResult>
  delete(key: string): Promise<void>
  /** Write only if key does not exist (If-None-Match: *). Returns { created: false } on 412. */
  putIfAbsent(key: string, data: string): Promise<ConditionalPutResult>
  /** Write only if etag matches (If-Match: etag). Returns { updated: false } on 412. */
  putIfMatch(key: string, data: string, etag: string): Promise<ConditionalUpdateResult>
}

function isS3StatusCode(err: unknown, code: number): boolean {
  if (err && typeof err === "object" && "$metadata" in err) {
    const meta = (err as S3ServiceException).$metadata
    return meta?.httpStatusCode === code
  }
  return false
}

function is412(err: unknown): boolean {
  return isS3StatusCode(err, 412)
}

function isNotFound(err: unknown): boolean {
  return isS3StatusCode(err, 404)
}

export class R2Client implements IR2Client {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(config: R2ClientConfig) {
    this.bucket = config.bucket
    this.client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  async get(key: string): Promise<GetResult | null> {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }))
      const body = await resp.Body?.transformToString("utf-8")
      if (body === undefined) return null
      return { data: body, etag: resp.ETag ?? "" }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async put(key: string, data: string): Promise<PutResult> {
    const resp = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: "application/json",
    }))
    return { etag: resp.ETag ?? "" }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }))
  }

  async putIfAbsent(key: string, data: string): Promise<ConditionalPutResult> {
    try {
      const resp = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "application/json",
        IfNoneMatch: "*",
      }))
      return { created: true, etag: resp.ETag ?? "" }
    } catch (err) {
      if (is412(err)) return { created: false }
      throw err
    }
  }

  async putIfMatch(key: string, data: string, etag: string): Promise<ConditionalUpdateResult> {
    try {
      const resp = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "application/json",
        IfMatch: etag,
      }))
      return { updated: true, etag: resp.ETag ?? "" }
    } catch (err) {
      if (is412(err)) return { updated: false }
      throw err
    }
  }
}
