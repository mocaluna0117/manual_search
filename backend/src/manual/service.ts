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
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
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

  findAll(categoryId?: string, uncategorized?: boolean) {
    return this.prisma.manual.findMany({
      // uncategorized=trueなら「カテゴリ未設定」だけに絞る(nullでの絞り込み)
      where: uncategorized
        ? { ...ALIVE, categoryId: null }
        : categoryId
          ? { ...ALIVE, categoryId }
          : ALIVE,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** キーワード検索。タイトル/説明/ファイル名/本文(チャンク)を部分一致で探す */
  async search(keyword: string) {
    const kw = keyword.trim();
    if (!kw) return [];

    // mode: 'insensitive' = 大文字小文字を区別しない(ILIKE)
    const contains = { contains: kw, mode: 'insensitive' as const };
    const manuals = await this.prisma.manual.findMany({
      where: {
        ...ALIVE,
        OR: [
          { title: contains },
          { fileName: contains },
          { chunks: { some: { content: contains } } },
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
      void this.runIngest(manual.id, autoCategorize ?? false);
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
    void this.runIngest(manual.id, autoCategorize ?? false);
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
    void this.runIngest(id);
    return true;
  }

  /** 取り込みの実行本体。結果(成功/失敗)は例外でなくDBのステータスに記録する */
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
      );

      await this.prisma.manual.update({
        where: { id },
        data: {
          ingestStatus: IngestStatus.COMPLETED,
          chunkCount,
          ingestedAt: new Date(),
          // 読み取れたときだけ更新する(既に入っている値を消さない)
          ...(pdfCreatedAt ? { pdfCreatedAt } : {}),
        },
      });

      // 「AIにおまかせ」指定なら、取り込み完了後にカテゴリを自動で割り当てる
      if (autoCategorize) {
        await this.autoCategorizeOne(id);
      }
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
    return this.organizeManuals({ categoryId: null }, true);
  }

  /**
   * 全マニュアルを工種・業務分野ごとのフォルダへ再分類し直す(チャットの管理操作用)。
   * 必要ならAIが新しいフォルダも作る。既存の分類は上書きされるため、
   * 呼び出し側で必ず確認を挟むこと。instructionは管理者が指定した分類方針
   */
  async reclassifyAll(instruction?: string) {
    return this.organizeManuals({}, true, instruction);
  }

  // 再分類の進行状況。数分かかる処理をリクエストで待たせないため、
  // 裏で走らせて状態だけを持つ(単一コンテナ前提の簡易ジョブ管理)
  private reclassifyJob: ReclassifyStatus = {
    running: false,
    movedCount: 0,
    createdCategories: [],
    emptiedCategories: [],
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
      error?: string;
    }) => void,
  ): boolean {
    if (this.reclassifyJob.running) return false;
    this.reclassifyJob = {
      running: true,
      movedCount: 0,
      createdCategories: [],
      emptiedCategories: [],
      error: null,
      finishedAt: null,
    };
    void this.reclassifyAll(instruction)
      .then(({ movedCount, createdCategories, emptiedCategories }) => {
        this.reclassifyJob = {
          running: false,
          movedCount,
          createdCategories,
          emptiedCategories,
          error: null,
          finishedAt: new Date(),
        };
        onFinish?.({ ok: true, movedCount, createdCategories, emptiedCategories });
      })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : '不明なエラー';
        this.reclassifyJob = {
          running: false,
          movedCount: 0,
          createdCategories: [],
          emptiedCategories: [],
          error,
          finishedAt: new Date(),
        };
        onFinish?.({
          ok: false,
          movedCount: 0,
          createdCategories: [],
          emptiedCategories: [],
          error,
        });
      });
    return true;
  }

  /** 再分類の対象件数(ピン留めを除く)とピン留め件数 */
  async reclassifyCounts() {
    const [target, pinned] = await Promise.all([
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: false,
        },
      }),
      this.prisma.manual.count({
        where: {
          ...ALIVE,
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: true,
        },
      }),
    ]);
    return { target, pinned };
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
  ) {
    const manuals = await this.prisma.manual.findMany({
      // ピン留め(手動分類)されたものはAIの分類で動かさない
      where: {
        ...where,
        ...ALIVE,
        ingestStatus: IngestStatus.COMPLETED,
        categoryPinned: false,
      },
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
    });
    if (manuals.length === 0) {
      return { movedCount: 0, createdCategories: [], emptiedCategories: [] };
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
    for (let i = 0; i < manuals.length; i += BATCH_SIZE) {
      const batch = manuals.slice(i, i + BATCH_SIZE);
      // カテゴリはバッチごとに取り直す(前のバッチが作った新カテゴリを次も使えるように)。
      // ゴミ箱の中のフォルダは候補に出さない(選ばれても入れられないため)
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
    }
    const emptiedCategories = await this.findEmptiedCategories(countsBefore);
    return { movedCount, createdCategories, emptiedCategories };
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

  /** 1件だけAIで分類する(アップロード時の「AIにおまかせ」用)。失敗しても取り込みは成功扱い */
  private async autoCategorizeOne(manualId: string) {
    try {
      const manual = await this.prisma.manual.findUnique({
        where: { id: manualId },
        include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
      });
      if (!manual || manual.categoryId) return;
      const categories = await this.prisma.manualCategory.findMany({
        where: ALIVE,
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
      await this.applyAssignments(assignments);
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
  ) {
    const createdCategories: string[] = [];
    let movedCount = 0;
    for (const assignment of assignments) {
      const name = assignment.category.trim();
      if (!name) continue;
      let category = await this.prisma.manualCategory.findFirst({
        // ゴミ箱の中のフォルダには絶対に入れない。入れてしまうと画面のどこにも
        // 出てこない(サイドバーはゴミ箱のフォルダを出さず、未分類でもなく、
        // マニュアル自体は生きているのでゴミ箱にも出ない)迷子になる
        where: { name, ...ALIVE },
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
      movedCount++;
    }
    return { movedCount, createdCategories };
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
      where: { title: { contains: manualNeedle, mode: 'insensitive' } },
      orderBy: { title: 'asc' },
    });
    if (manuals.length === 0) return { status: 'manual_not_found' as const };
    if (manuals.length > 1) {
      return { status: 'manual_ambiguous' as const, manuals };
    }
    const manual = manuals[0];

    // 「未分類」への指定は分類を外す操作として扱う
    if (/^(未分類|分類なし|なし)$/.test(folderNeedle)) {
      const moved = await this.move(manual.id, null);
      return { status: 'moved' as const, manual: moved, folderName: '未分類' };
    }

    const categories = await this.prisma.manualCategory.findMany({
      where: { name: { contains: folderNeedle, mode: 'insensitive' } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (categories.length === 0) {
      const all = await this.prisma.manualCategory.findMany({
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

  async getDownloadUrl(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    return this.storage.createDownloadUrl(manual.fileKey, manual.fileName);
  }

  /**
   * 一括ダウンロード用に、複数マニュアルの署名付きURLをまとめて発行する。
   * ブラウザ側がこのURLからファイルを取得してZIPにまとめる
   */
  async getDownloadTargets(ids: string[]) {
    if (ids.length === 0) return [];
    const manuals = await this.prisma.manual.findMany({
      where: { ...ALIVE, id: { in: ids } },
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
  async restoreCategories(ids: string[]) {
    const categories = await this.prisma.manualCategory.findMany({
      where: { id: { in: ids }, deletedAt: { not: null } },
    });
    // 同名の生きているフォルダがあったため、中身だけをそちらへ戻した分
    const mergedInto: string[] = [];
    for (const category of categories) {
      // 捨てている間に同じ名前のフォルダが作られていることがある
      // (再分類が作り直すなど)。フォルダ名は生きている中で一意なので
      // そのままでは戻せない。中身だけを既存のフォルダへ入れ、
      // 空になったゴミ箱側のフォルダは片付ける
      const live = await this.prisma.manualCategory.findFirst({
        where: { name: category.name, ...ALIVE },
      });
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
    return { restoredCount: categories.length, mergedInto };
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
      await this.prisma.manual.update({
        where: { id: manual.id },
        data: {
          deletedAt: null,
          categoryId: manual.category?.deletedAt ? null : manual.categoryId,
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
