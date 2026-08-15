import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

// GraphQLスキーマに公開する「ManualCategory」の形。
// Prismaのモデル(DBの形)とは別物で、「APIとして何を見せるか」をここで決める
@ObjectType()
export class ManualCategory {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  // フォルダ内のファイル合計サイズ。バイト数はIntの上限(約2.1GB)を
  // 超えうるのでFloatで返す
  @Field(() => Float)
  totalSize!: number;

  @Field(() => Int)
  manualCount!: number;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
