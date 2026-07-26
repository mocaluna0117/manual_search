import {
  Args,
  ID,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { AskResult, ChatMessage, Conversation } from './model';
import { ChatService } from './service';

@Resolver(() => Conversation)
export class ChatResolver {
  constructor(private readonly chatService: ChatService) {}

  // サイドバーの履歴一覧(新しい順)
  @Query(() => [Conversation])
  conversations() {
    return this.chatService.conversations();
  }

  @Query(() => Conversation)
  conversation(@Args('id', { type: () => ID }) id: string) {
    return this.chatService.conversation(id);
  }

  // Conversationのmessagesフィールドが「実際に要求されたときだけ」実行される。
  // 一覧表示ではmessagesを取らないので、無駄なクエリが走らない(遅延取得)
  @ResolveField(() => [ChatMessage])
  messages(@Parent() conversation: Conversation) {
    return this.chatService.messages(conversation.id);
  }

  // 質問を投げる。conversationId省略で新規会話が始まる
  @Mutation(() => AskResult)
  askQuestion(
    @Args('question') question: string,
    @Args('conversationId', { type: () => ID, nullable: true })
    conversationId?: string,
  ) {
    return this.chatService.ask(question, conversationId);
  }

  @Mutation(() => Conversation)
  deleteConversation(@Args('id', { type: () => ID }) id: string) {
    return this.chatService.deleteConversation(id);
  }
}
