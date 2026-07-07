import { Injectable } from '@nestjs/common';
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
    return this.prisma.manualCategory.create({
      data: { name },
    });
  }

  delete(id: string) {
    return this.prisma.manualCategory.delete({
      where: { id },
    });
  }
}
