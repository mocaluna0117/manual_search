import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/module';
import { ManualResolver } from './resolver';

@Module({
  imports: [StorageModule],
  providers: [ManualResolver],
})
export class ManualModule {}
