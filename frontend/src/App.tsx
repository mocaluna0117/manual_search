import { useState } from 'react'
import { ChatHome } from './components/chat/ChatHome'
import { AppLayout } from './components/layout/AppLayout'
import { CategoryManualList } from './components/manual/CategoryManualList'
import { ManualSearchResults } from './components/manual/ManualSearchResults'
import type { Category } from './graphql/categories'

// メインエリアに何を表示するか。判別可能ユニオン型で「今どの画面か」を1つの値で表す
type View =
  | { type: 'home' }
  | { type: 'category'; category: Category }
  | { type: 'search'; keyword: string }

function App() {
  const [view, setView] = useState<View>({ type: 'home' })

  return (
    <AppLayout
      selectedCategoryId={view.type === 'category' ? view.category.id : null}
      onSelectCategory={(category) =>
        setView(category ? { type: 'category', category } : { type: 'home' })
      }
      onSearch={(keyword) => setView({ type: 'search', keyword })}
    >
      {view.type === 'category' && (
        <CategoryManualList
          key={view.category.id}
          categoryId={view.category.id}
          categoryName={view.category.name}
        />
      )}
      {view.type === 'search' && (
        <ManualSearchResults key={view.keyword} keyword={view.keyword} />
      )}
      {view.type === 'home' && <ChatHome />}
    </AppLayout>
  )
}

export default App
