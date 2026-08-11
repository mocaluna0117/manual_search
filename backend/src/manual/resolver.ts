import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import {
  AutoOrganizeResult,
  Manual,
  ManualSearchResult,
  ManualUploadTarget,
  RegisterManualResult,
} from './model';
import { ManualService } from './service';

@Resolver(() => Manual)
export class ManualResolver {
  constructor(
    private readonly manualService: ManualService,
    private readonly storageService: StorageService,
  ) {}

  // 一覧。categoryIdで絞り込み、uncategorized=trueでカテゴリ未設定のみ
  @Query(() => [Manual])
  manuals(
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
    @Args('uncategorized', { type: () => Boolean, nullable: true })
    uncategorized?: boolean,
  ) {
    return this.manualService.findAll(categoryId, uncategorized);
  }

  @Roles(UserRole.ADMIN)
  @Mutation(() => ManualUploadTarget)
  createManualUploadUrl(
    @Args('fileName') fileName: string,
  ): Promise<ManualUploadTarget> {
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('PDFファイルのみアップロードできます');
    }
    return this.storageService.createUploadUrl(fileName);
  }

  // キーワード検索(タイトル/説明/ファイル名/本文の部分一致)
  @Query(() => [ManualSearchResult])
  searchManuals(@Args('keyword') keyword: string) {
    return this.manualService.search(keyword);
  }

  // PDFを開くための署名付きURL(15分有効)を発行
  @Query(() => String)
  manualDownloadUrl(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.getDownloadUrl(id);
  }

  // アップロード完了後にメタデータをDBへ登録。
  // 同名ファイルがある場合は最終更新日の新しい方を残す(outcomeで結果が分かる)
  @Roles(UserRole.ADMIN)
  @Mutation(() => RegisterManualResult)
  registerManual(@Args('input') input: RegisterManualInput) {
    return this.manualService.register(input);
  }

  // 別カテゴリへ移動(categoryId省略で未分類へ)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  moveManual(
    @Args('id', { type: () => ID }) id: string,
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
  ) {
    return this.manualService.move(id, categoryId ?? null);
  }

  // ピン留めの切り替え(ピン=AIの再分類で動かさない)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  setManualPinned(
    @Args('id', { type: () => ID }) id: string,
    @Args('pinned') pinned: boolean,
  ) {
    return this.manualService.setPinned(id, pinned);
  }

  // 未分類のマニュアルをAIでまとめて自動分類(カテゴリが無ければAIが命名して作る)
  @Roles(UserRole.ADMIN)
  @Mutation(() => AutoOrganizeResult)
  autoOrganizeManuals() {
    return this.manualService.autoOrganize();
  }

  // 複数まとめて移動。戻り値は移動した件数
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  moveManuals(
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('categoryId', { type: () => ID, nullable: true })
    categoryId?: string,
  ) {
    return this.manualService.moveMany(ids, categoryId ?? null);
  }

  // DBの行とストレージの実ファイルを両方削除
  @Roles(UserRole.ADMIN)
  @Mutation(() => Manual)
  deleteManual(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.delete(id);
  }

  // PDFをRAGに取り込む(チャンク化)。戻り値は作成されたチャンク数
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  ingestManual(@Args('id', { type: () => ID }) id: string) {
    return this.manualService.ingest(id);
  }
}
