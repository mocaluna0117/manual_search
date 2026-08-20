import { Field, Float, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

/** 移行の急ぎ具合。画面の色分けに使う */
export enum CreditLevel {
  OK = 'OK', // まだ余裕がある
  WARN = 'WARN', // 準備を始める頃
  URGENT = 'URGENT', // 切り替えを終えていないと危ない
  UNKNOWN = 'UNKNOWN', // 残高が分からない
}
registerEnumType(CreditLevel, { name: 'CreditLevel' });

/** 残高の出どころ。推定値と実測値を画面で区別するため */
export enum CreditSource {
  AWS = 'AWS', // AWSに問い合わせた実際の残高
  ESTIMATE = 'ESTIMATE', // 問い合わせできず、実測ペースからの推定
}
registerEnumType(CreditSource, { name: 'CreditSource' });

/**
 * AWSの無料クレジットの残り。
 *
 * クレジットが尽きるとアカウントは自動的に閉鎖され、データも90日で消える。
 * 移行の判断に使うため、管理者にだけ残り日数を見せる。
 */
@ObjectType()
export class CreditStatus {
  // 残っているクレジット(米ドル)
  @Field(() => Float)
  remainingUsd!: number;

  // 1日あたりの消費(米ドル)
  @Field(() => Float)
  perDayUsd!: number;

  // このままだと何日もつか
  @Field(() => Int)
  daysLeft!: number;

  // 枯渇する見込みの日付(YYYY-MM-DD)
  @Field()
  exhaustionOn!: string;

  @Field(() => CreditLevel)
  level!: CreditLevel;

  @Field(() => CreditSource)
  source!: CreditSource;

  // 画面にそのまま出せる一言(「残り約40日」など)
  @Field()
  summary!: string;
}
