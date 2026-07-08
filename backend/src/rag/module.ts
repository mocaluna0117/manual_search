import { Module } from '@nestjs/common';
import { RagResolver } from './resolver';
import { RagService } from './service';

@Module({
  providers: [RagService, RagResolver],
})
export class RagModule {}
