import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ManualCategory } from './model';
import { CategoryService } from './service';

@Resolver(() => ManualCategory)
export class CategoryResolver {
  constructor(private readonly categoryService: CategoryService) {}

  // カテゴリ一覧（サイドバー表示用）
  @Query(() => [ManualCategory])
  manualCategories() {
    return this.categoryService.findAll();
  }

  @Mutation(() => ManualCategory)
  createManualCategory(@Args('name') name: string) {
    return this.categoryService.create(name);
  }

  @Mutation(() => ManualCategory)
  deleteManualCategory(@Args('id', { type: () => ID }) id: string) {
    return this.categoryService.delete(id);
  }
}
