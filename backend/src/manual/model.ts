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

  @Field()
  mimeType!: string;

  @Field(() => Int)
  size!: number;

  @Field(() => ID, { nullable: true })
  categoryId!: string | null;

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
}

// AI自動分類の実行結果
@ObjectType()
export class AutoOrganizeResult {
  @Field(() => Int)
  movedCount!: number;

  @Field(() => [String])
  createdCategories!: string[];
}

// キーワード検索の1件分。マニュアル本体と、本文がヒットした場合はその抜粋を返す
@ObjectType()
export class ManualSearchResult {
  @Field(() => Manual)
  manual!: Manual;

  @Field(() => String, { nullable: true })
  snippet!: string | null;
}
