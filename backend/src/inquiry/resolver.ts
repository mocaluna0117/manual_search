import { Args, Mutation, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { InquiryService } from './service';

@Resolver()
export class InquiryResolver {
  constructor(private readonly inquiryService: InquiryService) {}

  // 問い合わせの送信は全員が使える(管理者への連絡手段)
  @Mutation(() => Boolean)
  sendInquiry(
    @Args('message') message: string,
    @CurrentUser() authUser: AuthUser,
    // 画面のスクリーンショットを添えられるようにする(任意)
    @Args('imageBase64', { type: () => String, nullable: true })
    imageBase64?: string,
    @Args('imageFormat', { type: () => String, nullable: true })
    imageFormat?: string,
  ) {
    const image = imageBase64
      ? { base64: imageBase64, format: imageFormat ?? 'png' }
      : undefined;
    return this.inquiryService.send(message, authUser.email ?? null, image);
  }
}
