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

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field()
  fileKey!: string;

  @Field()
  fileName!: string;

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
