import { Field, ObjectType } from '@nestjs/graphql';

// 回答の根拠となったマニュアルの断片
@ObjectType()
export class RagCitation {
  @Field()
  manualId!: string;

  @Field()
  title!: string;

  @Field()
  snippet!: string;
}

@ObjectType()
export class RagAnswer {
  @Field()
  answer!: string;

  @Field(() => [RagCitation])
  citations!: RagCitation[];
}
