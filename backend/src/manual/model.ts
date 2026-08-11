import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IngestStatus } from '../../generated/prisma/client';

// Prismaのenumを、GraphQLスキーマでも使えるように登録する
registerEnumType(IngestStatus, {
  name: 'IngestStatus',
  description: 'PDF取り込みの進行状況',
});

export { IngestStatus };

// アップロード先の情報。フロントはuploadUrlへPDFをPUTし、
// 完了後にfileKeyを添えてregisterManualを呼ぶ
@ObjectType()
export class ManualUploadTarget {
  @Field()
  uploadUrl!: string;

  @Field()
  fileKey!: string;
}

@ObjectType()
export class Manual {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  fileKey!: string;

  @Field()
  fileName!: string;

  // 元ファイルの最終更新日時(同名アップロード時の新旧判定に使う)
  @Field(() => Date, { nullable: true })
  fileLastModified!: Date | null;

  // PDF自体が持つ作成日(取り込み時に読み取る)。一覧の「作成日」列に使う
  @Field(() => Date, { nullable: true })
  pdfCreatedAt!: Date | null;

  @Field()
  mimeType!: string;

  @Field(() => Int)
  size!: number;

  @Field(() => ID, { nullable: true })
  categoryId!: string | null;

  // trueなら手動で分類済み(ピン留め)。AIの再分類では動かさない
  @Field()
  categoryPinned!: boolean;

  @Field(() => IngestStatus)
  ingestStatus!: IngestStatus;

  @Field(() => String, { nullable: true })
  ingestError!: string | null;

  @Field(() => Int, { nullable: true })
  chunkCount!: number | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

// 同名ファイルをアップロードしたときの登録結果の種別
export enum RegisterOutcome {
  CREATED = 'CREATED', // 新規追加
  UPDATED = 'UPDATED', // 同名の既存マニュアルを新しい版で置き換えた
  SKIPPED_OLDER = 'SKIPPED_OLDER', // 既存の方が新しいため取り込まなかった
}

registerEnumType(RegisterOutcome, {
  name: 'RegisterOutcome',
  description: '登録結果(新規/既存を更新/古いためスキップ)',
});

@ObjectType()
export class RegisterManualResult {
  @Field(() => Manual)
  manual!: Manual;

  @Field(() => RegisterOutcome)
  outcome!: RegisterOutcome;

  // 判定に使った2つの更新日時。スキップされた理由を画面で説明するために返す
  // (nullは「その情報が無い」= 比較できなかったことを意味する)
  @Field(() => Date, { nullable: true })
  existingFileLastModified?: Date | null;

  @Field(() => Date, { nullable: true })
  incomingFileLastModified?: Date | null;
}

// AI自動分類の実行結果
@ObjectType()
export class AutoOrganizeResult {
  @Field(() => Int)
  movedCount!: number;

  @Field(() => [String])
  createdCategories!: string[];
}

// 全件再分類の進行状況。数分かかるためリクエストは待たせず、
// フロントはこの状態をポーリングして完了を知る
@ObjectType()
export class ReclassifyStatus {
  @Field()
  running!: boolean;

  @Field(() => Int)
  movedCount!: number;

  @Field(() => [String])
  createdCategories!: string[];

  @Field(() => String, { nullable: true })
  error!: string | null;

  @Field(() => Date, { nullable: true })
  finishedAt!: Date | null;
}

// 再分類の確認ダイアログに出す件数
@ObjectType()
export class ReclassifyCounts {
  @Field(() => Int)
  target!: number; // 再分類の対象(ピン留めを除く)

  @Field(() => Int)
  pinned!: number; // ピン留めされていて動かさない件数
}

// キーワード検索の1件分。マニュアル本体と、本文がヒットした場合はその抜粋を返す
@ObjectType()
export class ManualSearchResult {
  @Field(() => Manual)
  manual!: Manual;

  @Field(() => String, { nullable: true })
  snippet!: string | null;
}
