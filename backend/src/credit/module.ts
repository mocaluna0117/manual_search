import { Module } from '@nestjs/common';
import { CreditResolver } from './resolver';
import { CreditService } from './service';

// 移行が終わったら、このモジュールごと消す
@Module({
  providers: [CreditService, CreditResolver],
})
export class CreditModule {}
