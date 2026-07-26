import { Module } from '@nestjs/common';
import { RagModule } from '../rag/module';
import { UserModule } from '../user/module';
import { ChatResolver } from './resolver';
import { ChatService } from './service';

@Module({
  imports: [RagModule, UserModule],
  providers: [ChatService, ChatResolver],
})
export class ChatModule {}
