// src/persistence/r2-storage.ts — ICheckpointStorage adapter for Cloudflare R2 (T-7.4)
// Wraps @aws-sdk/client-s3 to implement the upstream checkpoint storage interface.

import { createHash } from "node:crypto"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import type { ICheckpointStorage } from "./upstream.js"

export interface R2StorageConfig {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Key prefix for all operations (default: "") */
  prefix?: string
}

export class R2CheckpointStorage implements ICheckpointStorage {
  private client: S3Client
  private bucket: string
  private prefix: string

  constructor(private config: R2StorageConfig) {
    this.bucket = config.bucket
    this.prefix = config.prefix ?? ""

    this.client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  /** Check if R2 credentials are configured. */
  get isConfigured(): boolean {
    return !!(this.config.endpoint && this.config.accessKeyId && this.config.secretAccessKey)
  }

  private key(relativePath: string): string {
    return this.prefix ? `${this.prefix}/${relativePath}` : relativePath
  }

  async isAvailable(): Promise<boolean> {
    if (!this.isConfigured) return false
    try {
      await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        MaxKeys: 1,
      }))
      return true
    } catch {
      return false
    }
  }

  async readFile(relativePath: string): Promise<Buffer | null> {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(relativePath),
      }))
      const body = await resp.Body?.transformToByteArray()
      return body ? Buffer.from(body) : null
    } catch {
      return null
    }
  }

  async writeFile(relativePath: string, content: Buffer): Promise<boolean> {
    try {
      const sha256 = createHash("sha256").update(content).digest("hex")
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(relativePath),
        Body: content,
        Metadata: { sha256 },
      }))
      return true
    } catch {
      return false
    }
  }

  async deleteFile(relativePath: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key(relativePath),
      }))
      return true
    } catch {
      return false
    }
  }

  async listFiles(subPrefix?: string): Promise<string[]> {
    try {
      const fullPrefix = subPrefix
        ? `${this.key(subPrefix)}/`
        : this.prefix ? `${this.prefix}/` : ""

      const files: string[] = []
      let continuationToken: string | undefined

      do {
        const resp = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix || undefined,
          ContinuationToken: continuationToken,
        }))

        for (const obj of resp.Contents ?? []) {
          if (obj.Key) {
            // Return paths relative to our prefix
            const rel = this.prefix
              ? obj.Key.slice(this.prefix.length + 1)
              : obj.Key
            files.push(rel)
          }
        }

        continuationToken = resp.NextContinuationToken
      } while (continuationToken)

      return files
    } catch {
      return []
    }
  }

  async verifyChecksum(relativePath: string, expected: string): Promise<boolean> {
    const content = await this.readFile(relativePath)
    if (!content) return false
    const actual = createHash("sha256").update(content).digest("hex")
    return actual === expected
  }

  async stat(relativePath: string): Promise<{ size: number; mtime: Date } | null> {
    try {
      const resp = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.key(relativePath),
      }))
      return {
        size: resp.ContentLength ?? 0,
        mtime: resp.LastModified ?? new Date(),
      }
    } catch {
      return null
    }
  }
}
