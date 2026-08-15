import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Roles, UserRole } from '../auth/roles';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import {
  AutoOrganizeResult,
  DeleteEmptyCategoriesResult,
  Manual,
  ManualDownloadTarget,
  ManualSearchResult,
  ManualUploadTarget,
  ReclassifyCounts,
  ReclassifyStatus,
  RegisterManualResult,
  RestoreCategoriesResult,
} from './model';
import { ManualCategory } from '../category/model';
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

  // 一括ダウンロード用。複数の署名付きURLをまとめて発行する
  // (閲覧できる人はダウンロードもできるので、権限は通常の認証のみ)
  @Query(() => [ManualDownloadTarget])
  manualDownloadUrls(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.getDownloadTargets(ids);
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

  // 全マニュアルの再分類を開始する(数分かかるため裏で実行し、すぐ返す)。
  // 実行中だった場合はfalseを返す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Boolean)
  startReclassifyAll(
    @Args('instruction', { type: () => String, nullable: true })
    instruction?: string,
  ) {
    return this.manualService.startReclassifyAll(instruction);
  }

  // 再分類の進行状況(フロントがポーリングして完了を知る)。
  // 空になったフォルダの一覧は、今も生きていて今も空のものだけに絞って返す
  @Roles(UserRole.ADMIN)
  @Query(() => ReclassifyStatus)
  reclassifyStatus() {
    return this.manualService.reclassifyStatusView();
  }

  // 再分類の対象件数(確認ダイアログの表示用)
  @Roles(UserRole.ADMIN)
  @Query(() => ReclassifyCounts)
  reclassifyCounts() {
    return this.manualService.reclassifyCounts();
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

  // チェックしたファイルをまとめてゴミ箱へ。戻り値は移せた件数
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  deleteManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.deleteMany(ids);
  }

  // ゴミ箱の中身
  @Roles(UserRole.ADMIN)
  @Query(() => [Manual])
  trashedManuals() {
    return this.manualService.trashed();
  }

  // ゴミ箱に入っているフォルダ(中身ごと捨てたもの)
  @Roles(UserRole.ADMIN)
  @Query(() => [ManualCategory])
  trashedCategories() {
    return this.manualService.trashedCategories();
  }

  // ゴミ箱から元に戻す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  restoreManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.restoreMany(ids);
  }

  // 空のフォルダだけをゴミ箱へ移す(再分類後の片付け)。
  // 中身が入っていたら見送るので、マニュアルが巻き添えで消えることはない
  @Roles(UserRole.ADMIN)
  @Mutation(() => DeleteEmptyCategoriesResult)
  deleteEmptyCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.deleteEmptyCategories(ids);
  }

  // フォルダを中身ごと元に戻す
  @Roles(UserRole.ADMIN)
  @Mutation(() => RestoreCategoriesResult)
  restoreCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.restoreCategories(ids);
  }

  // フォルダを中身ごと完全に削除する
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  purgeCategories(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.purgeCategories(ids);
  }

  // ゴミ箱から完全に削除する(実ファイルごと消える)
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  purgeManuals(@Args('ids', { type: () => [ID] }) ids: string[]) {
    return this.manualService.purgeMany(ids);
  }

  // ゴミ箱を空にする
  @Roles(UserRole.ADMIN)
  @Mutation(() => Int)
  emptyTrash() {
    return this.manualService.emptyTrash();
  }

  // PDFをRAGに取り込む(チャンク化)。開始したらすぐ返す
  @Roles(UserRole.ADMIN)
  @Mutation(() => Boolean)
  ingestManual(@Args('id', { type: () => ID }) id: string) {
    // 完了は待たない。進行状況はマニュアルのingestStatusで確認する
    return this.manualService.startIngest(id);
  }
}
