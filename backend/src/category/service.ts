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

  create(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('カテゴリ名を入力してください');
    }
    return this.prisma.manualCategory.create({
      data: { name: trimmed },
    });
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
