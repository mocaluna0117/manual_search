import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import { Manual, ManualUploadTarget } from './model';
import { ManualService } from './service';

@Resolver(() => Manual)
export class ManualResolver {
  constructor(
    private readonly manualService: ManualService,
    private readonly storageService: StorageService,
  ) {}

  // 一覧。categoryIdを渡すと絞り込み(サイドバーのカテゴリクリック用)
  @Query(() => [Manual])
  manuals(
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
  ) {
    return this.manualService.findAll(categoryId);
  }

  @Mutation(() => ManualUploadTarget)
  createManualUploadUrl(
    @Args('fileName') fileName: string,
  ): Promise<ManualUploadTarget> {
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('PDFファイルのみアップロードできます');
    }
    return this.storageService.createUploadUrl(fileName);
  }

  // PDFを開くための署名付きURL(15分有効)を発行
  @Query(() => String)
  manualDownloadUrl(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.getDownloadUrl(id);
  }

  // アップロード完了後にメタデータをDBへ登録
  @Mutation(() => Manual)
  registerManual(@Args('input') input: RegisterManualInput) {
    return this.manualService.register(input);
  }

  // DBの行とストレージの実ファイルを両方削除
  @Mutation(() => Manual)
  deleteManual(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.delete(id);
  }

  // PDFをRAGに取り込む(チャンク化)。戻り値は作成されたチャンク数
  @Mutation(() => Int)
  ingestManual(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.ingest(id);
  }
}
