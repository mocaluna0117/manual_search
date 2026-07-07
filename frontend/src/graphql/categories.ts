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
