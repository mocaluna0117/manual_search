import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/module';
import { ManualResolver } from './resolver';
import { ManualService } from './service';

@Module({
  imports: [StorageModule],
  providers: [ManualResolver, ManualService],
})
export class ManualModule {}
