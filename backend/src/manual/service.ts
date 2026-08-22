import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';
import { fileTypeOf } from '../storage/file-types';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import { looseMatch } from './title-match';
import {
  EmptiedCategory,
  IngestStatus,
  ReclassifyStatus,
  RegisterOutcome,
} from './model';

/** ゴミ箱に入っていない(生きている)マニュアルだけを対象にする条件 */
const ALIVE = { deletedAt: null } as const;

/** ゴミ箱の自動削除までの日数 */
const TRASH_RETENTION_DAYS = 30;

@Injectable()
export class ManualService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ManualService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly rag: RagService,
  ) {}

  /**
   * 起動時に「取り込み中(PROCESSING)」で止まっている行を失敗扱いに戻す。
   *
   * 取り込みはfire-and-forgetで走るため、途中で再起動・デプロイ・OOMが起きると
   * PROCESSINGのまま永久に残り、AI検索の対象にならないまま画面が
   * 「取り込み中…」を出し続ける(ポーリングも止まらない)。
   * FAILEDにしておけば管理者が「再取り込み」で復旧できる。
   */
  async onApplicationBootstrap() {
    const { count } = await this.prisma.manual.updateMany({
      where: { ingestStatus: IngestStatus.PROCESSING },
      data: {
        ingestStatus: IngestStatus.FAILED,
        ingestError:
          'サーバーの再起動により取り込みが中断されました。再取り込みしてください',
      },
    });
    if (count > 0) {
      this.logger.warn(`中断された取り込みを${count}件FAILEDに戻しました`);
    }

    await this.rescueLostManuals();

    // ゴミ箱の自動削除。起動時に1回と、その後は1日ごと
    void this.purgeExpiredTrash().catch(() => undefined);
    setInterval(
      () => void this.purgeExpiredTrash().catch(() => undefined),
      24 * 60 * 60 * 1000,
    ).unref();
  }

  /**
   * ゴミ箱の中のフォルダに入ってしまい、画面のどこにも出てこなくなった
   * マニュアルを未分類へ戻す。
   *
   * サイドバーはゴミ箱のフォルダを出さず、カテゴリが付いているので未分類にも出ず、
   * マニュアル自体は生きているのでゴミ箱にも出ない、という三重の死角になる。
   * 一方で重複チェックには引っかかるため「どこにも無いのに同名だと言われる」。
   * 割り当て側は塞いだので、これは既存データの後始末。
   */
  private async rescueLostManuals() {
    // updateManyはリレーション条件を書けないので、先にIDを集める
    const lost = await this.prisma.manual.findMany({
      where: { ...ALIVE, category: { deletedAt: { not: null } } },
      select: { id: true, title: true },
    });
    if (lost.length === 0) return;
    await this.prisma.manual.updateMany({
      where: { id: { in: lost.map((m) => m.id) } },
      data: { categoryId: null },
    });
    this.logger.warn(
      `ゴミ箱のフォルダに入っていたマニュアル${lost.length}件を未分類に戻しました: ` +
        lost.map((m) => m.title).join(', '),
    );
  }

  /**
   * 鍵付き(管理者だけに見せる)フォルダの中身を隠すための条件。
   *
   * 未分類(categoryIdがnull)は誰でも見えるので、そのままにする。
   * 呼び出し側が権限を渡し忘れても隠れる側に倒すため、既定はfalse。
   *
   * 配列で返してAND句へ入れる。オブジェクトのまま where に展開する形だと、
   * 同じwhereでOR句を使う検索(キーワード検索)で後から書いたORに
   * 上書きされ、除外が黙って消える。実際にそれでMEMBERにも
   * 鍵付きの題名と本文抜粋が出ていたので、構造的に起きない形にする
   */
  private visibleTo(includeAdminOnly: boolean): Prisma.ManualWhereInput[] {
    return includeAdminOnly
      ? []
      : [{ OR: [{ categoryId: null }, { category: { adminOnly: false } }] }];
  }

  findAll(
    categoryId?: string,
    uncategorized?: boolean,
    includeAdminOnly = false,
  ) {
    return this.prisma.manual.findMany({
      // uncategorized=trueなら「カテゴリ未設定」だけに絞る(nullでの絞り込み)
      where: uncategorized
        ? { ...ALIVE, categoryId: null }
        : categoryId
          ? { ...ALIVE, categoryId, AND: this.visibleTo(includeAdminOnly) }
          : { ...ALIVE, AND: this.visibleTo(includeAdminOnly) },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** キーワード検索。タイトル/説明/ファイル名/本文(チャンク)を部分一致で探す */
  async search(keyword: string, includeAdminOnly = false) {
    const kw = keyword.trim();
    if (!kw) return [];

    // mode: 'insensitive' = 大文字小文字を区別しない(ILIKE)
    const contains = { contains: kw, mode: 'insensitive' as const };
    const manuals = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        // 見える範囲の条件と、キーワードの条件はどちらもORを使う。
        // 同じ階層に並べると後に書いた方が前を上書きするため、ANDで束ねる
        AND: [
          ...this.visibleTo(includeAdminOnly),
          {
            OR: [
              { title: contains },
              { fileName: contains },
              { chunks: { some: { content: contains } } },
            ],
          },
        ],
      },
      include: {
        // 本文がヒットした場合に備えて、最初にマッチしたチャンクを1つだけ取る
        chunks: {
          where: { content: contains },
          orderBy: { chunkIndex: 'asc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return manuals.map((manual) => ({
      manual,
      snippet: manual.chunks[0]
        ? this.makeSnippet(manual.chunks[0].content, kw)
        : null,
    }));
  }

  /** ヒット箇所の前後を切り出した抜粋を作る */
  private makeSnippet(content: string, keyword: string, radius = 60) {
    const index = content.toLowerCase().indexOf(keyword.toLowerCase());
    if (index < 0) return content.slice(0, radius * 2);
    const start = Math.max(0, index - radius);
    const end = Math.min(content.length, index + keyword.length + radius);
    const head = start > 0 ? '…' : '';
    const tail = end < content.length ? '…' : '';
    return `${head}${content.slice(start, end)}${tail}`;
  }

  /**
   * アップロード済みファイルのメタデータを登録する。
   * 同名(fileName一致)のマニュアルが既にある場合は最終更新日で新旧を判定し、
   * 新しい方だけを残す(古いものをアップロードした場合は取り込まない)。
   */
  async register(input: RegisterManualInput) {
    // autoCategorize/forceReplaceはDBの列ではないので分離する
    const { autoCategorize, forceReplace, ...data } = input;

    // macOSではファイル名がNFD(濁点・半濁点が結合文字。「パ」=「ハ」+「゚」)で
    // 届くため、そのまま保存すると検索側(NFCで入力される)の部分一致に当たらない。
    // 入口でNFCに揃える。同名判定(fileName一致)が正しく効くためにも必要
    data.title = data.title.normalize('NFC');
    data.fileName = data.fileName.normalize('NFC');

    const existing = await this.prisma.manual.findFirst({
      // ゴミ箱の中とは突き合わせない(捨てたものを差し替え対象にしない)
      where: { ...ALIVE, fileName: data.fileName },
      orderBy: { createdAt: 'desc' },
    });

    // 同名が無ければ通常の新規追加
    if (!existing) {
      const manual = await this.prisma.manual.create({ data });
      // 取り込みは裏で実行(fire-and-forget)。ユーザーを何十秒も待たせないため、
      // awaitせずに即レスポンスを返し、進行状況はingestStatusで見せる
      this.enqueueIngest(manual.id, autoCategorize ?? false);
      return { manual, outcome: RegisterOutcome.CREATED };
    }

    // 新旧の判定に使う「元ファイルの最終更新日」。
    // 既存側がnullのケース(この機能より前に登録されたマニュアル)は「不明」として扱う。
    // 登録日時(createdAt)で代用してはいけない: それはアップロードした時刻であって
    // ファイルの更新日ではないため、必ず「既存の方が新しい」と誤判定してしまう
    const existingTime = existing.fileLastModified?.getTime();
    const incomingTime = data.fileLastModified?.getTime();
    const compared = {
      existingFileLastModified: existing.fileLastModified,
      incomingFileLastModified: data.fileLastModified ?? null,
    };

    // どちらかの更新日が不明なら比較できない。
    // 利用者は「このファイルで更新したい」という意図でアップロードしているので、
    // 判断できない場合は差し替える(重複を増やさない・意図を尊重する)
    const canCompare = existingTime !== undefined && incomingTime !== undefined;

    // 既存の方が新しい(または同時刻)なら取り込まない
    if (!forceReplace && canCompare && incomingTime <= existingTime) {
      // アップロード済みの実ファイルは迷子になるので消す。
      // ただし既存と同じキーを送ってきた場合に本体を消さないよう必ず確認する
      if (data.fileKey !== existing.fileKey) {
        await this.storage.deleteObject(data.fileKey).catch(() => undefined);
      }
      return {
        manual: existing,
        outcome: RegisterOutcome.SKIPPED_OLDER,
        ...compared,
      };
    }

    // 差し替える: 既存を同じIDのまま更新する。
    // IDを保つことで、過去の会話に残った引用リンクも生き続ける
    const oldFileKey = existing.fileKey;
    const manual = await this.prisma.$transaction(async (tx) => {
      // 旧版のチャンクは必ずここで消す。残すと取り込みが失敗した場合に
      // 「新しいPDFに差し替わったのに、AIは旧版の内容で回答する」状態になる
      await tx.manualChunk.deleteMany({ where: { manualId: existing.id } });
      return tx.manual.update({
        where: { id: existing.id },
        data: {
          title: data.title,
          // カテゴリは未指定なら既存の設定を維持する
          categoryId: data.categoryId ?? existing.categoryId,
          fileKey: data.fileKey,
          fileName: data.fileName,
          fileLastModified: data.fileLastModified,
          size: data.size,
          // 中身が変わったので取り込みをやり直す
          ingestStatus: IngestStatus.PENDING,
          ingestError: null,
          chunkCount: null,
          ingestedAt: null,
        },
      });
    });
    // 旧ファイルはもう参照されないので削除(失敗しても登録は成功扱い)
    if (oldFileKey !== data.fileKey) {
      await this.storage.deleteObject(oldFileKey).catch(() => undefined);
    }
    this.enqueueIngest(manual.id, autoCategorize ?? false);
    return { manual, outcome: RegisterOutcome.UPDATED, ...compared };
  }

  /** 手動での(再)取り込み。FAILEDになったマニュアルのリトライ用 */
  /** 取り込みを最後まで待つ(一括再取り込みスクリプト用) */
  async ingest(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    await this.runIngest(id);
    const updated = await this.prisma.manual.findUniqueOrThrow({
      where: { id },
    });
    return updated.chunkCount ?? 0;
  }

  /**
   * 取り込みを裏で開始し、すぐ返す(画面から押す「再取り込み」用)。
   * スキャンPDFの書き起こしがあると数分かかりALBのタイムアウトを超えるため、
   * 待たせずに進行状況をDBのステータスで見せる。
   * 先にPROCESSINGへ変えておくことで、呼び出し直後の一覧に「取り込み中」が出る
   */
  async startIngest(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    await this.prisma.manual.update({
      where: { id },
      data: { ingestStatus: IngestStatus.PROCESSING, ingestError: null },
    });
    this.enqueueIngest(id);
    return true;
  }

  /** 取り込みの実行本体。結果(成功/失敗)は例外でなくDBのステータスに記録する */
  /**
   * 取り込みの順番待ち。
   *
   * 取り込みはPDFの解析と埋め込みで重く、RAGは0.5 vCPU/1GBの1タスクしかない。
   * まとめてアップロードすると同時に何本も流れ込み、RAGが応答できなくなって
   * ヘルスチェックに落ち、ECSに停止させられる(実際に11件同時で全滅した)。
   * 1本ずつ順番に流して、詰まらせない。
   *
   * 単一タスク前提の簡易な仕組み。Cloud Runのように複数に増える構成へ移ったら
   * ジョブキューに置き換える(docs/b-plan-implementation-handbook.md の 5.9)
   */
  private ingestQueue: Promise<unknown> = Promise.resolve();

  /** 取り込みを順番待ちに入れる(呼び出し側は待たない) */
  private enqueueIngest(id: string, autoCategorize = false) {
    this.ingestQueue = this.ingestQueue
      .catch(() => undefined) // 前の失敗で列を止めない
      .then(() => this.runIngest(id, autoCategorize));
  }

  private async runIngest(id: string, autoCategorize = false) {
    try {
      const manual = await this.prisma.manual.findUniqueOrThrow({
        where: { id },
      });
      await this.prisma.manual.update({
        where: { id },
        data: { ingestStatus: IngestStatus.PROCESSING, ingestError: null },
      });

      // Pythonが読めるように署名付きURLを発行して渡す(バケットの認証情報は渡さない)。
      // ragコンテナから到達できる内部ネットワーク向けのURLを使う
      const downloadUrl = await this.storage.createInternalDownloadUrl(
        manual.fileKey,
        manual.fileName,
      );
      const { chunkCount, pdfCreatedAt } = await this.rag.ingest(
        manual.id,
        downloadUrl,
        // 形式ごとに読み方が違うので、拡張子が分かるようファイル名も渡す
        manual.fileName,
      );

      // 読み取れた分をまず記録する。ここではまだCOMPLETEDにしない
      await this.prisma.manual.update({
        where: { id },
        data: {
          chunkCount,
          ingestedAt: new Date(),
          // 読み取れたときだけ更新する(既に入っている値を消さない)
          ...(pdfCreatedAt ? { pdfCreatedAt } : {}),
        },
      });

      // 「AIにおまかせ」指定なら、ここでカテゴリを割り当てる。
      //
      // 分類より先にCOMPLETEDにしてはいけない。画面は「取り込みが終わった=
      // 置き場所が決まった」と見なすため、分類が終わる前に完了扱いにすると
      // 「未分類に入りました」と表示した直後にAIが別のフォルダへ移し、
      // 未分類を見ても無い、という食い違いが起きる
      if (autoCategorize) {
        await this.autoCategorizeOne(id);
      }

      // 置き場所まで決まってから完了にする
      await this.prisma.manual.update({
        where: { id },
        data: { ingestStatus: IngestStatus.COMPLETED },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`取り込み失敗 manual=${id}: ${message}`);
      await this.prisma.manual
        .update({
          where: { id },
          data: { ingestStatus: IngestStatus.FAILED, ingestError: message },
        })
        .catch(() => undefined); // マニュアル自体が削除済みの場合は無視
    }
  }

  /** 未分類(かつ取り込み済み)のマニュアルをAIでまとめて自動分類する */
  /** 未分類のマニュアルをAIで分類する(必要なら新カテゴリも作る) */
  async autoOrganize() {
    return this.organizeManuals(
      { categoryId: null },
      true,
      undefined,
      'UNCATEGORIZED',
    );
  }

  /**
   * 全マニュアルを工種・業務分野ごとのフォルダへ再分類し直す(チャットの管理操作用)。
   * 必要ならAIが新しいフォルダも作る。既存の分類は上書きされるため、
   * 呼び出し側で必ず確認を挟むこと。instructionは管理者が指定した分類方針
   */
  async reclassifyAll(instruction?: string) {
    return this.organizeManuals({}, true, instruction, 'ALL');
  }

  // 再分類の進行状況。数分かかる処理をリクエストで待たせないため、
  // 裏で走らせて状態だけを持つ(単一コンテナ前提の簡易ジョブ管理)
  private reclassifyJob: ReclassifyStatus = {
    running: false,
    movedCount: 0,
    createdCategories: [],
    emptiedCategories: [],
    movedToLocked: [],
    skippedLocked: [],
    error: null,
    finishedAt: null,
  };

  get reclassifyStatus(): ReclassifyStatus {
    return this.reclassifyJob;
  }

  /**
   * 全件再分類をバックグラウンドで開始する。既に実行中ならfalseを返す。
   * onFinishは完了/失敗時に呼ばれる(チャット経路が会話へ結果を書くために使う)
   */
  startReclassifyAll(
    instruction?: string,
    onFinish?: (result: {
      ok: boolean;
      movedCount: number;
      createdCategories: string[];
      emptiedCategories: EmptiedCategory[];
      movedToLocked: string[];
      skippedLocked: string[];
      error?: string;
    }) => void,
  ): boolean {
    if (this.reclassifyJob.running) return false;
    this.reclassifyJob = {
      running: true,
      movedCount: 0,
      createdCategories: [],
      emptiedCategories: [],
      movedToLocked: [],
      skippedLocked: [],
      error: null,
      finishedAt: null,
    };
    void this.reclassifyAll(instruction)
      .then(
        ({
          movedCount,
          createdCategories,
          emptiedCategories,
          movedToLocked,
          skippedLocked,
        }) => {
          this.reclassifyJob = {
            running: false,
            movedCount,
            createdCategories,
            emptiedCategories,
            movedToLocked,
            skippedLocked,
            error: null,
            finishedAt: new Date(),
          };
          onFinish?.({
            ok: true,
            movedCount,
            createdCategories,
            emptiedCategories,
            movedToLocked,
            skippedLocked,
          });
        },
      )
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : '不明なエラー';
        this.reclassifyJob = {
          running: false,
          movedCount: 0,
          createdCategories: [],
          emptiedCategories: [],
          movedToLocked: [],
          skippedLocked: [],
          error,
          finishedAt: new Date(),
        };
        onFinish?.({
          ok: false,
          movedCount: 0,
          createdCategories: [],
          emptiedCategories: [],
          movedToLocked: [],
          skippedLocked: [],
          error,
        });
      });
    return true;
  }

  /** そのフォルダに入っている(ゴミ箱以外の)マニュアルの数 */
  countInCategory(categoryId: string) {
    return this.prisma.manual.count({
      where: { ...ALIVE, categoryId },
    });
  }

  /** 再分類の対象件数(ピン留めを除く)とピン留め件数 */
  async reclassifyCounts() {
    const [target, pinned, locked] = await Promise.all([
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: false,
          // 実際に動かす件数を返す。鍵付きの中身は対象外なので、
          // ここで数えると確認画面の件数が実際より多くなる
          AND: [
            { OR: [{ categoryId: null }, { category: { adminOnly: false } }] },
          ],
        },
      }),
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: true,
        },
      }),
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: false,
          category: { adminOnly: true },
        },
      }),
    ]);
    return { target, pinned, locked };
  }

  /**
   * 対象マニュアルをAIで分類してDBへ反映する共通処理。
   * 1回のLLM呼び出しに全件を入れると応答JSONが出力上限(4000トークン)で
   * 途中で切れるため、バッチに分けて呼ぶ
   */
  private async organizeManuals(
    where: Prisma.ManualWhereInput,
    allowNew: boolean,
    instruction?: string,
    // 元に戻せるようにするため、どの操作かを記録する
    kind: 'ALL' | 'SELECTED' | 'UNCATEGORIZED' = 'ALL',
  ) {
    const manuals = await this.prisma.manual.findMany({
      // ピン留め(手動分類)されたものはAIの分類で動かさない。
      //
      // 鍵付きフォルダの中身も、どの経路でも動かさない。AIが別の箱へ移すと
      // 隠していた資料が全員に見える場所へ出てしまう。しかもAIが新しく作る
      // フォルダは必ず鍵なしなので、行き先が公開になる確率は低くない。
      // 鍵付きから出したいときは、一覧でドラッグするか、チャットで
      // 「〇〇を△△フォルダに移動して」と1件ずつ指示する(意図が明確な操作に限る)
      where: {
        ...ALIVE,
        ingestStatus: IngestStatus.COMPLETED,
        categoryPinned: false,
        // 呼び出し側の条件もANDの中に入れる。同じ階層に展開すると、
        // キーが衝突したときに黙って片方が消える(それで実際に漏れた)
        AND: [
          where,
          { OR: [{ categoryId: null }, { category: { adminOnly: false } }] },
        ],
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
    });

    // 鍵付きフォルダの中にあって、対象から外した分の名前。
    // 「1件も動かさなかった」ときこそ理由が要るので、早期returnより前で数える
    const lockedOut = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        ingestStatus: IngestStatus.COMPLETED,
        categoryPinned: false,
        AND: [where, { category: { adminOnly: true } }],
      },
      select: { title: true },
      orderBy: { title: 'asc' },
    });
    const skippedLocked = lockedOut.map((m) => m.title);

    if (manuals.length === 0) {
      return {
        movedCount: 0,
        createdCategories: [],
        emptiedCategories: [],
        moved: [] as {
          manualId: string;
          categoryName: string;
          adminOnly: boolean;
          title: string;
        }[],
        movedToLocked: [] as string[],
        skippedLocked,
      };
    }

    // 1回の呼び出し時間とレスポンスJSONのトークン量の両方に余裕を持たせる。
    // (80件だと応答が出力上限4000トークンに接近し、通信も1分を超えやすい)
    // 管理者が蓄積した分類ルール(「〜は〜のフォルダへ」)を最優先で効かせる
    const rules = await this.classificationRules();

    // 実行前のフォルダごとの件数を控える。分類が終わったあとに取り直して
    // 「前は入っていたのに空になったフォルダ」を割り出す
    const countsBefore = await this.categoryManualCounts();

    const BATCH_SIZE = 50;
    let movedCount = 0;
    const createdCategories: string[] = [];
    const moved: {
      manualId: string;
      categoryName: string;
      adminOnly: boolean;
    }[] = [];
    for (let i = 0; i < manuals.length; i += BATCH_SIZE) {
      const batch = manuals.slice(i, i + BATCH_SIZE);
      // カテゴリはバッチごとに取り直す(前のバッチが作った新カテゴリを次も使えるように)。
      // ゴミ箱の中のフォルダは候補に出さない(選ばれても入れられないため)。
      // 鍵付きフォルダは候補に含める。分類を実行できるのは管理者だけで、
      // 鍵付きの中身も管理者には見えているため、行き先から外すと
      // 「あのフォルダに入れて」という指示が黙って無視される
      const categories = await this.prisma.manualCategory.findMany({
        where: ALIVE,
      });
      const assignments = await this.rag.organize(
        batch.map((m) => ({
          manualId: m.id,
          title: m.title,
          snippet: m.chunks[0]?.content.slice(0, 120) ?? '',
        })),
        categories.map((c) => c.name),
        allowNew,
        instruction,
        rules,
      );
      const result = await this.applyAssignments(assignments, allowNew);
      movedCount += result.movedCount;
      createdCategories.push(...result.createdCategories);
      moved.push(...result.moved);
    }
    const emptiedCategories = await this.findEmptiedCategories(countsBefore);
    // 題名を添えて返す(呼び出し側はどのファイルがどこへ入ったかを画面に出す)
    const titleById = new Map(manuals.map((m) => [m.id, m.title]));
    const movedWithTitles = moved.map((m) => ({
      ...m,
      title: titleById.get(m.manualId) ?? '',
    }));
    // 動かす前の分類を控える。AIの再分類は一度に何十件も動かすので、
    // 思っていたのと違ったときに手で戻すのは現実的でない。
    // 「その後に人が手で動かしたもの」を巻き込まないよう、動いた先(after)も持つ
    if (movedCount > 0) {
      const categoryBefore = new Map(manuals.map((m) => [m.id, m.categoryId]));
      const categoryIdByName = new Map(
        (
          await this.prisma.manualCategory.findMany({
            where: { name: { in: moved.map((m) => m.categoryName) }, ...ALIVE },
            select: { id: true, name: true },
          })
        ).map((c) => [c.name, c.id]),
      );
      await this.prisma.reclassifySnapshot.create({
        data: {
          kind,
          movedCount,
          createdCategories: createdCategories.length
            ? createdCategories
            : undefined,
          entries: moved.map((m) => ({
            manualId: m.manualId,
            before: categoryBefore.get(m.manualId) ?? null,
            after: categoryIdByName.get(m.categoryName) ?? null,
          })),
        },
      });
    }

    return {
      movedCount,
      createdCategories,
      emptiedCategories,
      moved: movedWithTitles,
      // 鍵付きフォルダへ入れた分。呼び出し側は必ず利用者に伝える。
      // 黙って入れると、一般利用者から見えなくなったことに誰も気づけない
      movedToLocked: movedWithTitles
        .filter((m) => m.adminOnly)
        .map((m) => m.title),
      // 鍵付きの中にあって動かさなかった分。黙って外すと
      // 「再分類したのに直っていない」ようにしか見えない
      skippedLocked,
    };
  }

  /** 生きているフォルダごとの、生きているマニュアル件数 */
  private async categoryManualCounts(): Promise<Map<string, number>> {
    const rows = await this.prisma.manual.groupBy({
      by: ['categoryId'],
      where: ALIVE,
      _count: { _all: true },
    });
    return new Map(
      rows
        .filter((r) => r.categoryId !== null)
        .map((r) => [r.categoryId as string, r._count._all]),
    );
  }

  /**
   * 分類の前後を比べて「中身があったのに空になったフォルダ」を返す。
   * もともと空だったフォルダは対象にしない(この分類で空になったわけではないため)。
   * 消すかどうかは利用者が決めるので、ここでは候補を挙げるだけ
   */
  private async findEmptiedCategories(countsBefore: Map<string, number>) {
    const countsAfter = await this.categoryManualCounts();
    const emptiedIds = [...countsBefore.entries()]
      .filter(([id, before]) => before > 0 && (countsAfter.get(id) ?? 0) === 0)
      .map(([id]) => id);
    if (emptiedIds.length === 0) return [];
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: emptiedIds }, ...ALIVE },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, createdByAi: true },
    });
    return categories;
  }

  /**
   * 選んだマニュアルだけをAIで分類し直す。
   *
   * 合うフォルダが無ければ新しく作る(allowNew=true)。既存に無理に押し込むと
   * 分類の意味が薄れるため、必要なら箱を増やす方を選ぶ。
   * ピン留めされたものは動かさない(ピン留めは「AIに動かされたくない」という
   * 意思表示なので、まとめて選ばれても尊重する)。黙って残すと直ったように
   * 見えてしまうので、件数を返して画面で伝える。
   */
  async reclassifySelected(ids: string[]) {
    if (ids.length === 0) {
      return {
        movedCount: 0,
        skippedPinned: [],
        skippedNotReady: [],
        skippedLocked: [],
        moved: [] as {
          title: string;
          categoryName: string;
          adminOnly: boolean;
        }[],
        createdCategories: [],
      };
    }
    // 対象になり得るものと、ならないものを先に分ける(理由を伝えるため)
    const targets = await this.prisma.manual.findMany({
      where: { id: { in: ids }, ...ALIVE },
      select: {
        id: true,
        title: true,
        categoryPinned: true,
        ingestStatus: true,
        category: { select: { adminOnly: true } },
      },
    });
    const skippedPinned = targets
      .filter((m) => m.categoryPinned)
      .map((m) => m.title);
    // 取り込みが終わっていないものは中身が読めないので分類できない
    const skippedNotReady = targets
      .filter(
        (m) => !m.categoryPinned && m.ingestStatus !== IngestStatus.COMPLETED,
      )
      .map((m) => m.title);
    // 鍵付きフォルダの中身は動かさない。選んだのに黙って何も起きないと
    // 「効かなかった」ようにしか見えないので、名前を返して画面で伝える
    const skippedLocked = targets
      .filter(
        (m) =>
          !m.categoryPinned &&
          m.ingestStatus === IngestStatus.COMPLETED &&
          m.category?.adminOnly === true,
      )
      .map((m) => m.title);

    const result = await this.organizeManuals(
      { id: { in: ids } },
      true,
      undefined,
      'SELECTED',
    );

    return {
      movedCount: result.movedCount,
      skippedPinned,
      skippedNotReady,
      skippedLocked,
      moved: result.moved.map((m) => ({
        title: m.title,
        categoryName: m.categoryName,
        adminOnly: m.adminOnly,
      })),
      createdCategories: result.createdCategories,
    };
  }

  /**
   * 直前の再分類の控え(まだ戻していないもの)。画面に「元に戻す」を出すかの判断に使う
   */
  async lastReclassify() {
    const snap = await this.prisma.reclassifySnapshot.findFirst({
      where: { undoneAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!snap) return null;
    return {
      id: snap.id,
      kind: snap.kind,
      movedCount: snap.movedCount,
      createdCategories: (snap.createdCategories as string[] | null) ?? [],
      createdAt: snap.createdAt,
    };
  }

  /**
   * 直前の再分類を元に戻す。
   *
   * 戻すのは「AIが動かしたあと、人が触っていないマニュアル」だけ。
   * 再分類のあとに手でフォルダを移したものまで戻すと、その作業を
   * 黙って取り消すことになるので、今の分類が動かした先と違うものは飛ばす。
   */
  async undoLastReclassify() {
    const snap = await this.prisma.reclassifySnapshot.findFirst({
      where: { undoneAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!snap) {
      throw new BadRequestException('元に戻せる再分類がありません');
    }
    const entries = snap.entries as {
      manualId: string;
      before: string | null;
      after: string | null;
    }[];

    const current = await this.prisma.manual.findMany({
      where: { id: { in: entries.map((e) => e.manualId) }, ...ALIVE },
      select: { id: true, title: true, categoryId: true },
    });
    const byId = new Map(current.map((m) => [m.id, m]));

    const restored: string[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      const manual = byId.get(entry.manualId);
      if (!manual) continue; // 消された分は何もしない
      if (manual.categoryId !== entry.after) {
        // 再分類のあとに人が動かしている。その判断を尊重して触らない
        skipped.push(manual.title);
        continue;
      }
      if (manual.categoryId === entry.before) continue; // すでに元の場所
      await this.prisma.manual.update({
        where: { id: manual.id },
        data: { categoryId: entry.before },
      });
      restored.push(manual.title);
    }

    await this.prisma.reclassifySnapshot.update({
      where: { id: snap.id },
      data: { undoneAt: new Date() },
    });

    return {
      restoredCount: restored.length,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 10),
      // 戻すと空になるフォルダ。消すかどうかは利用者に決めてもらう
      createdCategories: (snap.createdCategories as string[] | null) ?? [],
    };
  }

  /** 1件だけAIで分類する(アップロード時の「AIにおまかせ」用)。失敗しても取り込みは成功扱い */
  private async autoCategorizeOne(manualId: string) {
    try {
      const manual = await this.prisma.manual.findUnique({
        where: { id: manualId },
        include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
      });
      if (!manual || manual.categoryId) return;
      // アップロード直後の自動分類では、鍵付きフォルダを行き先にしない。
      //
      // 分類が終わるのは(書き起こしを挟むと)取り込みの数分後で、そのとき
      // アップロード画面を閉じていると「鍵付きへ入って一般利用者から
      // 見えなくなった」ことを伝える手段が無い。黙って隠すことになるので、
      // ここでは候補から外す。鍵付きへ入れたいときは、あとから
      // 一覧でドラッグするか、チャットで移動を指示する
      const categories = await this.prisma.manualCategory.findMany({
        where: { ...ALIVE, adminOnly: false },
      });
      const assignments = await this.rag.organize(
        [
          {
            manualId: manual.id,
            title: manual.title,
            snippet: manual.chunks[0]?.content.slice(0, 120) ?? '',
          },
        ],
        categories.map((c) => c.name),
        true,
        undefined,
        await this.classificationRules(),
      );
      // 候補から外していても、AIが名前を言い当てた場合に備えてここでも止める
      await this.applyAssignments(assignments, true, false);
    } catch (e) {
      // 分類の失敗は致命的ではない(未分類のまま残るだけ)
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`自動分類失敗 manual=${manualId}: ${message}`);
    }
  }

  /** 管理者が蓄積した分類ルールを登録順で返す(分類プロンプトに注入する) */
  private async classificationRules(): Promise<string[]> {
    const rules = await this.prisma.classificationRule.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rules.map((r) => r.text);
  }

  /** AIの割り当て結果をDBに反映する(allowNew=trueならカテゴリが無ければ作る) */
  private async applyAssignments(
    assignments: { manualId: string; category: string }[],
    allowNew = true,
    allowLockedDestination = true,
  ) {
    const createdCategories: string[] = [];
    // どのマニュアルをどのフォルダへ入れたか。選んだファイルだけを
    // 分類したときに、1件ずつ結果を見せられるようにする。
    // 行き先が鍵付きかどうかも返す(黙って隠すことにならないよう画面で伝える)
    const moved: {
      manualId: string;
      categoryName: string;
      adminOnly: boolean;
    }[] = [];
    for (const assignment of assignments) {
      const name = assignment.category.trim();
      if (!name) continue;
      let category = await this.prisma.manualCategory.findFirst({
        // ゴミ箱の中のフォルダには絶対に入れない。入れてしまうと画面のどこにも
        // 出てこない(サイドバーはゴミ箱のフォルダを出さず、未分類でもなく、
        // マニュアル自体は生きているのでゴミ箱にも出ない)迷子になる
        where: {
          name,
          ...ALIVE,
          ...(allowLockedDestination ? {} : { adminOnly: false }),
        },
      });
      if (!category) {
        // 既存カテゴリ限定モードでは、AIが指示を破って作った未知の名前は無視する
        if (!allowNew) continue;
        // 同名がゴミ箱にあっても作れる(一意なのは生きているフォルダの中だけ)
        category = await this.prisma.manualCategory.create({
          data: { name, createdByAi: true },
        });
        createdCategories.push(name);
      }
      await this.prisma.manual.update({
        where: { id: assignment.manualId },
        data: { categoryId: category.id },
      });
      moved.push({
        manualId: assignment.manualId,
        categoryName: category.name,
        adminOnly: category.adminOnly,
      });
    }
    return { movedCount: moved.length, createdCategories, moved };
  }

  /**
   * 画面に出る名前を変える。
   *
   * 変えるのは表示名(title)だけで、元のファイル名(fileName)は触らない。
   * fileNameは同名アップロードの新旧判定とダウンロード時のファイル名に
   * 使っているので、ここで書き換えると「同じ資料の更新版を上げたのに
   * 別物として増える」ことになる。
   */
  async rename(id: string, title: string) {
    const trimmed = title.trim().normalize('NFC');
    if (!trimmed) {
      throw new BadRequestException('名前を入力してください');
    }
    const manual = await this.prisma.manual.findFirst({
      where: { id, ...ALIVE },
    });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    if (trimmed === manual.title) return manual; // 変わっていなければ何もしない

    const updated = await this.prisma.manual.update({
      where: { id },
      data: { title: trimmed.slice(0, 200) },
    });

    // ベクトルは取り込み時に「タイトル\n本文」で作っているため、
    // 名前を変えると意味検索だけが古い名前のまま取り残される。
    // 本文は変わっていないので、埋め込みだけを作り直す(裏で実行)。
    // 失敗しても名前の変更自体は成立させる(キーワード・タイトル検索は
    // 検索時にDBを読むので、こちらは即座に反映されている)
    void this.rag.reembedTitle(id).catch((e: unknown) => {
      this.logger.error(
        `名前変更後の検索用データ更新に失敗 manual=${id}: ` +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
    });
    return updated;
  }

  /** マニュアルを別カテゴリへ移動する(categoryId=nullで未分類へ) */
  async move(id: string, categoryId: string | null) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    if (categoryId) {
      // ゴミ箱の中のフォルダへは移せない(移すと画面から見えなくなるため)
      const category = await this.prisma.manualCategory.findFirst({
        where: { id: categoryId, ...ALIVE },
      });
      if (!category) {
        throw new BadRequestException('移動先のカテゴリが見つかりません');
      }
    }
    // ピン留めは移動では変えない(右クリックの「ピン留め」でだけ切り替える)。
    // 移動しただけで再分類の対象から外れると、意図せず固定される
    return this.prisma.manual.update({
      where: { id },
      data: { categoryId },
    });
  }

  /** 複数のマニュアルをまとめて移動する。戻り値は移動した件数 */
  async moveMany(ids: string[], categoryId: string | null) {
    if (ids.length === 0) return 0;
    if (categoryId) {
      const category = await this.prisma.manualCategory.findFirst({
        where: { id: categoryId, ...ALIVE },
      });
      if (!category) {
        throw new BadRequestException('移動先のカテゴリが見つかりません');
      }
    }
    const result = await this.prisma.manual.updateMany({
      where: { id: { in: ids } },
      data: { categoryId }, // ピン留めは変えない(move参照)
    });
    return result.count;
  }

  /**
   * 名前を手がかりに1件だけ移動する(チャットからの「〇〇を△△に入れて」用)。
   * 取り違えて動かさないよう、曖昧なときは移動せず候補を返す
   */
  async moveByName(manualQuery: string, folderQuery: string) {
    const manualNeedle = manualQuery.normalize('NFC').trim();
    const folderNeedle = folderQuery.normalize('NFC').trim();
    if (!manualNeedle || !folderNeedle) {
      return { status: 'invalid' as const };
    }

    const manuals = await this.prisma.manual.findMany({
      where: {
        title: { contains: manualNeedle, mode: 'insensitive' },
        ...ALIVE,
      },
      orderBy: { title: 'asc' },
    });
    // 見つからないときは、空白の入り方の違いを吸収して探し直す。
    // AIは「ベルックス(全角空白区切り)FSタイプ 施工説明書」のように全角空白で
    // 区切った題名を渡してくることがあり、そのままでは当たらない
    if (manuals.length === 0) {
      const all = await this.prisma.manual.findMany({
        where: ALIVE,
        orderBy: { title: 'asc' },
      });
      const { same, similar } = looseMatch(manualNeedle, all);
      if (same.length === 0) {
        // 近いものを候補として返す。まとめての移動はできないので、
        // 呼び出し側で「1件ずつ選んでください」と案内する
        return { status: 'manual_not_found' as const, manuals: similar };
      }
      manuals.push(...same);
    }
    if (manuals.length > 1) {
      // 候補をボタンで選べるようにしてあるので、押されたときは題名がそのまま届く。
      // 完全に一致する1件があればそれで確定する(部分一致のままだと
      // 「ANDPAD導入周知文」が「ANDPAD導入周知文書」も拾って選び直しになる)
      const exact = manuals.filter(
        (m) =>
          m.title.normalize('NFC').toLowerCase() === manualNeedle.toLowerCase(),
      );
      if (exact.length !== 1) {
        return { status: 'manual_ambiguous' as const, manuals };
      }
      manuals.length = 0;
      manuals.push(exact[0]);
    }
    const manual = manuals[0];

    // 「未分類」への指定は分類を外す操作として扱う
    if (/^(未分類|分類なし|なし)$/.test(folderNeedle)) {
      const moved = await this.move(manual.id, null);
      return {
        status: 'moved' as const,
        manual: moved,
        folderName: '未分類',
        folderAdminOnly: false,
      };
    }

    // 鍵付きフォルダも行き先にできる(移動を頼めるのは管理者だけで、
    // 鍵の中身も見えているため)。ゴミ箱の中のフォルダは除く
    const categories = await this.prisma.manualCategory.findMany({
      where: {
        name: { contains: folderNeedle, mode: 'insensitive' },
        ...ALIVE,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (categories.length === 0) {
      const all = await this.prisma.manualCategory.findMany({
        where: ALIVE,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return { status: 'folder_not_found' as const, folders: all };
    }
    if (categories.length > 1) {
      return { status: 'folder_ambiguous' as const, folders: categories };
    }

    const moved = await this.move(manual.id, categories[0].id);
    return {
      status: 'moved' as const,
      manual: moved,
      folderName: categories[0].name,
      folderAdminOnly: categories[0].adminOnly,
    };
  }

  /** ピン留めの切り替え(ピン=AIの再分類で動かさない) */
  async setPinned(id: string, pinned: boolean) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    return this.prisma.manual.update({
      where: { id },
      data: { categoryPinned: pinned },
    });
  }

  async getDownloadUrl(id: string, includeAdminOnly = false) {
    const manual = await this.prisma.manual.findFirst({
      // 隠しフォルダの中身は、IDを知っていても開けないようにする。
      // 一覧に出さないだけでは、リンクを共有された時点で読めてしまう
      where: { id, AND: this.visibleTo(includeAdminOnly) },
    });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    const url = await this.storage.createDownloadUrl(
      manual.fileKey,
      manual.fileName,
    );
    return {
      url,
      fileName: manual.fileName,
      // 画面はここを見て、埋め込み表示かダウンロード案内かを決める
      viewableInBrowser:
        fileTypeOf(manual.fileName)?.viewableInBrowser ?? false,
    };
  }

  /**
   * 一括ダウンロード用に、複数マニュアルの署名付きURLをまとめて発行する。
   * ブラウザ側がこのURLからファイルを取得してZIPにまとめる
   */
  async getDownloadTargets(ids: string[], includeAdminOnly = false) {
    if (ids.length === 0) return [];
    const manuals = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        id: { in: ids },
        AND: this.visibleTo(includeAdminOnly),
      },
      orderBy: { title: 'asc' },
    });
    return Promise.all(
      manuals.map(async (manual) => ({
        id: manual.id,
        title: manual.title,
        fileName: manual.fileName,
        url: await this.storage.createDownloadUrl(
          manual.fileKey,
          manual.fileName,
        ),
      })),
    );
  }

  /**
   * ゴミ箱へ移す(実体はまだ消さない)。
   * 一覧・検索・AI回答からは外れるが、復元できる
   */
  async delete(id: string) {
    const manual = await this.prisma.manual.findFirst({
      where: { ...ALIVE, id },
    });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    return this.prisma.manual.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** まとめてゴミ箱へ移す。戻り値は移せた件数 */
  async deleteMany(ids: string[]) {
    const { count } = await this.prisma.manual.updateMany({
      where: { ...ALIVE, id: { in: ids } },
      data: { deletedAt: new Date() },
    });
    return count;
  }

  /**
   * ゴミ箱の中身(捨てた順)。
   * フォルダごと捨てたマニュアルはフォルダの中に入ったままなので、
   * ここには出さない(フォルダを戻せば一緒に戻る)
   */
  async trashed() {
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null } },
      include: { category: true },
      orderBy: { deletedAt: 'desc' },
    });
    return manuals.filter(
      (m) =>
        !(
          m.category?.deletedAt &&
          m.deletedAt &&
          m.category.deletedAt.getTime() === m.deletedAt.getTime()
        ),
    );
  }

  /** ゴミ箱に入っているフォルダ(中の件数付き) */
  async trashedCategories() {
    const categories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    });
    return Promise.all(
      categories.map(async (category) => {
        // 一緒に捨てられた=同じ日時のものだけを数える。
        // フォルダを捨てる前から個別にゴミ箱にあった分は別扱い
        const stats = await this.prisma.manual.aggregate({
          where: { categoryId: category.id, deletedAt: category.deletedAt },
          _count: { _all: true },
          _sum: { size: true },
        });
        return {
          ...category,
          manualCount: stats._count._all,
          totalSize: stats._sum.size ?? 0,
        };
      }),
    );
  }

  /**
   * 空のフォルダだけをゴミ箱へ移す(再分類後の片付け用)。
   *
   * 一覧を出してから押すまでの間に、アップロードや手動の移動で中身が
   * 入ることがある。通常のフォルダ削除は中身ごと捨てる仕様なので、
   * そのまま呼ぶとマニュアルが黙ってゴミ箱に落ちる。ここで必ず数え直し、
   * 空でなくなっていたら見送って名前を返す
   */
  async deleteEmptyCategories(ids: string[]) {
    if (ids.length === 0) return { deletedIds: [], skipped: [] };
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, ...ALIVE },
      select: { id: true, name: true },
    });
    const deletedAt = new Date();
    const deletedIds: string[] = [];
    const skipped: string[] = [];
    for (const category of categories) {
      // 数えてから消すまでの隙間に中身が入ると、生きているマニュアルが
      // ゴミ箱のフォルダに取り残される(画面のどこにも出てこなくなる)。
      // 「空である」ことを条件に含めた1文で書き換え、判定と更新を分けない
      const updated = await this.prisma.$executeRaw`
        UPDATE "ManualCategory" c
        SET deleted_at = ${deletedAt}
        WHERE c.id = ${category.id}
          AND c.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "Manual" m
            WHERE m."categoryId" = c.id AND m.deleted_at IS NULL
          )
      `;
      if (updated === 1) deletedIds.push(category.id);
      else skipped.push(category.name);
    }
    return { deletedIds, skipped };
  }

  /**
   * 再分類の結果に、今の状態を重ねて返す。
   *
   * 空になったフォルダの一覧は完了時点の写しなので、そのまま出すと
   * 「もう消したフォルダ」「あとから中身が入ったフォルダ」が残ってしまう。
   * 画面に出す直前に、今も生きていて今も空のものだけに絞る
   */
  async reclassifyStatusView(): Promise<ReclassifyStatus> {
    const job = this.reclassifyJob;
    if (job.emptiedCategories.length === 0) return job;
    const ids = job.emptiedCategories.map((c) => c.id);
    const [alive, counts] = await Promise.all([
      this.prisma.manualCategory.findMany({
        where: { id: { in: ids }, ...ALIVE },
        // サイドバーと同じ並びで出す(見比べながら選べるように)
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, createdByAi: true },
      }),
      this.prisma.manual.groupBy({
        by: ['categoryId'],
        where: { ...ALIVE, categoryId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const hasContents = new Set(
      counts.filter((c) => c._count._all > 0).map((c) => c.categoryId),
    );
    return {
      ...job,
      emptiedCategories: alive.filter((c) => !hasContents.has(c.id)),
    };
  }

  /** ゴミ箱のフォルダを中身ごと元に戻す */
  /**
   * 復元するフォルダに付ける、生きている中で重複しない名前を作る。
   *
   * 同名のフォルダがあっても「見せる範囲(鍵)」が違うときは、まとめてしまうと
   * 鍵付きだった中身が全員に見える場所へ出てしまう。名前を変えて別に戻す
   */
  private async uniqueCategoryName(base: string) {
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? `${base} (復元)` : `${base} (復元${i})`;
      const taken = await this.prisma.manualCategory.findFirst({
        where: { name, ...ALIVE },
        select: { id: true },
      });
      if (!taken) return name;
    }
    // ここまで来ることは実際には無いが、名前を返せないと復元できないため
    return `${base} (復元x)`;
  }

  async restoreCategories(ids: string[]) {
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
    });
    // 同名の生きているフォルダがあったため、中身だけをそちらへ戻した分
    const mergedInto: string[] = [];
    // 見せる範囲が違うので、まとめずに別の名前で戻した分
    const restoredSeparately: string[] = [];
    for (const category of categories) {
      // 捨てている間に同じ名前のフォルダが作られていることがある
      // (再分類が作り直すなど)。フォルダ名は生きている中で一意なので
      // そのままでは戻せない。中身だけを既存のフォルダへ入れ、
      // 空になったゴミ箱側のフォルダは片付ける
      const live = await this.prisma.manualCategory.findFirst({
        where: { name: category.name, ...ALIVE },
      });
      // 名前が同じでも鍵の有無が違うなら、まとめてはいけない。
      // 鍵付きだった中身を鍵なしのフォルダへ入れると、戻した瞬間に
      // 一般利用者の一覧・検索・ダウンロード・AIの回答に出てしまう
      if (live && live.adminOnly !== category.adminOnly) {
        const name = await this.uniqueCategoryName(category.name);
        await this.prisma.$transaction([
          this.prisma.manual.updateMany({
            where: { categoryId: category.id, deletedAt: category.deletedAt },
            data: { deletedAt: null },
          }),
          this.prisma.manualCategory.update({
            where: { id: category.id },
            // adminOnlyは元のまま。鍵の状態を変えずに戻すのがこの分岐の目的
            data: { deletedAt: null, name },
          }),
        ]);
        restoredSeparately.push(name);
        continue;
      }
      if (live) {
        await this.prisma.$transaction([
          this.prisma.manual.updateMany({
            where: { categoryId: category.id, deletedAt: category.deletedAt },
            data: { deletedAt: null, categoryId: live.id },
          }),
          // 片方でも利用者が作った箱なら、残る方も手作業扱いにする。
          // そうしないと、手で作った箱を捨てている間にAIが同名の箱を
          // 作り直していた場合、復元をきっかけに印が消えて、
          // 空になったときの片付け候補に自動で入ってしまう
          ...(category.createdByAi || !live.createdByAi
            ? []
            : [
                this.prisma.manualCategory.update({
                  where: { id: live.id },
                  data: { createdByAi: false },
                }),
              ]),
          this.prisma.manualCategory.delete({ where: { id: category.id } }),
        ]);
        mergedInto.push(category.name);
        continue;
      }
      await this.prisma.$transaction([
        // 一緒に捨てたマニュアルだけを戻す
        this.prisma.manual.updateMany({
          where: { categoryId: category.id, deletedAt: category.deletedAt },
          data: { deletedAt: null },
        }),
        this.prisma.manualCategory.update({
          where: { id: category.id },
          data: { deletedAt: null },
        }),
      ]);
    }
    return { restoredCount: categories.length, mergedInto, restoredSeparately };
  }

  /** ゴミ箱のフォルダを中身ごと完全に削除する */
  async purgeCategories(ids: string[]) {
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
    });
    let purged = 0;
    for (const category of categories) {
      // 中のマニュアルを先に消さないと外部キーで消せない
      const inside = await this.prisma.manual.findMany({
        where: { categoryId: category.id },
        select: { id: true },
      });
      await this.purgeMany(inside.map((m) => m.id));
      const left = await this.prisma.manual.count({
        where: { categoryId: category.id },
      });
      if (left > 0) {
        this.logger.error(
          `フォルダを削除できません(${left}件残っています) category=${category.id}`,
        );
        continue;
      }
      await this.prisma.manualCategory.delete({ where: { id: category.id } });
      purged++;
    }
    return purged;
  }

  /**
   * ゴミ箱から元に戻す。戻り値は復元できた件数。
   * 元のフォルダ自体がゴミ箱にある場合は、戻しても見えなくなってしまうので
   * 未分類へ移す
   */
  async restoreMany(ids: string[]) {
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null }, id: { in: ids } },
      include: { category: true },
    });
    for (const manual of manuals) {
      const category = manual.category;
      // 入っていたフォルダもゴミ箱にある場合は、通常は未分類へ戻す。
      // ただし鍵付きフォルダだったものを未分類へ出すと、そこは誰にでも
      // 見える場所なので、隠していた資料がそのまま全員に見えてしまう。
      // その場合はフォルダごと復活させ、元の鍵付きの場所へ戻す
      if (category?.deletedAt && category.adminOnly) {
        const conflict = await this.prisma.manualCategory.findFirst({
          where: { name: category.name, ...ALIVE },
          select: { id: true },
        });
        await this.prisma.manualCategory.update({
          where: { id: category.id },
          data: {
            deletedAt: null,
            // 捨てている間に同じ名前のフォルダが作られていたら名前を変える
            ...(conflict
              ? { name: await this.uniqueCategoryName(category.name) }
              : {}),
          },
        });
        await this.prisma.manual.update({
          where: { id: manual.id },
          data: { deletedAt: null, categoryId: category.id },
        });
        continue;
      }
      await this.prisma.manual.update({
        where: { id: manual.id },
        data: {
          deletedAt: null,
          categoryId: category?.deletedAt ? null : manual.categoryId,
        },
      });
    }
    return manuals.length;
  }

  /**
   * ゴミ箱から完全に削除する(実ファイルごと)。戻り値は削除できた件数。
   * 生きているマニュアルは対象にしない(誤って消さないため)
   */
  async purgeMany(ids: string[]) {
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null }, id: { in: ids } },
    });
    let purged = 0;
    for (const manual of manuals) {
      try {
        // 先にストレージの実ファイルを消し、成功したらDBの行を消す。
        // 逆順だと、ストレージ削除失敗時に「DBに無いのにファイルだけ残る」迷子ができる
        await this.storage.deleteObject(manual.fileKey);
        await this.prisma.manual.delete({ where: { id: manual.id } });
        purged++;
      } catch (e) {
        const message = e instanceof Error ? e.message : '不明なエラー';
        this.logger.error(`完全削除に失敗 manual=${manual.id}: ${message}`);
      }
    }
    return purged;
  }

  /** ゴミ箱を空にする(フォルダも含めて完全削除) */
  async emptyTrash() {
    const categories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true },
    });
    const purgedCategories = await this.purgeCategories(
      categories.map((c) => c.id),
    );
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true },
    });
    const purgedManuals = await this.purgeMany(manuals.map((m) => m.id));
    return purgedManuals + purgedCategories;
  }

  /**
   * 捨ててから一定期間が過ぎたものを自動で完全削除する。
   * 起動時と1日ごとに実行する(専用のスケジューラを増やさない)
   */
  private async purgeExpiredTrash() {
    const limit = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    // フォルダを先に消す(中のマニュアルごと消える)
    const expiredCategories = await this.prisma.manualCategory.findMany({
      where: { deletedAt: { lt: limit } },
      select: { id: true },
    });
    const purgedCategories = await this.purgeCategories(
      expiredCategories.map((c) => c.id),
    );
    const expired = await this.prisma.manual.findMany({
      where: { deletedAt: { lt: limit } },
      select: { id: true },
    });
    if (expired.length === 0 && purgedCategories === 0) return;
    const purged =
      (await this.purgeMany(expired.map((m) => m.id))) + purgedCategories;
    this.logger.log(
      `ゴミ箱の自動削除: ${purged}件(${TRASH_RETENTION_DAYS}日経過)`,
    );
  }
}
