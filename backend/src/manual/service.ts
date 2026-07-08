import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/service';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';

@Injectable()
export class ManualService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
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
