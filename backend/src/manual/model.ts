import { Field, ObjectType } from '@nestjs/graphql';

// アップロード先の情報。フロントはuploadUrlへPDFをPUTし、
// 完了後にfileKeyを添えてマニュアル登録Mutationを呼ぶ(次ステップで実装)
@ObjectType()
export class ManualUploadTarget {
  @Field()
  uploadUrl: string;

  @Field()
  fileKey: string;
}
