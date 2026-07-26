import { useState } from 'react'
import { ChatHome } from './components/chat/ChatHome'
import { AppLayout } from './components/layout/AppLayout'
import { CategoryManualList } from './components/manual/CategoryManualList'
import { ManualSearchResults } from './components/manual/ManualSearchResults'
import type { Category } from './graphql/categories'

// メインエリアに何を表示するか。判別可能ユニオン型で「今どの画面か」を1つの値で表す
type View =
  | { type: 'home' } // 新規チャット
  | { type: 'chat'; conversationId: string } // 既存の会話
  | { type: 'category'; category: Category }
  | { type: 'search'; keyword: string }

function App() {
  const [view, setView] = useState<View>({ type: 'home' })

  const isChat = view.type === 'home' || view.type === 'chat'

  return (
    <AppLayout
      selectedCategoryId={view.type === 'category' ? view.category.id : null}
      selectedConversationId={view.type === 'chat' ? view.conversationId : null}
      onSelectCategory={(category) =>
        setView(category ? { type: 'category', category } : { type: 'home' })
      }
      onSelectConversation={(conversationId) =>
        setView({ type: 'chat', conversationId })
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
      {isChat && (
        <ChatHome
          // keyで会話ごとにコンポーネントを作り直す(前の会話の表示が残らないように)
          key={view.type === 'chat' ? view.conversationId : 'new'}
          conversationId={view.type === 'chat' ? view.conversationId : null}
          onConversationCreated={(conversationId) =>
            setView({ type: 'chat', conversationId })
          }
        />
      )}
    </AppLayout>
  )
}

export default App
