import { Field, Int, ObjectType } from '@nestjs/graphql';

// 回答の根拠となったマニュアルの断片
@ObjectType()
export class RagCitation {
  @Field()
  manualId!: string;

  @Field()
  title!: string;

  @Field()
  snippet!: string;

  // 元PDFの何ページ目か(ページ単位のピンポイント引用)
  @Field(() => Int, { nullable: true })
  pageNumber!: number | null;
}

@ObjectType()
export class RagAnswer {
  @Field()
  answer!: string;

  @Field(() => [RagCitation])
  citations!: RagCitation[];

  // 絞り込み質問の選択肢(フロントでボタン表示する)
  @Field(() => [String])
  options!: string[];
}
