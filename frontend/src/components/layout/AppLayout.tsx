import { Box, Flex } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import type { Category } from '../../graphql/categories'
import { Sidebar } from './Sidebar'

interface AppLayoutProps {
  children: ReactNode
  selectedCategoryId: string | null
  onSelectCategory: (category: Category | null) => void
}

/** 画面全体の骨組み: 左サイドバー + メインエリア */
export function AppLayout({
  children,
  selectedCategoryId,
  onSelectCategory,
}: AppLayoutProps) {
  return (
    <Flex h="100vh">
      <Sidebar
        selectedCategoryId={selectedCategoryId}
        onSelectCategory={onSelectCategory}
      />
      <Box as="main" flex="1" overflowY="auto">
        {children}
      </Box>
    </Flex>
  )
}
