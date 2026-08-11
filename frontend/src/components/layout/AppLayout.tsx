import { Box, Flex } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import type { Category } from '../../graphql/categories'
import { Sidebar } from './Sidebar'

interface AppLayoutProps {
  children: ReactNode
  selectedCategoryId: string | null
  selectedConversationId: string | null
  onSelectCategory: (category: Category | null) => void
  onSelectConversation: (conversationId: string) => void
  onSelectUncategorized: () => void
  onSelectManualsRoot: () => void // エクスプローラーのルート(全フォルダ)を開く
  onSearch: (keyword: string) => void
}

/** 画面全体の骨組み: 左サイドバー(スマホではDrawer) + メインエリア */
export function AppLayout({
  children,
  selectedCategoryId,
  selectedConversationId,
  onSelectCategory,
  onSelectConversation,
  onSelectUncategorized,
  onSelectManualsRoot,
  onSearch,
}: AppLayoutProps) {
  return (
    // dvh(dynamic viewport height)を使う。vhだとスマホのソフトキーボードや
    // アドレスバーで表示領域が縮んだときに下部の入力欄が隠れてしまう
    <Flex h="100dvh">
      <Sidebar
        selectedCategoryId={selectedCategoryId}
        selectedConversationId={selectedConversationId}
        onSelectCategory={onSelectCategory}
        onSelectConversation={onSelectConversation}
        onSelectUncategorized={onSelectUncategorized}
        onSelectManualsRoot={onSelectManualsRoot}
        onSearch={onSearch}
      />
      <Box as="main" flex="1" minW={0} overflowY="auto">
        {children}
      </Box>
    </Flex>
  )
}
