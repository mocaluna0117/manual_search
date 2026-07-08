import { Module } from '@nestjs/common';
import { RagModule } from '../rag/module';
import { StorageModule } from '../storage/module';
import { ManualResolver } from './resolver';
import { ManualService } from './service';

@Module({
  imports: [StorageModule, RagModule],
  providers: [ManualResolver, ManualService],
})
export class ManualModule {}
