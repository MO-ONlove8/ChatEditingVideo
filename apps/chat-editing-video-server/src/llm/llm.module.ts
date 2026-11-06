import { Global, Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { LlmService } from './llm.service.js';

@Global()
@Module({
  controllers: [ChatController],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
