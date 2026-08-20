import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * 受け付けた問い合わせ(ADMIN専用)。
 *
 * メールだけが受け取り手段だと、迷惑メールに入ったり見落としたりしたときに
 * 気づけない。画面から一覧で追えるようにするための型
 */
@ObjectType()
export class InquiryItem {
  @Field(() => ID)
  id!: string;

  // 送信者。ログイン中の利用者のメールアドレス(取得できなければnull)
  @Field(() => String, { nullable: true })
  userEmail!: string | null;

  @Field()
  message!: string;

  // 添付画像の閲覧用URL(期限付き)。無ければ空
  @Field(() => [String])
  imageUrls!: string[];

  // 対応済みにした時刻。nullなら未対応
  @Field(() => Date, { nullable: true })
  handledAt!: Date | null;

  @Field(() => Date)
  createdAt!: Date;
}

/** サイドバーのバッジ用 */
@ObjectType()
export class InquiryCounts {
  @Field(() => Int)
  unhandled!: number;

  @Field(() => Int)
  total!: number;
}
