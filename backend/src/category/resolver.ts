import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
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

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualCategory)
  createManualCategory(@Args('name') name: string) {
    return this.categoryService.create(name);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualCategory)
  updateManualCategory(
    @Args('id', { type: () => ID }) id: string,
    @Args('name') name: string,
  ) {
    return this.categoryService.rename(id, name);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualCategory)
  deleteManualCategory(@Args('id', { type: () => ID }) id: string) {
    return this.categoryService.delete(id);
  }
}
