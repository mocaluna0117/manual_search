import { Module } from '@nestjs/common';
import { InquiryResolver } from './resolver';
import { InquiryService } from './service';

@Module({
  providers: [InquiryService, InquiryResolver],
})
export class InquiryModule {}
