import { Module } from '@nestjs/common';
import { CategoryModule } from '../category/module';
import { ManualModule } from '../manual/module';
import { RagModule } from '../rag/module';
import { RuleModule } from '../rule/module';
import { UserModule } from '../user/module';
import { ChatResolver } from './resolver';
import { ChatStreamController } from './stream-controller';
import { ChatService } from './service';

@Module({
  // Category/Manualはチャット経由の管理操作(フォルダ作成・再分類)で使う
  imports: [RagModule, UserModule, CategoryModule, ManualModule, RuleModule],
  controllers: [ChatStreamController],
  providers: [ChatService, ChatResolver],
})
export class ChatModule {}
