import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
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
