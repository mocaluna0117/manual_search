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

export type IngestStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

export interface Manual {
  id: string
  title: string
  fileName: string
  size: number
  categoryId: string | null
  ingestStatus: IngestStatus
  ingestError: string | null
  chunkCount: number | null
}

/** 同名ファイルをアップロードしたときの結果 */
export type RegisterOutcome = 'CREATED' | 'UPDATED' | 'SKIPPED_OLDER'

interface RegisterManualData {
  registerManual: {
    manual: Manual
    outcome: RegisterOutcome
    // 判定に使った更新日時(nullは「不明で比較できなかった」)
    existingFileLastModified: string | null
    incomingFileLastModified: string | null
  }
}

interface RegisterManualVars {
  input: {
    title: string
    fileKey: string
    fileName: string
    size: number
    categoryId?: string
    autoCategorize?: boolean
    fileLastModified?: string // ISO8601。同名アップロード時の新旧判定に使う
    forceReplace?: boolean // スキップされた後に「それでも差し替える」で使う
  }
}

export const REGISTER_MANUAL_MUTATION: TypedDocumentNode<
  RegisterManualData,
  RegisterManualVars
> = gql`
  mutation RegisterManual($input: RegisterManualInput!) {
    registerManual(input: $input) {
      outcome
      existingFileLastModified
      incomingFileLastModified
      manual {
        id
        title
        fileName
        size
        categoryId
      }
    }
  }
`

// --- 一覧(カテゴリ絞り込み対応) ---

interface ManualsData {
  manuals: Manual[]
}

interface ManualsVars {
  categoryId?: string
  uncategorized?: boolean
}

export const MANUALS_QUERY: TypedDocumentNode<ManualsData, ManualsVars> = gql`
  query Manuals($categoryId: ID, $uncategorized: Boolean) {
    manuals(categoryId: $categoryId, uncategorized: $uncategorized) {
      id
      title
      fileName
      size
      categoryId
      ingestStatus
      ingestError
      chunkCount
    }
  }
`

// --- 取り込みの再試行(FAILEDになったとき用) ---

interface IngestManualData {
  ingestManual: number
}

interface IngestManualVars {
  id: string
}

export const INGEST_MANUAL_MUTATION: TypedDocumentNode<
  IngestManualData,
  IngestManualVars
> = gql`
  mutation IngestManual($id: ID!) {
    ingestManual(id: $id)
  }
`

// --- キーワード検索 ---

export interface ManualSearchResult {
  manual: Manual
  snippet: string | null
}

interface SearchManualsData {
  searchManuals: ManualSearchResult[]
}

interface SearchManualsVars {
  keyword: string
}

export const SEARCH_MANUALS_QUERY: TypedDocumentNode<
  SearchManualsData,
  SearchManualsVars
> = gql`
  query SearchManuals($keyword: String!) {
    searchManuals(keyword: $keyword) {
      manual {
        id
        title
        fileName
        size
        categoryId
        ingestStatus
        ingestError
        chunkCount
      }
      snippet
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

// --- カテゴリ間の移動(ADMIN専用) ---

interface MoveManualData {
  moveManual: Pick<Manual, 'id' | 'categoryId'>
}

interface MoveManualVars {
  id: string
  categoryId: string | null
}

export const MOVE_MANUAL_MUTATION: TypedDocumentNode<
  MoveManualData,
  MoveManualVars
> = gql`
  mutation MoveManual($id: ID!, $categoryId: ID) {
    moveManual(id: $id, categoryId: $categoryId) {
      id
      categoryId
    }
  }
`

// --- AIによる自動分類(ADMIN専用) ---

interface AutoOrganizeData {
  autoOrganizeManuals: {
    movedCount: number
    createdCategories: string[]
  }
}

export const AUTO_ORGANIZE_MUTATION: TypedDocumentNode<AutoOrganizeData> = gql`
  mutation AutoOrganizeManuals {
    autoOrganizeManuals {
      movedCount
      createdCategories
    }
  }
`

// --- まとめて移動(ADMIN専用) ---

interface MoveManualsData {
  moveManuals: number
}

interface MoveManualsVars {
  ids: string[]
  categoryId: string | null
}

export const MOVE_MANUALS_MUTATION: TypedDocumentNode<
  MoveManualsData,
  MoveManualsVars
> = gql`
  mutation MoveManuals($ids: [ID!]!, $categoryId: ID) {
    moveManuals(ids: $ids, categoryId: $categoryId)
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
