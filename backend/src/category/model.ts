import { Field, ID, ObjectType } from '@nestjs/graphql';

// GraphQLスキーマに公開する「ManualCategory」の形。
// Prismaのモデル(DBの形)とは別物で、「APIとして何を見せるか」をここで決める
@ObjectType()
export class ManualCategory {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
