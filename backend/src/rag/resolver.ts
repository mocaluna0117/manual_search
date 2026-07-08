import { Query, Resolver } from '@nestjs/graphql';
import { RagService } from './service';

@Resolver()
export class RagResolver {
  constructor(private readonly ragService: RagService) {}

  // フロント→NestJS→Python の経路確認用
  @Query(() => String)
  ragHealth() {
    return this.ragService.health();
  }
}
