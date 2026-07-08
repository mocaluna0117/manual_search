import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? 'manuals';
    this.s3 = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      // MinIOのときだけ指定する。本番のAmazon S3では未設定(undefined)でよい
      endpoint: process.env.S3_ENDPOINT,
      // MinIOはパス形式(host/bucket/key)のURLを使う。S3は仮想ホスト形式が既定
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
    });
  }

  /**
   * アップロード専用の署名付きURLを発行する(15分有効)。
   * ファイル本体はフロントがこのURLへ直接PUTするので、バックエンドを経由しない
   */
  async createUploadUrl(fileName: string) {
    // パス区切り文字を除去し、UUIDで衝突を防ぐ
    const safeName = fileName.replace(/[/\\]/g, '_');
    const fileKey = `${randomUUID()}/${safeName}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      ContentType: 'application/pdf',
    });
    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 900 });

    return { uploadUrl, fileKey };
  }

  /** 閲覧用の署名付きURLを発行する(15分有効)。ブラウザのタブでPDFが開く */
  async createDownloadUrl(fileKey: string, fileName: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      // inline=タブで開く。日本語ファイル名はRFC5987形式でエンコードする
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ResponseContentType: 'application/pdf',
    });
    return getSignedUrl(this.s3, command, { expiresIn: 900 });
  }

  async deleteObject(fileKey: string) {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey }),
    );
  }
}
