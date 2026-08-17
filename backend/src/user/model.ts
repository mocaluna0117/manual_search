import {
  Field,
  GraphQLISODateTime,
  ID,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { UserRole } from '../../generated/prisma/client';

registerEnumType(UserRole, {
  name: 'UserRole',
  description: 'ADMIN=マニュアル管理可 / MEMBER=閲覧・検索のみ',
});

// フロントに返す「今ログインしている自分」の情報
@ObjectType()
export class UserProfile {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => UserRole)
  role!: UserRole;
}

// 管理画面(ユーザー管理)に出す1ユーザー。
// アカウントの実体はCognito、権限はDBが持つので両者を合成して返す
@ObjectType()
export class ManagedUser {
  @Field(() => ID)
  cognitoSub!: string;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => UserRole)
  role!: UserRole;

  // 招待直後で仮パスワードのまま(=まだ一度もログインしていない)
  @Field(() => Boolean)
  passwordPending!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  createdAt!: Date | null;
}

/** まとめて招待したときに、送れなかった宛先とその理由 */
@ObjectType()
export class InviteFailure {
  @Field()
  email!: string;

  @Field()
  reason!: string;
}

/**
 * まとめて招待した結果。
 * 1件の失敗で全体を止めないので、送れた分と送れなかった分の両方を返す
 */
@ObjectType()
export class InviteResult {
  @Field(() => [ManagedUser])
  invited!: ManagedUser[];

  @Field(() => [InviteFailure])
  failed!: InviteFailure[];
}
