import { Module } from '@nestjs/common';
import { RagModule } from '../rag/module';
import { ChatResolver } from './resolver';
import { ChatService } from './service';

@Module({
  imports: [RagModule],
  providers: [ChatService, ChatResolver],
})
export class ChatModule {}
