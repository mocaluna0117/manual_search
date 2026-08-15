import { gql, type TypedDocumentNode } from '@apollo/client'

export interface Category {
  id: string
  name: string
  updatedAt?: string // 詳細表示の「更新日時」列に使う
  totalSize?: number // フォルダ内のファイル合計サイズ(バイト)
  manualCount?: number // フォルダ内のファイル数
}

interface CategoriesData {
  manualCategories: Category[]
}

export const CATEGORIES_QUERY: TypedDocumentNode<CategoriesData> = gql`
  query ManualCategories {
    manualCategories {
      id
      name
      updatedAt
    }
  }
`

// --- 並び替え(ADMIN専用)。渡した順に並び順を振り直す ---

interface ReorderCategoriesData {
  reorderManualCategories: number
}

interface ReorderCategoriesVars {
  ids: string[]
}

export const REORDER_CATEGORIES_MUTATION: TypedDocumentNode<
  ReorderCategoriesData,
  ReorderCategoriesVars
> = gql`
  mutation ReorderManualCategories($ids: [ID!]!) {
    reorderManualCategories(ids: $ids)
  }
`

// --- カテゴリ作成(ADMIN専用) ---

interface CreateCategoryData {
  createManualCategory: Category
}

interface CreateCategoryVars {
  name: string
}

export const CREATE_CATEGORY_MUTATION: TypedDocumentNode<
  CreateCategoryData,
  CreateCategoryVars
> = gql`
  mutation CreateManualCategory($name: String!) {
    createManualCategory(name: $name) {
      id
      name
    }
  }
`

// --- カテゴリ名の変更(ADMIN専用) ---

interface UpdateCategoryData {
  updateManualCategory: Category
}

interface UpdateCategoryVars {
  id: string
  name: string
}

export const UPDATE_CATEGORY_MUTATION: TypedDocumentNode<
  UpdateCategoryData,
  UpdateCategoryVars
> = gql`
  mutation UpdateManualCategory($id: ID!, $name: String!) {
    updateManualCategory(id: $id, name: $name) {
      id
      name
    }
  }
`

// --- カテゴリ削除(ADMIN専用。マニュアルが残っていると失敗する) ---

interface DeleteCategoryData {
  deleteManualCategory: Category
}

interface DeleteCategoryVars {
  id: string
}

export const DELETE_CATEGORY_MUTATION: TypedDocumentNode<
  DeleteCategoryData,
  DeleteCategoryVars
> = gql`
  mutation DeleteManualCategory($id: ID!) {
    deleteManualCategory(id: $id) {
      id
      name
    }
  }
`
