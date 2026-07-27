import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';
import { StorageService } from '../storage/service';
import { RegisterManualInput } from './input';
import { IngestStatus, RegisterOutcome } from './model';

@Injectable()
export class ManualService {
  private readonly logger = new Logger(ManualService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly rag: RagService,
  ) {}

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
    // autoCategorizeはDBの列ではないので分離する
    const { autoCategorize, ...data } = input;

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

    // 新旧の判定。既存の最終更新日が不明な場合は登録日時で代用する
    const existingTime = (
      existing.fileLastModified ?? existing.createdAt
    ).getTime();
    const incomingTime = data.fileLastModified?.getTime();

    // 送られてきた側の更新日が不明なときは比較できないので、
    // 既存を壊さない安全側に倒して別マニュアルとして追加する
    if (incomingTime === undefined) {
      const manual = await this.prisma.manual.create({ data });
      void this.runIngest(manual.id, autoCategorize ?? false);
      return { manual, outcome: RegisterOutcome.CREATED };
    }

    // 既存の方が新しい(または同時刻)なら取り込まない。
    // アップロード済みの実ファイルは迷子になるので消しておく
    if (incomingTime <= existingTime) {
      await this.storage.deleteObject(data.fileKey).catch(() => undefined);
      return { manual: existing, outcome: RegisterOutcome.SKIPPED_OLDER };
    }

    // 送られてきた方が新しい: 既存を同じIDのまま差し替える。
    // IDを保つことで、過去の会話に残った引用リンクも生き続ける
    const oldFileKey = existing.fileKey;
    const manual = await this.prisma.manual.update({
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
    // 旧ファイルはもう参照されないので削除(失敗しても登録は成功扱い)
    await this.storage.deleteObject(oldFileKey).catch(() => undefined);
    void this.runIngest(manual.id, autoCategorize ?? false);
    return { manual, outcome: RegisterOutcome.UPDATED };
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
  async autoOrganize() {
    const manuals = await this.prisma.manual.findMany({
      where: { categoryId: null, ingestStatus: IngestStatus.COMPLETED },
      include: { chunks: { orderBy: { chunkIndex: 'asc' }, take: 1 } },
    });
    if (manuals.length === 0) {
      return { movedCount: 0, createdCategories: [] };
    }
    const categories = await this.prisma.manualCategory.findMany();
    // 全マニュアルを1回のAI呼び出しで見せることで、一貫性のある分類にする
    const assignments = await this.rag.organize(
      manuals.map((m) => ({
        manualId: m.id,
        title: m.title,
        snippet: m.chunks[0]?.content.slice(0, 120) ?? '',
      })),
      categories.map((c) => c.name),
    );
    return this.applyAssignments(assignments);
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
      );
      await this.applyAssignments(assignments);
    } catch (e) {
      // 分類の失敗は致命的ではない(未分類のまま残るだけ)
      const message = e instanceof Error ? e.message : '不明なエラー';
      this.logger.error(`自動分類失敗 manual=${manualId}: ${message}`);
    }
  }

  /** AIの割り当て結果をDBに反映する(カテゴリが無ければ作る) */
  private async applyAssignments(
    assignments: { manualId: string; category: string }[],
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
      data: { categoryId },
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
      data: { categoryId },
    });
    return result.count;
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
