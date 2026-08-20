import { Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
import { CreditStatus } from './model';
import { CreditService } from './service';

/**
 * AWSの無料クレジットの残り(ADMIN専用)。
 * 移行の時期を管理者が判断するための一時的な機能。
 */
@Resolver()
export class CreditResolver {
  constructor(private readonly credit: CreditService) {}

  @Roles(UserRole.ADMIN)
  @Query(() => CreditStatus)
  awsCredit() {
    return this.credit.status();
  }
}
