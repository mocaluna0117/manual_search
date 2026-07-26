import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import { IngestStatus } from './model';

@Injectable()
export class ManualService {
  private readonly logger = new Logger(ManualService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly rag: RagService,
  ) {}

  findAll(categoryId?: string) {
    return this.prisma.manual.findMany({
      where: categoryId ? { categoryId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async register(input: RegisterManualInput) {
    const manual = await this.prisma.manual.create({ data: input });
    // 取り込みは裏で実行(fire-and-forget)。ユーザーを何十秒も待たせないため、
    // awaitせずに即レスポンスを返し、進行状況はingestStatusで見せる
    void this.runIngest(manual.id);
    return manual;
  }

  /** 手動での(再)取り込み。FAILEDになったマニュアルのリトライ用 */
  async ingest(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    await this.runIngest(id);
    const updated = await this.prisma.manual.findUniqueOrThrow({
      where: { id },
    });
    return updated.chunkCount ?? 0;
  }

  /** 取り込みの実行本体。結果(成功/失敗)は例外でなくDBのステータスに記録する */
  private async runIngest(id: string) {
    try {
      const manual = await this.prisma.manual.findUniqueOrThrow({
        where: { id },
      });
      await this.prisma.manual.update({
        where: { id },
        data: { ingestStatus: IngestStatus.PROCESSING, ingestError: null },
      });

      // Pythonが読めるように署名付きURLを発行して渡す(バケットの認証情報は渡さない)
      const downloadUrl = await this.storage.createDownloadUrl(
        manual.fileKey,
        manual.fileName,
      );
      const chunkCount = await this.rag.ingest(manual.id, downloadUrl);

      await this.prisma.manual.update({
        where: { id },
        data: {
          ingestStatus: IngestStatus.COMPLETED,
          chunkCount,
          ingestedAt: new Date(),
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`取り込み失敗 manual=${id}: ${message}`);
      await this.prisma.manual
        .update({
          where: { id },
          data: { ingestStatus: IngestStatus.FAILED, ingestError: message },
        })
        .catch(() => undefined); // マニュアル自体が削除済みの場合は無視
    }
  }

  async getDownloadUrl(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    return this.storage.createDownloadUrl(manual.fileKey, manual.fileName);
  }

  async delete(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    // 先にストレージの実ファイルを消し、成功したらDBの行を消す。
    // 逆順だと、ストレージ削除失敗時に「DBに無いのにファイルだけ残る」迷子ができる
    await this.storage.deleteObject(manual.fileKey);
    return this.prisma.manual.delete({ where: { id } });
  }
}
