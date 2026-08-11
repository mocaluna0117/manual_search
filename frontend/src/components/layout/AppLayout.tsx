import { Box, Flex } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import type { Category } from '../../graphql/categories'
import { useLayoutMode, type LayoutMode } from '../../lib/settings'
import {
  MobileSidebar,
  SidebarPanel,
  type SidebarSections,
} from './Sidebar'

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

// レイアウト設定 → 左右のパネルに何を出すか(rightがnullなら1枚だけ)
const PANELS: Record<
  LayoutMode,
  { left: SidebarSections; right: SidebarSections | null }
> = {
  single: { left: 'both', right: null },
  'chat-left': { left: 'chat', right: 'manuals' },
  'chat-right': { left: 'manuals', right: 'chat' },
}

/** 画面全体の骨組み: サイドバー(スマホではDrawer) + メインエリア */
export function AppLayout({ children, ...props }: AppLayoutProps) {
  const layout = useLayoutMode()
  const panels = PANELS[layout]

  return (
    // dvh(dynamic viewport height)を使う。vhだとスマホのソフトキーボードや
    // アドレスバーで表示領域が縮んだときに下部の入力欄が隠れてしまう
    <Flex h="100dvh">
      <SidebarPanel side="left" sections={panels.left} showFooter {...props} />
      <Box as="main" flex="1" minW={0} overflowY="auto">
        {children}
      </Box>
      {panels.right && (
        // アカウント欄は左パネルにあるので、右パネルでは出さない
        <SidebarPanel
          side="right"
          sections={panels.right}
          showFooter={false}
          {...props}
        />
      )}
      <MobileSidebar {...props} />
    </Flex>
  )
}
