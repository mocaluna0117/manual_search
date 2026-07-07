import { Module } from '@nestjs/common';
import { CategoryResolver } from './resolver';
import { CategoryService } from './service';

@Module({
  providers: [CategoryService, CategoryResolver],
})
export class CategoryModule {}
