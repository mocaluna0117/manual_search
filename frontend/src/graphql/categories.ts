import { gql, type TypedDocumentNode } from '@apollo/client'

export interface Category {
  id: string
  name: string
}

interface CategoriesData {
  manualCategories: Category[]
}

export const CATEGORIES_QUERY: TypedDocumentNode<CategoriesData> = gql`
  query ManualCategories {
    manualCategories {
      id
      name
    }
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
