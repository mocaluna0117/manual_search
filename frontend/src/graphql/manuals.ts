import { gql, type TypedDocumentNode } from '@apollo/client'

// --- アップロード先URLの発行 ---

interface CreateUploadUrlData {
  createManualUploadUrl: {
    uploadUrl: string
    fileKey: string
  }
}

interface CreateUploadUrlVars {
  fileName: string
}

export const CREATE_UPLOAD_URL_MUTATION: TypedDocumentNode<
  CreateUploadUrlData,
  CreateUploadUrlVars
> = gql`
  mutation CreateManualUploadUrl($fileName: String!) {
    createManualUploadUrl(fileName: $fileName) {
      uploadUrl
      fileKey
    }
  }
`

// --- アップロード完了後のDB登録 ---

export interface Manual {
  id: string
  title: string
  description: string | null
  fileName: string
  size: number
  categoryId: string | null
}

interface RegisterManualData {
  registerManual: Manual
}

interface RegisterManualVars {
  input: {
    title: string
    description?: string
    fileKey: string
    fileName: string
    size: number
    categoryId?: string
  }
}

export const REGISTER_MANUAL_MUTATION: TypedDocumentNode<
  RegisterManualData,
  RegisterManualVars
> = gql`
  mutation RegisterManual($input: RegisterManualInput!) {
    registerManual(input: $input) {
      id
      title
      description
      fileName
      size
      categoryId
    }
  }
`

// --- 一覧(カテゴリ絞り込み対応) ---

interface ManualsData {
  manuals: Manual[]
}

interface ManualsVars {
  categoryId?: string
}

export const MANUALS_QUERY: TypedDocumentNode<ManualsData, ManualsVars> = gql`
  query Manuals($categoryId: ID) {
    manuals(categoryId: $categoryId) {
      id
      title
      description
      fileName
      size
      categoryId
    }
  }
`

// --- 閲覧用URLの発行 ---

interface DownloadUrlData {
  manualDownloadUrl: string
}

interface DownloadUrlVars {
  id: string
}

export const MANUAL_DOWNLOAD_URL_QUERY: TypedDocumentNode<
  DownloadUrlData,
  DownloadUrlVars
> = gql`
  query ManualDownloadUrl($id: ID!) {
    manualDownloadUrl(id: $id)
  }
`

// --- 削除 ---

interface DeleteManualData {
  deleteManual: Pick<Manual, 'id' | 'title'>
}

interface DeleteManualVars {
  id: string
}

export const DELETE_MANUAL_MUTATION: TypedDocumentNode<
  DeleteManualData,
  DeleteManualVars
> = gql`
  mutation DeleteManual($id: ID!) {
    deleteManual(id: $id) {
      id
      title
    }
  }
`
