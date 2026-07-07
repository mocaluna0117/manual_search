import { Box, Flex } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'

interface AppLayoutProps {
  children: ReactNode
}

/** 画面全体の骨組み: 左サイドバー + メインエリア */
export function AppLayout({ children }: AppLayoutProps) {
  return (
    <Flex h="100vh">
      <Sidebar />
      <Box as="main" flex="1" overflowY="auto">
        {children}
      </Box>
    </Flex>
  )
}
