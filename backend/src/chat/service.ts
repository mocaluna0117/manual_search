import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Message } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/service';
import { RagCitation } from '../rag/model';
import { RagService } from '../rag/service';
import { AskResult, ChatMessage, MessageRole } from './model';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
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
  ): Promise<AskResult> {
    // 1) 会話を用意(初回の質問なら新規作成し、タイトルは質問から自動生成)
    //    既存会話の場合は所有者チェックも兼ねる
    const conversation = conversationId
      ? await this.conversation(conversationId, userId)
      : await this.prisma.conversation.create({
          data: { title: this.makeTitle(question), userId },
        });

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
    try {
      const result = await this.rag.search(question, image, history, signal);
      answer = result.answer;
      citations = result.citations;
      options = result.options;
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

    // 4) 回答を保存(根拠マニュアルは回答時点のスナップショットとしてJSONで保持)
    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: answer,
        citations: citations as unknown as Prisma.InputJsonValue,
        options: options as unknown as Prisma.InputJsonValue,
      },
    });

    // 5) 会話の更新日時を進める(サイドバーで新しい順に並べるため)
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return {
      conversationId: conversation.id,
      message: this.toChatMessage(message),
    };
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
