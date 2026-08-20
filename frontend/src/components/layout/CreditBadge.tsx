import { useQuery } from '@apollo/client/react'
import { Box, HStack, Text, VStack } from '@chakra-ui/react'
import { LuTriangleAlert, LuWallet } from 'react-icons/lu'
import { Tooltip } from '../ui/Tooltip'
import { AWS_CREDIT_QUERY } from '../../graphql/credit'

/**
 * AWSの無料クレジットの残りを管理者にだけ見せる。
 *
 * **移行が終わったら消す一時的な表示。** クレジットが尽きるとアカウントは
 * 自動的に閉鎖され、データも90日で消えるため、移行に着手する時期を
 * 見落とさないようにする目的で置いている。
 *
 * 消すときは、このファイルと graphql/credit.ts、Sidebarでの呼び出しを削除する。
 */
export function CreditBadge({ isAdmin }: { isAdmin: boolean }) {
  // 管理者以外には問い合わせない(バックエンドも@Roles(ADMIN)で弾く)
  const { data } = useQuery(AWS_CREDIT_QUERY, {
    skip: !isAdmin,
    // 残高は日単位でしか動かないので、開き直したときに1回取れれば十分
    fetchPolicy: 'cache-first',
  })

  const credit = data?.awsCredit
  if (!isAdmin || !credit) return null

  const urgent = credit.level === 'URGENT'
  const warn = credit.level === 'WARN'
  const tone = urgent
    ? { fg: 'red.fg', bg: 'red.subtle' }
    : warn
      ? { fg: 'orange.fg', bg: 'orange.subtle' }
      : { fg: 'fg.muted', bg: 'transparent' }

  // 1行ずつ要素で組む。改行文字とwhiteSpaceに頼ると、空白の詰め方の違いで
  // 行が消えたように見えることがある(実際に最後の一文が読めなかった)
  const detail = (
    <VStack align="start" gap={0} fontSize="xs" maxW="240px">
      <Text>残高 ${credit.remainingUsd.toFixed(2)}</Text>
      <Text>1日あたり ${credit.perDayUsd.toFixed(2)}</Text>
      <Text>枯渇の見込み {credit.exhaustionOn}</Text>
      <Text opacity={0.8}>
        {credit.source === 'ESTIMATE'
          ? '(AWSに問い合わせできないため、実測ペースからの推定)'
          : '(AWSの実際の残高)'}
      </Text>
      <Text mt={1}>
        尽きるとAWSのアカウントは閉鎖され、データは90日で消えます。
        移行の手順は docs/b-plan-migration-runbook.md にあります。
      </Text>
    </VStack>
  )

  return (
    <Tooltip label={detail}>
      <Box
        px={warn || urgent ? 2 : 0}
        py={warn || urgent ? 1 : 0}
        mb={1}
        borderRadius="sm"
        bg={tone.bg}
        cursor="default"
      >
        <HStack gap={1} color={tone.fg}>
          {urgent ? <LuTriangleAlert size={12} /> : <LuWallet size={12} />}
          <Text fontSize="xs" fontWeight={urgent ? 'bold' : 'normal'} truncate>
            {credit.summary}
          </Text>
        </HStack>
      </Box>
    </Tooltip>
  )
}
