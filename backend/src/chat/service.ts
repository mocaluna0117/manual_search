import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Message } from '../../generated/prisma/client';
import { CategoryService } from '../category/service';
import { IngestStatus } from '../manual/model';
import { ManualService } from '../manual/service';
import { PrismaService } from '../prisma/service';
import { RagCitation } from '../rag/model';
import { RagService, type RagAction } from '../rag/service';
import { AskResult, ChatMessage, MessageRole } from './model';

// 再分類の確認ボタンの文言。クリックするとこの文字列がそのまま質問として届くので、
// pendingActionと合わせて確定的に照合する(確認の判定をLLMに任せない)
const CONFIRM_RECLASSIFY = '✅ はい、再分類を実行する';
const CANCEL_RECLASSIFY = 'キャンセル';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
    private readonly categoryService: CategoryService,
    private readonly manualService: ManualService,
  ) {}

  conversations(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId }, // 自分の会話だけ
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  async conversation(id: string, userId: string) {
    // idの一致だけでなく「所有者が自分か」も同時にチェックする。
    // 他人の会話は「無い」と同じ扱いにして、存在自体も漏らさない
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });
    if (!conversation) {
      throw new NotFoundException('会話が見つかりません');
    }
    return conversation;
  }

  async messages(conversationId: string): Promise<ChatMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((m) => this.toChatMessage(m));
  }

  /** 質問を受けて、会話の作成→質問の保存→RAG検索→回答の保存までを行う */
  async ask(
    question: string,
    userId: string,
    conversationId?: string | null,
    image?: { base64: string; format: string },
    signal?: AbortSignal,
    isAdmin = false,
  ): Promise<AskResult> {
    // 1) 会話を用意(初回の質問なら新規作成し、タイトルは質問から自動生成)
    //    既存会話の場合は所有者チェックも兼ねる
    const conversation = conversationId
      ? await this.conversation(conversationId, userId)
      : await this.prisma.conversation.create({
          data: { title: this.makeTitle(question), userId },
        });

    // 1.5) 管理操作の「確認待ち」があれば、RAGを呼ばずにここで確定的に処理する。
    //      確認・キャンセル以外の発言が来たら、確認は流れたとみなして通常フローへ。
    //      権限が変わっていても古い確認は必ず破棄する(後から復活させない)
    if (conversation.pendingAction) {
      const pending = conversation.pendingAction as {
        type?: string;
        instruction?: string;
      };
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { pendingAction: Prisma.DbNull },
      });
      if (isAdmin && pending.type === 'reclassify_all') {
        if (question === CONFIRM_RECLASSIFY) {
          return this.startReclassify(
            conversation.id,
            question,
            pending.instruction,
          );
        }
        if (question === CANCEL_RECLASSIFY) {
          return this.respond(
            conversation.id,
            question,
            '再分類を中止しました。今の分類のまま変更していません。',
          );
        }
      }
    } else if (question === CONFIRM_RECLASSIFY) {
      // 確認待ちが無いのに確認の文言が届いた=履歴に残った古いボタンのクリック。
      // RAGに流すと意味不明な検索になるため、ここで案内して終える
      return this.respond(
        conversation.id,
        question,
        'この確認は期限切れです。もう一度「マニュアルを再分類して」と依頼してください。',
      );
    }

    // 2) この会話のこれまでのやりとりを集める(絞り込み対話の文脈としてRAGへ渡す)。
    //    新しい質問を保存する「前」に取ることで、履歴と今回の質問が重複しない
    const recentMessages = conversationId
      ? await this.prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
          take: 8, // 直近4往復まで(古いやりとりまで送るとノイズになる)
        })
      : [];
    const history = recentMessages.reverse().map((m) => {
      // 過去に提示した選択肢も文脈に含める(「2です」の意味をClaudeが分かるように)
      const options = (m.options as string[] | null) ?? [];
      const optionsText =
        options.length > 0
          ? `\n選択肢: ${options.map((o, i) => `${i + 1}. ${o}`).join(' / ')}`
          : '';
      return {
        role: (m.role === MessageRole.USER ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        content: m.content.slice(0, 500) + optionsText,
      };
    });

    // 3) 質問を保存(画像そのものは保存しない。添付があったことだけ履歴に残す)
    const userMessage = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: image ? `${question}\n(📷 画像を添付)` : question,
      },
    });

    // 4) RAG検索。失敗しても例外にせず「エラーである」という回答を履歴に残す
    //    (取り込みステータスと同じ発想: 非同期の結果はデータとして記録する)
    let answer: string;
    let citations: RagCitation[] = [];
    let options: string[] = [];
    let ragActions: RagAction[] = [];
    try {
      const result = await this.rag.search(
        question,
        image,
        history,
        signal,
        isAdmin,
      );
      answer = result.answer;
      citations = result.citations;
      options = result.options;
      ragActions = result.actions;
    } catch (e) {
      // 「停止」ボタン(クライアント切断)による中断は、質問を無かったことにする。
      // 回答を保存せず質問も消すことで、ユーザーが編集して再送信できる状態に戻す
      if (signal?.aborted) {
        if (conversationId) {
          await this.prisma.message
            .delete({ where: { id: userMessage.id } })
            .catch(() => undefined);
        } else {
          // 新規会話ごと消す(メッセージはonDelete: Cascadeで一緒に消える)
          await this.prisma.conversation
            .delete({ where: { id: conversation.id } })
            .catch(() => undefined);
        }
        throw e; // クライアントは既に切断済みなので、この例外が届くことはない
      }
      answer = `エラーが発生しました: ${e instanceof Error ? e.message : '不明なエラー'}`;
    }

    // 4.5) 管理ツールの呼び出し要求(管理者のみ)。RAGの失敗・中断処理とは分けて、
    //      検索が成功したときだけ実行する。フォルダ作成は低リスクなので即実行、
    //      再分類は全件に影響するため確認を挟む
    if (isAdmin && ragActions.length > 0) {
      const lines: string[] = answer ? [answer] : [];

      for (const action of ragActions) {
        if (action.name !== 'create_folder') continue;
        const name = String(action.input.name ?? '').trim();
        if (!name) continue;
        try {
          await this.categoryService.create(name);
          lines.push(`📁 フォルダ「${name}」を作成しました。`);
        } catch (e) {
          // 重複などの失敗は会話として伝える(例外で全体を止めない)
          lines.push(
            `⚠️ フォルダ「${name}」は作成できませんでした: ${e instanceof Error ? e.message : '不明なエラー'}`,
          );
        }
      }

      const reclassify = ragActions.find(
        (a) => a.name === 'reclassify_all_manuals',
      );
      // 安全網: モデルが本文で「再分類します」と宣言だけしてツールを呼ばなかった場合、
      // 何も起きないまま放置されるのを防ぐため、次の一手をユーザーに案内する
      if (!reclassify && /再分類/.test(answer ?? '')) {
        lines.push(
          '(再分類はまだ実行されていません。「全マニュアルを再分類して」と送ると、確認のうえ実行します)',
        );
      }
      if (reclassify) {
        // 管理者が依頼文で分類方針を指定していたら、確認を経て実行まで引き継ぐ
        const instruction =
          String(reclassify.input.instruction ?? '').trim() || undefined;
        const manualCount = await this.prisma.manual.count({
          where: { ingestStatus: IngestStatus.COMPLETED },
        });
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            pendingAction: { type: 'reclassify_all', instruction: instruction ?? null },
          },
        });
        lines.push(
          `全${manualCount}件のマニュアルを、AIが工種・業務分野ごとのフォルダへ再分類します` +
            '(足りないフォルダは新しく作られます)。' +
            (instruction ? `分類方針:「${instruction}」。` : '') +
            '今の分類は上書きされます。実行してよいですか？',
        );
        options = [CONFIRM_RECLASSIFY, CANCEL_RECLASSIFY];
      }

      // ツール名が想定外だった等で1行も作れなかった場合の保険(空の吹き出しを出さない)
      answer =
        lines.join('\n') ||
        '依頼された操作を実行できませんでした。もう一度具体的に指示してください。';
      // 引用はRAG側が管理操作時に空にして返すため、ここでは触らない
    }

    // 5) 回答を保存し、会話の更新日時を進める(サイドバーで新しい順に並べるため)
    const message = await this.appendAssistantMessage(
      conversation.id,
      answer,
      options,
      citations,
    );
    return {
      conversationId: conversation.id,
      message: this.toChatMessage(message),
    };
  }

  /** アシスタントの発言を会話に追記し、会話の更新日時を進める(保存処理の共通部) */
  private async appendAssistantMessage(
    conversationId: string,
    content: string,
    options: string[] = [],
    citations: RagCitation[] = [],
  ): Promise<Message> {
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content,
        // 根拠マニュアルは回答時点のスナップショットとしてJSONで保持
        citations: citations as unknown as Prisma.InputJsonValue,
        options: options as unknown as Prisma.InputJsonValue,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return message;
  }

  /** RAGを介さない定型応答(確認のキャンセルなど)。質問と回答を履歴に残す */
  private async respond(
    conversationId: string,
    question: string,
    content: string,
    options: string[] = [],
  ): Promise<AskResult> {
    await this.prisma.message.create({
      data: { conversationId, role: MessageRole.USER, content: question },
    });
    const message = await this.appendAssistantMessage(
      conversationId,
      content,
      options,
    );
    return { conversationId, message: this.toChatMessage(message) };
  }

  // 再分類の多重実行を防ぐ簡易ガード(バックエンドは1コンテナ前提)
  private reclassifyRunning = false;

  /**
   * 確認済みの全マニュアル再分類を開始する。
   * 数分かかりALB/CloudFrontのタイムアウトを超えうるため、リクエストは待たせず
   * 裏で実行し、結果は会話に書き込む(取り込みと同じ「結果はデータ」方針)
   */
  private async startReclassify(
    conversationId: string,
    question: string,
    instruction?: string,
  ): Promise<AskResult> {
    if (this.reclassifyRunning) {
      return this.respond(
        conversationId,
        question,
        '再分類は現在実行中です。完了までしばらくお待ちください。',
      );
    }
    this.reclassifyRunning = true;
    void this.manualService
      .reclassifyAll(instruction)
      .then(({ movedCount, createdCategories }) => {
        let content = `📁 全マニュアルの再分類が完了しました(${movedCount}件を割り当て)。`;
        if (createdCategories.length > 0) {
          content += `\n新しく作られたフォルダ: ${createdCategories.join('、')}`;
        }
        content +=
          '\nサイドバーのフォルダを開いて結果を確認してください。空になったフォルダは🗑から削除できます。';
        return this.appendAssistantMessage(conversationId, content);
      })
      .catch((e: unknown) =>
        this.appendAssistantMessage(
          conversationId,
          `再分類に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}`,
        ).catch(() => undefined),
      )
      .finally(() => {
        this.reclassifyRunning = false;
      });
    return this.respond(
      conversationId,
      question,
      '⏳ 全マニュアルの再分類を開始しました(数分かかることがあります)。完了すると、この会話に結果が記録されます。',
    );
  }

  async deleteConversation(id: string, userId: string) {
    const conversation = await this.conversation(id, userId); // 所有者チェック
    // メッセージはonDelete: Cascadeで一緒に消える
    await this.prisma.conversation.delete({ where: { id } });
    return conversation;
  }

  private makeTitle(question: string, maxLength = 30) {
    const oneLine = question.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLength
      ? `${oneLine.slice(0, maxLength)}…`
      : oneLine;
  }

  private toChatMessage(message: Message): ChatMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      citations: (message.citations as RagCitation[] | null) ?? [],
      options: (message.options as string[] | null) ?? [],
      createdAt: message.createdAt,
    };
  }
}
