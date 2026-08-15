import { gql, type TypedDocumentNode } from '@apollo/client'

/** 利用状況の集計(すべてADMIN専用)。誰が質問したかは扱わない */

export interface AnalyticsSummary {
  questionCount: number
  answeredCount: number
  unansweredCount: number
  /** 可否を判定できない回答(管理操作・エラー・記録開始前のデータ) */
  unknownCount: number
  neverCitedManualCount: number
}

interface SummaryData {
  analyticsSummary: AnalyticsSummary
}

interface DaysVars {
  /** 集計期間(日)。null/0で全期間 */
  days?: number | null
}

export const ANALYTICS_SUMMARY_QUERY: TypedDocumentNode<
  SummaryData,
  DaysVars
> = gql`
  query AnalyticsSummary($days: Int) {
    analyticsSummary(days: $days) {
      questionCount
      answeredCount
      unansweredCount
      unknownCount
      neverCitedManualCount
    }
  }
`

export interface UnansweredQuestion {
  id: string
  question: string
  answer: string
  askedAt: string
}

interface UnansweredData {
  unansweredQuestions: UnansweredQuestion[]
}

export const UNANSWERED_QUESTIONS_QUERY: TypedDocumentNode<
  UnansweredData,
  DaysVars
> = gql`
  query UnansweredQuestions($days: Int) {
    unansweredQuestions(days: $days) {
      id
      question
      answer
      askedAt
    }
  }
`

export interface ManualUsage {
  manualId: string
  title: string
  categoryName: string | null
  citedCount: number
  lastCitedAt: string | null
}

interface ManualUsageData {
  manualUsage: ManualUsage[]
}

export const MANUAL_USAGE_QUERY: TypedDocumentNode<ManualUsageData, DaysVars> =
  gql`
    query ManualUsage($days: Int) {
      manualUsage(days: $days) {
        manualId
        title
        categoryName
        citedCount
        lastCitedAt
      }
    }
  `

export interface QuestionTheme {
  theme: string
  count: number
  examples: string[]
}

interface QuestionThemesData {
  questionThemes: QuestionTheme[]
}

// AIを呼ぶので、画面のボタンを押したときだけ実行する
export const QUESTION_THEMES_QUERY: TypedDocumentNode<
  QuestionThemesData,
  DaysVars
> = gql`
  query QuestionThemes($days: Int) {
    questionThemes(days: $days) {
      theme
      count
      examples
    }
  }
`
