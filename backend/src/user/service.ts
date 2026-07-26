import { Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/current-user';
import { PrismaService } from '../prisma/service';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * JWTで認証されたユーザーをDBに確保する(JITプロビジョニング)。
   * 初回アクセスなら作成、既存ならメールアドレスを最新化。
   * Cognito側でユーザーを追加するだけで、アプリ側の登録作業は不要になる
   */
  ensure(authUser: AuthUser) {
    return this.prisma.user.upsert({
      where: { cognitoSub: authUser.userId },
      update: { email: authUser.email },
      create: { cognitoSub: authUser.userId, email: authUser.email },
    });
  }
}
