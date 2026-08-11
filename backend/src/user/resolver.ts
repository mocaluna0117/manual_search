import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { Roles, UserRole } from '../auth/roles';
import { ManagedUser, UserProfile } from './model';
import { UserService } from './service';

@Resolver(() => UserProfile)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  // 自分自身の情報(フロントが権限に応じてUIを出し分けるのに使う)
  @Query(() => UserProfile)
  me(@CurrentUser() authUser: AuthUser) {
    return this.userService.ensure(authUser);
  }

  // ---- ここから管理者向けのユーザー管理 ----

  @Query(() => [ManagedUser])
  @Roles(UserRole.ADMIN)
  users() {
    return this.userService.listManaged();
  }

  // メールアドレスで招待する。仮パスワードはCognitoが本人へメールで送る
  @Mutation(() => ManagedUser)
  @Roles(UserRole.ADMIN)
  inviteUser(
    @Args('email') email: string,
    @Args('role', { type: () => UserRole, nullable: true })
    role?: UserRole,
  ) {
    return this.userService.invite(email.trim(), role ?? UserRole.MEMBER);
  }

  @Mutation(() => ManagedUser)
  @Roles(UserRole.ADMIN)
  updateUserRole(
    @Args('cognitoSub', { type: () => ID }) cognitoSub: string,
    @Args('role', { type: () => UserRole }) role: UserRole,
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.userService.updateRole(cognitoSub, role, authUser);
  }

  @Mutation(() => Boolean)
  @Roles(UserRole.ADMIN)
  deleteUser(
    @Args('cognitoSub', { type: () => ID }) cognitoSub: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    return this.userService.remove(cognitoSub, authUser);
  }
}
