import { Field, InputType } from '@nestjs/graphql';

/** 質問に添える画像1枚(画面のスクリーンショットなど) */
@InputType()
export class ChatImageInput {
  /** 画像そのもの(base64。データURLの接頭辞は含めない) */
  @Field()
  base64!: string;

  /** png / jpeg / webp / gif */
  @Field()
  format!: string;
}
