import { Module } from '@nestjs/common';
import { RagModule } from '../rag/module';
import { StorageModule } from '../storage/module';
import { ManualResolver } from './resolver';
import { ManualService } from './service';

@Module({
  imports: [StorageModule, RagModule],
  providers: [ManualResolver, ManualService],
  exports: [ManualService], // チャットの管理操作(再分類)から使う
})
export class ManualModule {}
