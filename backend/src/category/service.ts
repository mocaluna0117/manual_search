import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/service';

@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.manualCategory.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async create(name: string) {
    const trimmed = await this.validateName(name);
    return this.prisma.manualCategory.create({
      data: { name: trimmed },
    });
  }

  async rename(id: string, name: string) {
    const trimmed = await this.validateName(name, id);
    const category = await this.prisma.manualCategory.findUnique({
      where: { id },
    });
    if (!category) {
      throw new BadRequestException('カテゴリが見つかりません');
    }
    return this.prisma.manualCategory.update({
      where: { id },
      data: { name: trimmed },
    });
  }

  /** 空文字と重複名をチェックする(excludeId=リネーム時の自分自身は除外) */
  private async validateName(name: string, excludeId?: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('カテゴリ名を入力してください');
    }
    const duplicate = await this.prisma.manualCategory.findFirst({
      where: { name: trimmed, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    });
    if (duplicate) {
      throw new BadRequestException(`カテゴリ「${trimmed}」は既に存在します`);
    }
    return trimmed;
  }

  async delete(id: string) {
    // マニュアルが残っているカテゴリは消させない(FKエラーの生投げではなく明確な理由を返す)
    const manualCount = await this.prisma.manual.count({
      where: { categoryId: id },
    });
    if (manualCount > 0) {
      throw new BadRequestException(
        `このカテゴリには${manualCount}件のマニュアルがあるため削除できません。先に移動または削除してください`,
      );
    }
    return this.prisma.manualCategory.delete({
      where: { id },
    });
  }
}
