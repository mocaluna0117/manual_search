import { Spinner, VStack } from '@chakra-ui/react'
import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { LoginScreen } from './components/auth/LoginScreen'
import { ChatHome } from './components/chat/ChatHome'
import { AppLayout } from './components/layout/AppLayout'
import {
  ManualExplorer,
  type ExplorerFolder,
} from './components/manual/ManualExplorer'
import { ManualSearchResults } from './components/manual/ManualSearchResults'
import { TrashView } from './components/manual/TrashView'
import { ManualViewerProvider } from './components/manual/ManualViewerProvider'
import type { Category } from './graphql/categories'

// メインエリアに何を表示するか。判別可能ユニオン型で「今どの画面か」を1つの値で表す
type View =
  | { type: 'home' } // 新規チャット
  | { type: 'chat'; conversationId: string } // 既存の会話
  | { type: 'manuals' } // エクスプローラーのルート(全フォルダ)
  | { type: 'category'; category: Category }
  | { type: 'uncategorized' } // カテゴリ未設定のマニュアル一覧
  | { type: 'trash' } // ゴミ箱
  | { type: 'search'; keyword: string }

const VIEW_STORAGE_KEY = 'manualSearch.view'

/** 前回開いていた画面をlocalStorageから復元する(壊れていたらホーム) */
function loadInitialView(): View {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as View
      if (saved && typeof saved === 'object' && 'type' in saved) return saved
    }
  } catch {
    // 壊れたデータは無視してホームへ
  }
  return { type: 'home' }
}

function App() {
  const auth = useAuth()
  const [view, setView] = useState<View>(loadInitialView)

  // 画面を切り替えるたびに保存(リロードしても同じ画面に戻れる)
  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view))
  }, [view])

  const isChat = view.type === 'home' || view.type === 'chat'

  // 認証状態の確認中(リダイレクトから戻った直後など)
  if (auth.isLoading) {
    return (
      <VStack h="100dvh" justify="center">
        <Spinner size="lg" />
      </VStack>
    )
  }

  // 未ログインならログイン画面だけを見せる(アプリ本体は一切見せない)
  if (!auth.isAuthenticated) {
    return <LoginScreen />
  }

  return (
    <ManualViewerProvider>
      <AppLayout
      selectedCategoryId={view.type === 'category' ? view.category.id : null}
      selectedConversationId={view.type === 'chat' ? view.conversationId : null}
      onSelectCategory={(category) =>
        setView(category ? { type: 'category', category } : { type: 'home' })
      }
      onSelectConversation={(conversationId) =>
        setView({ type: 'chat', conversationId })
      }
      onSelectUncategorized={() => setView({ type: 'uncategorized' })}
      onSelectTrash={() => setView({ type: 'trash' })}
      onSelectManualsRoot={() => setView({ type: 'manuals' })}
      onSearch={(keyword) => setView({ type: 'search', keyword })}
    >
      {(view.type === 'manuals' ||
        view.type === 'category' ||
        view.type === 'uncategorized') && (
        <ManualExplorer
          folder={
            view.type === 'category'
              ? view.category
              : view.type === 'uncategorized'
                ? 'uncategorized'
                : null
          }
          onNavigate={(folder: ExplorerFolder) =>
            setView(
              folder === null
                ? { type: 'manuals' }
                : folder === 'uncategorized'
                  ? { type: 'uncategorized' }
                  : { type: 'category', category: folder },
            )
          }
        />
      )}
      {view.type === 'trash' && <TrashView />}
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
          // 復元した会話が削除済み/他ユーザーのものだった場合はホームへ
          onConversationNotFound={() => setView({ type: 'home' })}
        />
      )}
    </AppLayout>
    </ManualViewerProvider>
  )
}

export default App
