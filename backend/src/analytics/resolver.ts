import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
import { AnalyticsService } from './service';
import {
  AnalyticsSummary,
  ManualUsage,
  QuestionTheme,
  UnansweredQuestion,
} from './model';

/**
 * 利用状況の集計(ADMIN専用)。
 * 誰が質問したかは返さない(内容だけを集計する)
 */
@Resolver()
export class AnalyticsResolver {
  constructor(private readonly analytics: AnalyticsService) {}

  // 期間は日数で受ける(省略・0なら全期間)
  @Roles(UserRole.ADMIN)
  @Query(() => AnalyticsSummary)
  analyticsSummary(
    @Args('days', { type: () => Int, nullable: true }) days?: number,
  ) {
    return this.analytics.summary(days);
  }

  @Roles(UserRole.ADMIN)
  @Query(() => [UnansweredQuestion])
  unansweredQuestions(
    @Args('days', { type: () => Int, nullable: true }) days?: number,
  ) {
    return this.analytics.unansweredQuestions(days);
  }

  @Roles(UserRole.ADMIN)
  @Query(() => [ManualUsage])
  manualUsage(
    @Args('days', { type: () => Int, nullable: true }) days?: number,
  ) {
    return this.analytics.manualUsage(days);
  }

  // AIを呼ぶので、画面のボタンを押したときだけ実行する
  @Roles(UserRole.ADMIN)
  @Query(() => [QuestionTheme])
  questionThemes(
    @Args('days', { type: () => Int, nullable: true }) days?: number,
  ) {
    return this.analytics.questionThemes(days);
  }
}
