import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type Message } from '../../generated/prisma/client';
import { CategoryService } from '../category/service';
import { IngestStatus } from '../manual/model';
import { ManualService } from '../manual/service';
import { PrismaService } from '../prisma/service';
import { RagCitation } from '../rag/model';
import { RagService, type RagAction } from '../rag/service';
import { RuleService } from '../rule/service';
import { StorageService } from '../storage/service';
import { AskResult, ChatMessage, MessageFeedback, MessageRole } from './model';

// 再分類の確認ボタンの文言。クリックするとこの文字列がそのまま質問として届くので、
// pendingActionと合わせて確定的に照合する(確認の判定をLLMに任せない)
const CONFIRM_RECLASSIFY = '✅ はい、再分類を実行する';
const CANCEL_RECLASSIFY = 'キャンセル';

/** 1つの質問に添えられる画像の枚数(RAG側の上限と合わせる) */
export const MAX_CHAT_IMAGES = 4;

/**
 * 履歴に残す質問文。画像そのものは保存しないので、
 * 「何か画像を見せて聞いた」ことだけが後から分かるようにしておく
 */
function withImageNote(question: string, imageCount: number): string {
  if (imageCount === 0) return question;
  const count = imageCount === 1 ? '' : `${imageCount}枚`;
  return `${question}\n(📷 画像を${count}添付)`;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
    private readonly categoryService: CategoryService,
    private readonly manualService: ManualService,
    private readonly ruleService: RuleService,
    private readonly storage: StorageService,
  ) {}

  /**
   * 質問に添えられた画像をS3へ置き、そのキーを返す。
   *
   * 置けなくても質問自体は通す(回答には手元のデータをそのまま使うので、
   * 保存の失敗で会話を止める理由が無い)。その場合は履歴から画像が
   * 見返せなくなるだけで済む
   */
  private async storeImages(
    conversationId: string,
    images: { base64: string; format: string }[],
  ): Promise<string[]> {
    const keys: string[] = [];
    for (const image of images) {
      try {
        const key = `chat/${conversationId}/${randomUUID()}.${image.format}`;
        await this.storage.putBytes(
          key,
          Buffer.from(image.base64, 'base64'),
          `image/${image.format}`,
        );
        keys.push(key);
      } catch (e) {
        console.warn(
          `添付画像を保存できませんでした: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return keys;
  }

  /** 保存済みの画像に、表示用の署名付きURLを付ける */
  private async withImageUrls(messages: ChatMessage[], sources: Message[]) {
    return Promise.all(
      messages.map(async (m, i) => {
        const keys = (sources[i].imageKeys as string[] | null) ?? [];
        if (keys.length === 0) return m;
        const urls = await Promise.all(
          keys.map((key) =>
            this.storage
              // 拡張子から形式を復元する(保存時に付けてある)
              .createImageUrl(key, `image/${key.split('.').pop() ?? 'png'}`)
              .catch(() => null),
          ),
        );
        return { ...m, imageUrls: urls.filter((u): u is string => u !== null) };
      }),
    );
  }

  /** 分類ルール一覧の表示(チャットのどの経路でも同じ文面にする) */
  private formatRules(rules: { text: string }[]) {
    return rules.length === 0
      ? '分類ルールはまだ登録されていません。サイドバーの「分類ルール」から追加できます。'
      : '📏 現在の分類ルール:\n' +
          rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  }

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
    return this.withImageUrls(
      messages.map((m) => this.toChatMessage(m)),
      messages,
    );
  }

  /** 質問を受けて、会話の作成→質問の保存→RAG検索→回答の保存までを行う */
  /**
   * 質問に答える。
   *
   * stream を渡すと、回答の文字が生成されるそばから onDelta が呼ばれる
   * (画面に少しずつ出すため)。渡さなければ従来どおり完成してから返す。
   * どちらの場合も、保存される内容と戻り値は同じ
   */
  async ask(
    question: string,
    userId: string,
    conversationId?: string | null,
    images: { base64: string; format: string }[] = [],
    signal?: AbortSignal,
    isAdmin = false,
    stream?: { onDelta: (text: string) => void; onReset: () => void },
  ): Promise<AskResult> {
    if (images.length > MAX_CHAT_IMAGES) {
      throw new BadRequestException(
        `画像は${MAX_CHAT_IMAGES}枚までにしてください`,
      );
    }

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
    } else if (isAdmin && /^分類ルールを?追加\s*[:：]\s*.+$/s.test(question)) {
      // 1.6) 明示形式のルール操作はLLMを介さず確定的に処理する
      //      (モデルの「実行したフリ」の影響を受けない確実な経路)
      const text = question
        .replace(/^分類ルールを?追加\s*[:：]\s*/s, '')
        .trim();
      try {
        const rule = await this.ruleService.create(text);
        return await this.respond(
          conversation.id,
          question,
          `📏 分類ルールを追加しました: 「${rule.text}」\n今後のすべての自動分類(アップロード時・再分類)で適用されます。`,
        );
      } catch (e) {
        return this.respond(
          conversation.id,
          question,
          `⚠️ 分類ルールを追加できませんでした: ${e instanceof Error ? e.message : '不明なエラー'}`,
        );
      }
    } else if (
      isAdmin &&
      /^分類ルール(の一覧|一覧|を見せて|を教えて|見せて)$/.test(question.trim())
    ) {
      const rules = await this.ruleService.findAll();
      return this.respond(conversation.id, question, this.formatRules(rules));
    } else if (
      isAdmin &&
      /^分類ルール\s*\d+\s*(?:番目?)?\s*を?削除$/.test(question.trim())
    ) {
      const number = Number(question.match(/\d+/)?.[0]);
      const { deleted } = await this.ruleService.deleteByTextOrNumber(
        undefined,
        number,
      );
      return this.respond(
        conversation.id,
        question,
        deleted
          ? `🗑 分類ルール「${deleted.text}」を削除しました。`
          : '⚠️ その番号の分類ルールはありません。サイドバーの「分類ルール」から一覧・削除できます。',
      );
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
      let content = m.content;
      if (m.role === MessageRole.ASSISTANT) {
        // 管理操作の「成功」行(システムが書いた📏/📁等)は履歴に入れない。
        // 成功メッセージが並ぶと、モデルがツールを呼ばずに
        // 「実行したフリ」の文章を真似して書く事故が起きるため。
        // ただし⚠️の訂正行は必ず残す。訂正だけ消すと、モデルは自分の
        // 誤った成功宣言だけを見続けて同じ誤りを繰り返す
        content =
          content
            .split('\n')
            .filter((line) => !/^(📏|📁|🗑|⏳|✅)/.test(line))
            .join('\n')
            .trim() || '(管理操作を実行しました)';
      }
      return {
        // 'user' | 'assistant' に絞る(そのままだとstring扱いになり、
        // RAGへ渡すときに型が合わない)
        role: (m.role === MessageRole.USER ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        content: content.slice(0, 500) + optionsText,
      };
    });

    // 3) 質問を保存(画像そのものは保存しない。添付があったことだけ履歴に残す)
    // 画像はS3へ置いてから、その場所を質問と一緒に残す。
    // 本文だけ残すと、会話を開き直したときに何を見せて聞いたのか分からない
    const imageKeys = await this.storeImages(conversation.id, images);
    const userMessage = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: withImageNote(question, images.length),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      },
    });

    // 4) RAG検索。失敗しても例外にせず「エラーである」という回答を履歴に残す
    //    (取り込みステータスと同じ発想: 非同期の結果はデータとして記録する)
    let answer: string;
    let citations: RagCitation[] = [];
    let options: string[] = [];
    let ragActions: RagAction[] = [];
    // マニュアルから答えられたか。集計にだけ使い、画面には出さない
    let answered: boolean | null = null;
    // 判定できなかった理由(聞き返し・管理操作・生成失敗など)
    let outcome: string | null = null;
    try {
      const result = stream
        ? await this.rag.searchStream(
            question,
            images,
            history,
            signal,
            isAdmin,
            stream.onDelta,
            stream.onReset,
          )
        : await this.rag.search(question, images, history, signal, isAdmin);
      answer = result.answer;
      citations = result.citations;
      options = result.options;
      ragActions = result.actions;
      answered = result.answered ?? null;
      outcome = result.outcome ?? null;
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
        if (action.name === 'create_folder') {
          const name = String(action.input.name ?? '').trim();
          if (!name) continue;
          // 既にあるフォルダを頼まれるのは、直前の会話で作った流れでは普通のこと。
          // これを失敗として返すと「さっき作ったのに」と話が噛み合わなくなるので、
          // そのまま使うと伝える(利用者の目的は「そこに入ること」なので達成できる)
          const existing = await this.categoryService.findByName(name);
          if (existing) {
            lines.push(
              `📁 フォルダ「${name}」は既にあるので、そのまま使います。`,
            );
          } else {
            try {
              await this.categoryService.create(name);
              lines.push(`📁 フォルダ「${name}」を作成しました。`);
            } catch (e) {
              // 名前の規則違反などの失敗は会話として伝える(例外で全体を止めない)
              lines.push(
                `⚠️ フォルダ「${name}」は作成できませんでした: ${e instanceof Error ? e.message : '不明なエラー'}`,
              );
            }
          }
        } else if (action.name === 'move_manual') {
          // 特定の1件を今すぐ移動する。名前が曖昧なときは動かさず候補を出す
          const manualText = String(action.input.manual ?? '').trim();
          const folderText = String(action.input.folder ?? '').trim();
          const result = await this.manualService.moveByName(
            manualText,
            folderText,
          );
          if (result.status === 'moved') {
            lines.push(
              `📁 「${result.manual.title}」を「${result.folderName}」に移動しました。`,
            );
          } else if (result.status === 'manual_ambiguous') {
            const candidates = result.manuals.slice(0, 10);
            lines.push(
              `⚠️ 「${manualText}」に当てはまるマニュアルが複数あります。どれを移動しますか？\n\n` +
                candidates.map((m) => `- ${m.title}`).join('\n'),
            );
            // 入力させずに選べるようにする。押すと題名がそのまま送られ、
            // moveByNameが完全一致で1件に確定する
            options = [
              ...candidates.map((m) => m.title),
              `すべて「${folderText}」に移動する`,
            ];
          } else if (result.status === 'manual_not_found') {
            lines.push(
              `⚠️ 「${manualText}」に当てはまるマニュアルが見つかりませんでした。`,
            );
          } else if (result.status === 'folder_ambiguous') {
            lines.push(
              `⚠️ 「${folderText}」に当てはまるフォルダが複数あります。どれに移動しますか？\n\n` +
                result.folders.map((c) => `- ${c.name}`).join('\n'),
            );
            options = result.folders
              .slice(0, 10)
              .map((c) => `「${manualText}」を「${c.name}」に移動`);
          } else if (result.status === 'folder_not_found') {
            lines.push(
              `⚠️ 「${folderText}」というフォルダはありません。現在のフォルダ:\n\n` +
                result.folders.map((c) => `- ${c.name}`).join('\n'),
            );
          } else {
            lines.push('⚠️ 移動するマニュアルと移動先を指定してください。');
          }
        } else if (action.name === 'add_classification_rule') {
          const text = String(action.input.text ?? '').trim();
          if (!text) continue;
          try {
            const rule = await this.ruleService.create(text);
            lines.push(
              `📏 分類ルールを追加しました: 「${rule.text}」\n今後のすべての自動分類(アップロード時・再分類)で適用されます。`,
            );
          } catch (e) {
            lines.push(
              `⚠️ 分類ルールを追加できませんでした: ${e instanceof Error ? e.message : '不明なエラー'}`,
            );
          }
        } else if (action.name === 'list_classification_rules') {
          lines.push(this.formatRules(await this.ruleService.findAll()));
        } else if (action.name === 'remove_classification_rule') {
          // 番号は会話の途中でずれるため、文言での指定を優先する
          const { deleted, candidates } =
            await this.ruleService.deleteByTextOrNumber(
              String(action.input.text ?? '') || undefined,
              Number(action.input.number),
            );
          if (deleted) {
            lines.push(`🗑 分類ルール「${deleted.text}」を削除しました。`);
          } else if (candidates.length > 0) {
            // 取り違えて消さない。どれを消すかを選んでもらう
            lines.push(
              '⚠️ 該当する分類ルールが複数あります。消したいものを選んでください:\n\n' +
                candidates.map((r) => `- ${r.text}`).join('\n'),
            );
            options = candidates
              .slice(0, 10)
              .map((r) => `分類ルール「${r.text}」を削除`);
          } else {
            lines.push(
              '⚠️ 指定された分類ルールが見つかりませんでした。サイドバーの「分類ルール」から一覧・削除できます。',
            );
          }
        }
      }

      const reclassify = ragActions.find(
        (a) => a.name === 'reclassify_all_manuals',
      );
      if (reclassify) {
        // 管理者が依頼文で分類方針を指定していたら、確認を経て実行まで引き継ぐ
        const instruction =
          String(reclassify.input.instruction ?? '').trim() || undefined;
        const { target: manualCount, pinned: pinnedCount } =
          await this.manualService.reclassifyCounts();
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            pendingAction: {
              type: 'reclassify_all',
              instruction: instruction ?? null,
            },
          },
        });
        lines.push(
          `全${manualCount}件のマニュアルを、AIが工種・業務分野ごとのフォルダへ再分類します` +
            '(足りないフォルダは新しく作られます)。' +
            (pinnedCount > 0
              ? `📌 ピン留めされた${pinnedCount}件は動かしません。`
              : '') +
            (instruction ? `分類方針:「${instruction}」。` : '') +
            '今の分類は上書きされます。実行してよいですか？',
        );
        options = [CONFIRM_RECLASSIFY, CANCEL_RECLASSIFY];
      }

      // ツール名が想定外だった等で1行も作れなかった場合の保険(空の吹き出しを出さない)
      // 段落として分ける。Markdownでは単一の改行が空白に潰れるため、
      // '\n'でつなぐと結果が1行にべったり並んで読めなくなる
      answer =
        lines.join('\n\n') ||
        '依頼された操作を実行できませんでした。もう一度具体的に指示してください。';
      // 引用はRAG側が管理操作時に空にして返すため、ここでは触らない
    }

    // 4.6) 安全網(管理者のみ): モデルが実行結果を装った文章だけ書いて
    //      ツールを呼ばないことがある(履歴の成功メッセージの真似)。
    //      宣言と実行の食い違いを検知して、正しい次の一手を案内する
    if (isAdmin) {
      const notes: string[] = [];
      if (
        !ragActions.some((a) => a.name === 'reclassify_all_manuals') &&
        /再分類(を実行)?します/.test(answer)
      ) {
        notes.push(
          '(再分類はまだ実行されていません。「全マニュアルを再分類して」と送ると、確認のうえ実行します)',
        );
      }
      if (
        !ragActions.some((a) => a.name === 'add_classification_rule') &&
        // 「追加しました」以外の言い回しでも検知する
        /(分類ルール|ルール).{0,10}(を)?(追加|登録|保存|設定)(し|いたし)(ました|ます)/.test(
          answer,
        )
      ) {
        notes.push(
          '⚠️ 実際にはルールは登録されていません。サイドバーの「分類ルール」から登録すると確実です。',
        );
      }
      if (
        !ragActions.some((a) => a.name === 'move_manual') &&
        // 「移動します/移動させますね/移しました」など宣言だけのケース
        /(移動|移し).{0,8}(させ)?(ます|ました|ますね|ておきます)/.test(answer)
      ) {
        notes.push(
          '⚠️ 実際には移動していません。「〇〇のマニュアルを△△フォルダに移動して」と送るか、一覧画面でドラッグして移動してください。',
        );
      }
      if (
        !ragActions.some((a) => a.name === 'create_folder') &&
        /フォルダ.{0,10}(を)?(作成|作り).{0,6}(ます|ました|ますね|ておきます)/.test(
          answer,
        )
      ) {
        notes.push(
          '⚠️ 実際にはフォルダは作成されていません。もう一度「〇〇というフォルダを作って」と送ってください。',
        );
      }
      if (notes.length > 0) {
        answer = [answer, ...notes].join('\n');
      }
    }

    // 5) 回答を保存し、会話の更新日時を進める(サイドバーで新しい順に並べるため)
    const message = await this.appendAssistantMessage(
      conversation.id,
      answer,
      options,
      citations,
      answered,
      outcome,
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
    // マニュアルから答えられたか。管理操作の応答や定型文では渡さない(null)ので、
    // 「答えられなかった質問」の集計に混ざらない
    answeredFromManuals: boolean | null = null,
    // 判定できなかった理由まで残す(集計で「対象外」と「判定漏れ」を分ける)
    answerOutcome: string | null = null,
  ): Promise<Message> {
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content,
        // 根拠マニュアルは回答時点のスナップショットとしてJSONで保持
        citations: citations as unknown as Prisma.InputJsonValue,
        options: options,
        answeredFromManuals,
        answerOutcome,
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

  /**
   * 確認済みの全マニュアル再分類を開始する。
   * 数分かかりALB/CloudFrontのタイムアウトを超えうるため、リクエストは待たせず
   * 裏で実行し、結果は会話に書き込む(取り込みと同じ「結果はデータ」方針)。
   * ジョブ管理はManualServiceが持ち、サイドバーのボタン経由と共有する
   */
  private async startReclassify(
    conversationId: string,
    question: string,
    instruction?: string,
  ): Promise<AskResult> {
    const started = this.manualService.startReclassifyAll(
      instruction,
      (result) => {
        const content = result.ok
          ? `📁 全マニュアルの再分類が完了しました(${result.movedCount}件を割り当て)。` +
            (result.createdCategories.length > 0
              ? `\n新しく作られたフォルダ: ${result.createdCategories.join('、')}`
              : '') +
            // 空になったフォルダは画面側でまとめて片付けられる。
            // ここで件数だけ伝えて、削除の可否はモーダルで選んでもらう
            (result.emptiedCategories.length > 0
              ? `\n中身が他へ移って空になったフォルダが${result.emptiedCategories.length}個あります: ` +
                `${result.emptiedCategories.map((c) => c.name).join('、')}` +
                '\n画面に確認が出るので、そこでまとめて削除できます。' +
                '\n確認を閉じてしまった場合も、サイドバーの🗑から1つずつ削除できます。'
              : '') +
            '\nサイドバーのフォルダを開いて結果を確認してください。'
          : `再分類に失敗しました: ${result.error ?? '不明なエラー'}`;
        void this.appendAssistantMessage(conversationId, content).catch(
          () => undefined,
        );
      },
    );
    if (!started) {
      return this.respond(
        conversationId,
        question,
        '再分類は現在実行中です。完了までしばらくお待ちください。',
      );
    }
    return this.respond(
      conversationId,
      question,
      '⏳ 全マニュアルの再分類を開始しました(数分かかることがあります)。完了すると、この会話に結果が記録されます。',
    );
  }

  /** 会話の名前を変える(自分の会話だけ) */
  async renameConversation(id: string, userId: string, title: string) {
    await this.conversation(id, userId); // 所有者チェック
    const trimmed = title.trim();
    if (!trimmed) {
      throw new BadRequestException('チャット名を入力してください');
    }
    // サイドバーの並びは更新日時順。Prismaのupdateだと@updatedAtが必ず
    // 現在時刻に書き換わり、名前を変えただけで先頭へ飛んでしまうため、
    // titleだけを更新する生SQLを使う
    await this.prisma.$executeRaw`
      UPDATE "Conversation" SET title = ${trimmed.slice(0, 100)} WHERE id = ${id}
    `;
    return this.prisma.conversation.findUniqueOrThrow({ where: { id } });
  }

  async deleteConversation(id: string, userId: string) {
    const conversation = await this.conversation(id, userId); // 所有者チェック
    // 添付画像はS3にあり、DBを消しても残ってしまうので先に集めておく
    const withImages = await this.prisma.message.findMany({
      where: { conversationId: id },
      select: { imageKeys: true },
    });
    // メッセージはonDelete: Cascadeで一緒に消える
    await this.prisma.conversation.delete({ where: { id } });
    // S3側は後始末。失敗しても会話の削除はやり直せないので、ここでは止めない
    for (const row of withImages) {
      for (const key of (row.imageKeys as string[] | null) ?? []) {
        await this.storage.deleteObject(key).catch((e) => {
          console.warn(`添付画像を消せませんでした ${key}: ${e}`);
        });
      }
    }
    return conversation;
  }

  private makeTitle(question: string, maxLength = 30) {
    const oneLine = question.replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLength
      ? `${oneLine.slice(0, maxLength)}…`
      : oneLine;
  }

  /**
   * 回答に評価を付ける(自分の会話のものだけ)。
   *
   * 同じ値をもう一度押したら取り消し、というのは画面側で判断すると
   * 二重送信でずれるので、外した状態(null)を明示的に送ってもらう。
   */
  async rateAnswer(
    messageId: string,
    userId: string,
    feedback: MessageFeedback | null,
    reason: string | null,
  ): Promise<ChatMessage> {
    // 他人の会話のメッセージは「無い」と同じ扱いにする(存在自体を漏らさない)
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversation: { userId } },
    });
    if (!message) {
      throw new NotFoundException('メッセージが見つかりません');
    }
    if (message.role !== MessageRole.ASSISTANT) {
      throw new BadRequestException('評価できるのはAIの回答だけです');
    }
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        feedback,
        // 理由は👎のときだけ持つ。評価を外したり👍にしたら一緒に消す
        feedbackReason: feedback === MessageFeedback.BAD ? reason : null,
      },
    });
    return this.toChatMessage(updated);
  }

  private toChatMessage(message: Message): ChatMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      citations: (message.citations as RagCitation[] | null) ?? [],
      options: (message.options as string[] | null) ?? [],
      // URLは署名付きで期限があるので、必要になったところで付ける
      imageUrls: [],
      feedback: message.feedback,
      feedbackReason: message.feedbackReason,
      createdAt: message.createdAt,
    };
  }
}
