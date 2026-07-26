import { Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { UserProfile } from './model';
import { UserService } from './service';

@Resolver(() => UserProfile)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  // 自分自身の情報(フロントが権限に応じてUIを出し分けるのに使う)
  @Query(() => UserProfile)
  me(@CurrentUser() authUser: AuthUser) {
    return this.userService.ensure(authUser);
  }
}
