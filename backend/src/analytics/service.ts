import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/service';
import { RagService } from '../rag/service';

/** 集計に渡せる期間の上限(日)。0や未指定は「全期間」 */
const MAX_DAYS = 365;

/** 一覧で返す最大件数(画面で読める量に抑える) */
const LIMIT = 200;

/**
 * チャット履歴から「マニュアルが足りていない領域」を見つけるための集計。
 *
 * このアプリの値打ちはマニュアルが育つことなので、
 * 「答えられなかった質問」「よく聞かれること」「使われていないマニュアル」を
 * 見えるようにして、次に何を用意すべきかが分かる状態にする。
 * 誰が質問したかは扱わない(内容だけを集計する)。
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
  ) {}

  /** 期間指定をSQLで使う開始日時に変換する(未指定なら全期間) */
  private since(days?: number): Date | null {
    if (!days || days <= 0) return null;
    const capped = Math.min(days, MAX_DAYS);
    return new Date(Date.now() - capped * 24 * 60 * 60 * 1000);
  }

  /**
   * AIが「マニュアルに根拠が無い」と申告した回答と、その質問を返す。
   *
   * 質問は「同じ会話の、その回答の直前のユーザー発言」。
   * 会話ごとに時系列で並んでいるので、直前の1件を取れば対になる。
   */
  async unansweredQuestions(days?: number) {
    const since = this.since(days);
    // 期間の有無でSQLを分ける。1本にまとめて (パラメータ IS NULL OR ...) と
    // 書くと、Postgresが汎用プランに切り替わったときにこのORが残り、
    // created_atの索引が使われず全件走査になる
    type Row = {
      id: string;
      question: string | null;
      answer: string;
      asked_at: Date;
    };
    const rows = since
      ? await this.prisma.$queryRaw<Row[]>`
          SELECT
            a.id,
            (
              SELECT q.content FROM "Message" q
              WHERE q.conversation_id = a.conversation_id
                AND q.role = 'USER'
                AND q.created_at <= a.created_at
              ORDER BY q.created_at DESC
              LIMIT 1
            ) AS question,
            a.content AS answer,
            a.created_at AS asked_at
          FROM "Message" a
          WHERE a.role = 'ASSISTANT'
            AND a.answered_from_manuals = false
            AND a.created_at >= ${since}
          ORDER BY a.created_at DESC
          LIMIT ${LIMIT}
        `
      : await this.prisma.$queryRaw<Row[]>`
          SELECT
            a.id,
            (
              SELECT q.content FROM "Message" q
              WHERE q.conversation_id = a.conversation_id
                AND q.role = 'USER'
                AND q.created_at <= a.created_at
              ORDER BY q.created_at DESC
              LIMIT 1
            ) AS question,
            a.content AS answer,
            a.created_at AS asked_at
          FROM "Message" a
          WHERE a.role = 'ASSISTANT'
            AND a.answered_from_manuals = false
          ORDER BY a.created_at DESC
          LIMIT ${LIMIT}
        `;
    // 質問が見つからない回答(会話の作りが壊れている場合)は出さない
    return rows
      .filter((r) => r.question)
      .map((r) => ({
        id: r.id,
        question: r.question as string,
        answer: r.answer,
        askedAt: r.asked_at,
      }));
  }

  /** 集計対象の質問文だけを新しい順に返す(テーマ分けの入力に使う) */
  private async recentQuestions(days?: number): Promise<string[]> {
    const since = this.since(days);
    const rows = await this.prisma.message.findMany({
      where: {
        role: 'USER',
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300, // RAG側の上限に合わせる
      select: { content: true },
    });
    // 画像添付の注記や前後の空白は集計の邪魔なので落とす
    return rows
      .map((r) => r.content.replace(/\n\(📷 画像を添付\)$/, '').trim())
      .filter((q) => q.length > 0);
  }

  /**
   * 質問をテーマごとにまとめる(AIを使う)。
   * 押したときだけ実行する想定なので、ここでは結果を保存しない
   */
  async questionThemes(days?: number) {
    const questions = await this.recentQuestions(days);
    if (questions.length === 0) return [];
    return this.rag.clusterQuestions(questions);
  }

  /**
   * マニュアルが回答の根拠として何回使われたかを返す(多い順)。
   * 一度も使われていないマニュアルも0件として含める(棚卸しに使う)
   */
  async manualUsage(days?: number) {
    const since = this.since(days);
    // citationsは回答時点のスナップショット。JSON配列を展開して数える。
    //
    // COUNT(DISTINCT m.id) にするのが要点。1つの回答が同じマニュアルの
    // 複数ページを根拠にすると引用の要素は複数になるため、そのまま数えると
    // 多ページのPDFだけが上位に来てしまう。数えたいのは「何回の回答で
    // 使われたか」なのでメッセージ単位で重複を除く
    type CountRow = { manual_id: string; cited: bigint; last_cited: Date };
    const counts = since
      ? await this.prisma.$queryRaw<CountRow[]>`
          SELECT
            c->>'manualId' AS manual_id,
            COUNT(DISTINCT m.id) AS cited,
            MAX(m.created_at) AS last_cited
          FROM "Message" m,
               LATERAL jsonb_array_elements(m.citations) c
          WHERE m.role = 'ASSISTANT'
            AND jsonb_typeof(m.citations) = 'array'
            AND m.created_at >= ${since}
          GROUP BY 1
        `
      : await this.prisma.$queryRaw<CountRow[]>`
          SELECT
            c->>'manualId' AS manual_id,
            COUNT(DISTINCT m.id) AS cited,
            MAX(m.created_at) AS last_cited
          FROM "Message" m,
               LATERAL jsonb_array_elements(m.citations) c
          WHERE m.role = 'ASSISTANT'
            AND jsonb_typeof(m.citations) = 'array'
          GROUP BY 1
        `;
    const byManual = new Map(
      counts.map((c) => [
        c.manual_id,
        { cited: Number(c.cited), lastCited: c.last_cited },
      ]),
    );

    // ゴミ箱のマニュアルは棚卸しの対象外(もう使わないと決めたもの)
    const manuals = await this.prisma.manual.findMany({
      where: { deletedAt: null },
      select: { id: true, title: true, category: { select: { name: true } } },
    });

    return manuals
      .map((manual) => {
        const hit = byManual.get(manual.id);
        return {
          manualId: manual.id,
          title: manual.title,
          categoryName: manual.category?.name ?? null,
          citedCount: hit?.cited ?? 0,
          lastCitedAt: hit?.lastCited ?? null,
        };
      })
      .sort((a, b) => b.citedCount - a.citedCount || a.title.localeCompare(b.title, 'ja'));
  }

  // 可否を数えなくてよい結末。聞き返しは会話の途中、管理操作はマニュアルへの
  // 質問ではなく、検索対象ゼロは「探す先が無い」だけで、いずれも
  // 「答えられなかった」に混ぜると「作るべきマニュアル」の一覧が濁る
  private static readonly OUT_OF_SCOPE = ['clarify', 'admin', 'no_manuals'];

  /** 画面の見出しに出す全体像 */
  async summary(days?: number) {
    const since = this.since(days);
    const where = since ? { createdAt: { gte: since } } : {};
    const answers = { ...where, role: 'ASSISTANT' as const };
    const [
      questionCount,
      answeredCount,
      unansweredCount,
      outOfScopeCount,
      failedCount,
      unreportedCount,
      total,
      usage,
    ] = await Promise.all([
      this.prisma.message.count({ where: { ...where, role: 'USER' } }),
      this.prisma.message.count({
        where: { ...answers, answeredFromManuals: true },
      }),
      this.prisma.message.count({
        where: { ...answers, answeredFromManuals: false },
      }),
      this.prisma.message.count({
        where: { ...answers, answerOutcome: { in: AnalyticsService.OUT_OF_SCOPE } },
      }),
      this.prisma.message.count({
        where: { ...answers, answerOutcome: 'failed' },
      }),
      this.prisma.message.count({
        where: { ...answers, answerOutcome: 'unreported' },
      }),
      this.prisma.message.count({ where: answers }),
      this.manualUsage(days),
    ]);
    return {
      questionCount,
      answeredCount,
      unansweredCount,
      // 聞き返し・管理操作・検索対象ゼロ。数えても意味が無いもの
      outOfScopeCount,
      // 生成に失敗した(マニュアルの有無とは無関係の障害)
      failedCount,
      // 通常の回答なのにAIが根拠を申告せず、可否を判定できなかったもの。
      // ここが増えていたら、集計の仕組み自体を疑う手がかりになる
      unreportedCount,
      // この結末を記録し始める前に保存されたデータ
      notRecordedCount:
        total -
        answeredCount -
        unansweredCount -
        outOfScopeCount -
        failedCount -
        unreportedCount,
      // 古い画面との互換のために残す(内訳を出せない場合の合計)
      unknownCount: total - answeredCount - unansweredCount,
      neverCitedManualCount: usage.filter((u) => u.citedCount === 0).length,
    };
  }
}
