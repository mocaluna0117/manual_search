import { useState } from 'react'
import { ChatHome } from './components/chat/ChatHome'
import { AppLayout } from './components/layout/AppLayout'
import { CategoryManualList } from './components/manual/CategoryManualList'
import type { Category } from './graphql/categories'

function App() {
  // サイドバーで選択中のカテゴリ。nullならチャットのホーム画面を表示
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null)

  return (
    <AppLayout
      selectedCategoryId={selectedCategory?.id ?? null}
      onSelectCategory={setSelectedCategory}
    >
      {selectedCategory ? (
        <CategoryManualList
          key={selectedCategory.id}
          categoryId={selectedCategory.id}
          categoryName={selectedCategory.name}
        />
      ) : (
        <ChatHome />
      )}
    </AppLayout>
  )
}

export default App
