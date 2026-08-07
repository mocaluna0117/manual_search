import {
  Args,
  Context,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import type { Response } from 'express';
import type { AuthUser } from '../auth/current-user';
import { CurrentUser } from '../auth/current-user';
import { UserService } from '../user/service';
import { AskResult, ChatMessage, Conversation } from './model';
import { ChatService } from './service';

@Resolver(() => Conversation)
export class ChatResolver {
  constructor(
    private readonly chatService: ChatService,
    private readonly userService: UserService,
  ) {}

  // サイドバーの履歴一覧(自分の会話のみ・新しい順)
  @Query(() => [Conversation])
  async conversations(@CurrentUser() authUser: AuthUser) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.conversations(user.id);
  }

  @Query(() => Conversation)
  async conversation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.conversation(id, user.id);
  }

  // Conversationのmessagesフィールドが「実際に要求されたときだけ」実行される。
  // 親のConversationは上のQuery経由でしか取れず、そこで所有者チェック済み
  @ResolveField(() => [ChatMessage])
  messages(@Parent() conversation: Conversation) {
    return this.chatService.messages(conversation.id);
  }

  // 質問を投げる。conversationId省略で新規会話が始まる。画像添付は任意
  @Mutation(() => AskResult)
  async askQuestion(
    @Args('question') question: string,
    @CurrentUser() authUser: AuthUser,
    @Context() ctx: { res?: Response },
    @Args('conversationId', { type: () => ID, nullable: true })
    conversationId?: string,
    @Args('imageBase64', { type: () => String, nullable: true })
    imageBase64?: string,
    @Args('imageFormat', { type: () => String, nullable: true })
    imageFormat?: string,
  ) {
    const user = await this.userService.ensure(authUser);
    const image = imageBase64
      ? { base64: imageBase64, format: imageFormat ?? 'jpeg' }
      : undefined;
    // フロントの「停止」ボタン(=接続の切断)をRAG呼び出しの中断につなげる。
    // 正常終了でも'close'は発火するため、レスポンス送信済みかどうかで見分ける
    const controller = new AbortController();
    ctx.res?.on('close', () => {
      if (!ctx.res?.writableEnded) controller.abort();
    });
    return this.chatService.ask(
      question,
      user.id,
      conversationId,
      image,
      controller.signal,
    );
  }

  @Mutation(() => Conversation)
  async deleteConversation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() authUser: AuthUser,
  ) {
    const user = await this.userService.ensure(authUser);
    return this.chatService.deleteConversation(id, user.id);
  }
}
