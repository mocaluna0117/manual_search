import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

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

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}
