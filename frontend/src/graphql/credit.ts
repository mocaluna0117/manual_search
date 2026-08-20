import { gql, type TypedDocumentNode } from '@apollo/client'

// AWSの無料クレジットの残り(ADMIN専用)。移行が終わったらこのファイルごと消す

export type CreditLevel = 'OK' | 'WARN' | 'URGENT' | 'UNKNOWN'

export interface CreditStatus {
  /** 残っているクレジット(米ドル) */
  remainingUsd: number
  /** 1日あたりの消費(米ドル) */
  perDayUsd: number
  daysLeft: number
  /** 枯渇の見込み(YYYY-MM-DD) */
  exhaustionOn: string
  level: CreditLevel
  /** AWSに問い合わせた実測値か、実測ペースからの推定値か */
  source: 'AWS' | 'ESTIMATE'
  /** 画面にそのまま出せる一言 */
  summary: string
}

interface CreditData {
  awsCredit: CreditStatus
}

export const AWS_CREDIT_QUERY: TypedDocumentNode<CreditData> = gql`
  query AwsCredit {
    awsCredit {
      remainingUsd
      perDayUsd
      daysLeft
      exhaustionOn
      level
      source
      summary
    }
  }
`
