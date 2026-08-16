import { Args, Mutation, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { InquiryImageInput } from './input';
import { InquiryService } from './service';

@Resolver()
export class InquiryResolver {
  constructor(private readonly inquiryService: InquiryService) {}

  // 問い合わせの送信は全員が使える(管理者への連絡手段)
  @Mutation(() => Boolean)
  sendInquiry(
    @Args('message') message: string,
    @CurrentUser() authUser: AuthUser,
    // 画面のスクリーンショットを添えられるようにする(任意・複数可)
    @Args('images', { type: () => [InquiryImageInput], nullable: true })
    images?: InquiryImageInput[],
  ) {
    return this.inquiryService.send(
      message,
      authUser.email ?? null,
      images ?? [],
    );
  }
}
