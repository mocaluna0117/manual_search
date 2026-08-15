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
  updatedAt: string // DBの更新時刻(並べ替えの保険用)
  pdfCreatedAt: string | null // PDF自体が持つ作成日(「作成日」列)
  categoryPinned: boolean // ピン留め済み(AIの再分類で動かない)
  deletedAt?: string | null // ゴミ箱に入れた日時
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
      updatedAt
      pdfCreatedAt
      categoryPinned
    }
  }
`

// --- ピン留めの切り替え(ADMIN専用。ピン=AIの再分類で動かさない) ---

interface SetManualPinnedData {
  setManualPinned: { id: string; categoryPinned: boolean }
}

interface SetManualPinnedVars {
  id: string
  pinned: boolean
}

export const SET_MANUAL_PINNED_MUTATION: TypedDocumentNode<
  SetManualPinnedData,
  SetManualPinnedVars
> = gql`
  mutation SetManualPinned($id: ID!, $pinned: Boolean!) {
    setManualPinned(id: $id, pinned: $pinned) {
      id
      categoryPinned
    }
  }
`

// --- 取り込みの再試行(FAILEDになったとき用) ---

interface IngestManualData {
  ingestManual: boolean // 開始できたらtrue(完了は待たない)
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
        updatedAt
        pdfCreatedAt
        categoryPinned
      }
      snippet
    }
  }
`

// --- まとめて削除(ADMIN専用) ---

interface DeleteManualsData {
  deleteManuals: number
}

interface DeleteManualsVars {
  ids: string[]
}

export const DELETE_MANUALS_MUTATION: TypedDocumentNode<
  DeleteManualsData,
  DeleteManualsVars
> = gql`
  mutation DeleteManuals($ids: [ID!]!) {
    deleteManuals(ids: $ids)
  }
`

// --- ゴミ箱(ADMIN専用) ---

interface TrashedManualsData {
  trashedManuals: Manual[]
}

export const TRASHED_MANUALS_QUERY: TypedDocumentNode<TrashedManualsData> = gql`
  query TrashedManuals {
    trashedManuals {
      id
      title
      fileName
      size
      categoryId
      ingestStatus
      ingestError
      chunkCount
      updatedAt
      pdfCreatedAt
      categoryPinned
      deletedAt
    }
  }
`

interface TrashedCategoriesData {
  trashedCategories: {
    id: string
    name: string
    deletedAt?: string | null
    manualCount?: number
    totalSize?: number
  }[]
}

export const TRASHED_CATEGORIES_QUERY: TypedDocumentNode<TrashedCategoriesData> = gql`
  query TrashedCategories {
    trashedCategories {
      id
      name
      deletedAt
      manualCount
      totalSize
    }
  }
`

interface TrashActionData {
  restoreManuals?: number
  purgeManuals?: number
  emptyTrash?: number
  restoreCategories?: number
  purgeCategories?: number
}

interface IdsVars {
  ids: string[]
}

export const RESTORE_MANUALS_MUTATION: TypedDocumentNode<
  TrashActionData,
  IdsVars
> = gql`
  mutation RestoreManuals($ids: [ID!]!) {
    restoreManuals(ids: $ids)
  }
`

export const PURGE_MANUALS_MUTATION: TypedDocumentNode<
  TrashActionData,
  IdsVars
> = gql`
  mutation PurgeManuals($ids: [ID!]!) {
    purgeManuals(ids: $ids)
  }
`

interface RestoreCategoriesData {
  restoreCategories: {
    restoredCount: number
    // 同名のフォルダが既にあったため、中身だけをそちらへ戻した分
    mergedInto: string[]
  }
}

export const RESTORE_CATEGORIES_MUTATION: TypedDocumentNode<
  RestoreCategoriesData,
  IdsVars
> = gql`
  mutation RestoreCategories($ids: [ID!]!) {
    restoreCategories(ids: $ids) {
      restoredCount
      mergedInto
    }
  }
`

export const PURGE_CATEGORIES_MUTATION: TypedDocumentNode<
  TrashActionData,
  IdsVars
> = gql`
  mutation PurgeCategories($ids: [ID!]!) {
    purgeCategories(ids: $ids)
  }
`

export const EMPTY_TRASH_MUTATION: TypedDocumentNode<TrashActionData> = gql`
  mutation EmptyTrash {
    emptyTrash
  }
`

// --- 一括ダウンロード用のURL発行 ---

export interface ManualDownloadTarget {
  id: string
  title: string
  fileName: string
  url: string
}

interface DownloadUrlsData {
  manualDownloadUrls: ManualDownloadTarget[]
}

interface DownloadUrlsVars {
  ids: string[]
}

export const MANUAL_DOWNLOAD_URLS_QUERY: TypedDocumentNode<
  DownloadUrlsData,
  DownloadUrlsVars
> = gql`
  query ManualDownloadUrls($ids: [ID!]!) {
    manualDownloadUrls(ids: $ids) {
      id
      title
      fileName
      url
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

// --- 全件再分類(ADMIN専用)。数分かかるので開始と進捗確認を分ける ---

interface StartReclassifyData {
  startReclassifyAll: boolean // falseなら既に実行中
}

export const START_RECLASSIFY_MUTATION: TypedDocumentNode<StartReclassifyData> = gql`
  mutation StartReclassifyAll {
    startReclassifyAll
  }
`

/** 再分類で中身が他へ移り、空になったフォルダ */
export interface EmptiedCategory {
  id: string
  name: string
  /** AIの自動分類が作ったフォルダか。falseなら利用者が自分で作った箱 */
  createdByAi: boolean
}

export interface ReclassifyStatus {
  running: boolean
  movedCount: number
  createdCategories: string[]
  emptiedCategories: EmptiedCategory[]
  error: string | null
  finishedAt: string | null
}

interface DeleteEmptyCategoriesData {
  deleteEmptyCategories: {
    /** 実際に消したフォルダのID */
    deletedIds: string[]
    /** 中身が入っていて消さなかったフォルダ名 */
    skipped: string[]
  }
}

export const DELETE_EMPTY_CATEGORIES_MUTATION: TypedDocumentNode<
  DeleteEmptyCategoriesData,
  { ids: string[] }
> = gql`
  mutation DeleteEmptyCategories($ids: [ID!]!) {
    deleteEmptyCategories(ids: $ids) {
      deletedIds
      skipped
    }
  }
`

interface ReclassifyStatusData {
  reclassifyStatus: ReclassifyStatus
}

export const RECLASSIFY_STATUS_QUERY: TypedDocumentNode<ReclassifyStatusData> = gql`
  query ReclassifyStatus {
    reclassifyStatus {
      running
      movedCount
      createdCategories
      emptiedCategories {
        id
        name
        createdByAi
      }
      error
      finishedAt
    }
  }
`

interface ReclassifyCountsData {
  reclassifyCounts: { target: number; pinned: number }
}

export const RECLASSIFY_COUNTS_QUERY: TypedDocumentNode<ReclassifyCountsData> = gql`
  query ReclassifyCounts {
    reclassifyCounts {
      target
      pinned
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
