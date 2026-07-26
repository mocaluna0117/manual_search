import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { MessageRole } from '../../generated/prisma/client';
import { RagCitation } from '../rag/model';

registerEnumType(MessageRole, {
  name: 'MessageRole',
  description: 'メッセージの発言者(USER=質問 / ASSISTANT=AI回答)',
});

export { MessageRole };

@ObjectType()
export class ChatMessage {
  @Field(() => ID)
  id!: string;

  @Field(() => MessageRole)
  role!: MessageRole;

  @Field()
  content!: string;

  // 回答の根拠マニュアル(USERメッセージでは常に空)
  @Field(() => [RagCitation])
  citations!: RagCitation[];

  @Field()
  createdAt!: Date;
}

@ObjectType()
export class Conversation {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  // messagesはここに書かず@ResolveFieldで遅延取得する(resolver参照)

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

// askQuestionの戻り値。新規会話の場合はconversationIdで新しいIDを知らせる
@ObjectType()
export class AskResult {
  @Field(() => ID)
  conversationId!: string;

  @Field(() => ChatMessage)
  message!: ChatMessage;
}
