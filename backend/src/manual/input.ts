import { Field, GraphQLISODateTime, ID, InputType, Int } from '@nestjs/graphql';

// registerManualの引数。項目が多いMutationは個別Argsでなく
// InputTypeにまとめるのがGraphQLの定石
@InputType()
export class RegisterManualInput {
  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field()
  fileKey!: string;

  @Field()
  fileName!: string;

  @Field(() => Int)
  size!: number;

  @Field(() => ID, { nullable: true })
  categoryId?: string;

  // trueなら取り込み完了後にAIがカテゴリを自動で割り当てる
  @Field(() => Boolean, { nullable: true })
  autoCategorize?: boolean;

  // 元ファイルの最終更新日時。同名マニュアルがある場合の新旧判定に使う
  @Field(() => GraphQLISODateTime, { nullable: true })
  fileLastModified?: Date;
}
