import { Module } from '@nestjs/common';
import { CategoryResolver } from './resolver';
import { CategoryService } from './service';

@Module({
  providers: [CategoryService, CategoryResolver],
  exports: [CategoryService], // チャットの管理操作(フォルダ作成)から使う
})
export class CategoryModule {}
