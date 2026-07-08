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
