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
import { IngestStatus, ReclassifyStatus, RegisterOutcome } from './model';

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
  }

  findAll(categoryId?: string, uncategorized?: boolean) {
    return this.prisma.manual.findMany({
      // uncategorized=trueなら「カテゴリ未設定」だけに絞る(nullでの絞り込み)
      where: uncategorized
        ? { categoryId: null }
        : categoryId
          ? { categoryId }
          : undefined,
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
      where: { fileName: data.fileName },
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
      const chunkCount = await this.rag.ingest(manual.id, downloadUrl);

      await this.prisma.manual.update({
        where: { id },
        data: {
          ingestStatus: IngestStatus.COMPLETED,
          chunkCount,
          ingestedAt: new Date(),
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
      error?: string;
    }) => void,
  ): boolean {
    if (this.reclassifyJob.running) return false;
    this.reclassifyJob = {
      running: true,
      movedCount: 0,
      createdCategories: [],
      error: null,
      finishedAt: null,
    };
    void this.reclassifyAll(instruction)
      .then(({ movedCount, createdCategories }) => {
        this.reclassifyJob = {
          running: false,
          movedCount,
          createdCategories,
          error: null,
          finishedAt: new Date(),
        };
        onFinish?.({ ok: true, movedCount, createdCategories });
      })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : '不明なエラー';
        this.reclassifyJob = {
          running: false,
          movedCount: 0,
          createdCategories: [],
          error,
          finishedAt: new Date(),
        };
        onFinish?.({ ok: false, movedCount: 0, createdCategories: [], error });
      });
    return true;
  }

  /** 再分類の対象件数(ピン留めを除く)とピン留め件数 */
  async reclassifyCounts() {
    const [target, pinned] = await Promise.all([
      this.prisma.manual.count({
        where: {
          ingestStatus: IngestStatus.COMPLETED,
          categoryPinned: false,
        },
      }),
      this.prisma.manual.count({
        where: { ingestStatus: IngestStatus.COMPLETED, categoryPinned: true },
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
      where: { ...where, ingestStatus: IngestStatus.COMPLETED, categoryPinned: false },
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
    });
    if (manuals.length === 0) {
      return { movedCount: 0, createdCategories: [] };
    }

    // 1回の呼び出し時間とレスポンスJSONのトークン量の両方に余裕を持たせる。
    // (80件だと応答が出力上限4000トークンに接近し、通信も1分を超えやすい)
    // 管理者が蓄積した分類ルール(「〜は〜のフォルダへ」)を最優先で効かせる
    const rules = await this.classificationRules();

    const BATCH_SIZE = 50;
    let movedCount = 0;
    const createdCategories: string[] = [];
    for (let i = 0; i < manuals.length; i += BATCH_SIZE) {
      const batch = manuals.slice(i, i + BATCH_SIZE);
      // カテゴリはバッチごとに取り直す(前のバッチが作った新カテゴリを次も使えるように)
      const categories = await this.prisma.manualCategory.findMany();
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
    return { movedCount, createdCategories };
  }

  /** 1件だけAIで分類する(アップロード時の「AIにおまかせ」用)。失敗しても取り込みは成功扱い */
  private async autoCategorizeOne(manualId: string) {
    try {
      const manual = await this.prisma.manual.findUnique({
        where: { id: manualId },
        include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
      });
      if (!manual || manual.categoryId) return;
      const categories = await this.prisma.manualCategory.findMany();
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
        where: { name },
      });
      if (!category) {
        // 既存カテゴリ限定モードでは、AIが指示を破って作った未知の名前は無視する
        if (!allowNew) continue;
        category = await this.prisma.manualCategory.create({
          data: { name },
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
      const category = await this.prisma.manualCategory.findUnique({
        where: { id: categoryId },
      });
      if (!category) {
        throw new BadRequestException('移動先のカテゴリが見つかりません');
      }
    }
    return this.prisma.manual.update({
      where: { id },
      // 手動でフォルダへ移動したものはピン留めし、AIの再分類で動かさない。
      // 未分類へ戻すのは「分類し直したい」なのでピンを外す
      data: { categoryId, categoryPinned: categoryId !== null },
    });
  }

  /** 複数のマニュアルをまとめて移動する。戻り値は移動した件数 */
  async moveMany(ids: string[], categoryId: string | null) {
    if (ids.length === 0) return 0;
    if (categoryId) {
      const category = await this.prisma.manualCategory.findUnique({
        where: { id: categoryId },
      });
      if (!category) {
        throw new BadRequestException('移動先のカテゴリが見つかりません');
      }
    }
    const result = await this.prisma.manual.updateMany({
      where: { id: { in: ids } },
      data: { categoryId, categoryPinned: categoryId !== null },
    });
    return result.count;
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

  async delete(id: string) {
    const manual = await this.prisma.manual.findUnique({ where: { id } });
    if (!manual) {
      throw new NotFoundException('マニュアルが見つかりません');
    }
    // 先にストレージの実ファイルを消し、成功したらDBの行を消す。
    // 逆順だと、ストレージ削除失敗時に「DBに無いのにファイルだけ残る」迷子ができる
    await this.storage.deleteObject(manual.fileKey);
    return this.prisma.manual.delete({ where: { id } });
  }
}
