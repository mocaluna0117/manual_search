import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';

@Injectable()
export class ManualService {
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

  register(input: RegisterManualInput) {
    return this.prisma.manual.create({ data: input });
  }

  /** PDFをRAGサービスに取り込ませる(チャンク化)。戻り値はチャンク数 */
  async ingest(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    // Pythonが読めるように署名付きURLを発行して渡す(バケットの認証情報は渡さない)
    const downloadUrl = await this.storage.createDownloadUrl(
      manual.fileKey,
      manual.fileName,
    );
    return this.rag.ingest(manual.id, downloadUrl);
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
