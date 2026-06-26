import { Query, Resolver } from '@nestjs/graphql';
import { PrismaService } from './prisma/service';

@Resolver()
export class AppResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query(() => String)
  health(): string {
    return 'ok';
  }

  @Query(() => String)
  async dbHealth(): Promise<string> {
    await this.prisma.$queryRaw`SELECT 1`;
    return 'db ok';
  }
}
