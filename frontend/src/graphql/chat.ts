import { gql, type TypedDocumentNode } from '@apollo/client'
import type { RagCitation } from './rag'

export type MessageRole = 'USER' | 'ASSISTANT'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  citations: RagCitation[]
  options: string[] // 絞り込み質問の選択肢(ボタン表示)
  createdAt: string // 発言時刻(吹き出しの下に表示)
}

export interface Conversation {
  id: string
  title: string
}

// --- 履歴一覧(サイドバー) ---

interface ConversationsData {
  conversations: Conversation[]
}

export const CONVERSATIONS_QUERY: TypedDocumentNode<ConversationsData> = gql`
  query Conversations {
    conversations {
      id
      title
    }
  }
`

// --- 1つの会話とそのメッセージ ---

interface ConversationData {
  conversation: Conversation & { messages: ChatMessage[] }
}

interface ConversationVars {
  id: string
}

export const CONVERSATION_QUERY: TypedDocumentNode<
  ConversationData,
  ConversationVars
> = gql`
  query Conversation($id: ID!) {
    conversation(id: $id) {
      id
      title
      messages {
        id
        role
        content
        citations {
          manualId
          title
          snippet
          pageNumber
        }
        options
        createdAt
      }
    }
  }
`

// --- 質問する ---

interface AskData {
  askQuestion: {
    conversationId: string
    message: ChatMessage
  }
}

interface AskVars {
  question: string
  conversationId?: string
  imageBase64?: string
  imageFormat?: string
}

export const ASK_MUTATION: TypedDocumentNode<AskData, AskVars> = gql`
  mutation AskQuestion(
    $question: String!
    $conversationId: ID
    $imageBase64: String
    $imageFormat: String
  ) {
    askQuestion(
      question: $question
      conversationId: $conversationId
      imageBase64: $imageBase64
      imageFormat: $imageFormat
    ) {
      conversationId
      message {
        id
        role
        content
        citations {
          manualId
          title
          snippet
          pageNumber
        }
        options
        createdAt
      }
    }
  }
`

// --- 会話の削除 ---

interface DeleteConversationData {
  deleteConversation: Conversation
}

interface DeleteConversationVars {
  id: string
}

export const DELETE_CONVERSATION_MUTATION: TypedDocumentNode<
  DeleteConversationData,
  DeleteConversationVars
> = gql`
  mutation DeleteConversation($id: ID!) {
    deleteConversation(id: $id) {
      id
      title
    }
  }
`
