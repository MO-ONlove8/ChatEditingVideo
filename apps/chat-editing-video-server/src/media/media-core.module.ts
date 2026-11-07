import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MediaTools } from './media-tools.service.js';
import { MediaProcessing, MEDIA_QUEUE } from './media-processing.service.js';
import { MediaService } from './media.service.js';
import { MediaImages } from './media-images.service.js';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: MEDIA_QUEUE })],
  providers: [MediaTools, MediaProcessing, MediaService, MediaImages],
  exports: [MediaTools, MediaProcessing, MediaService, MediaImages],
})
export class MediaCoreModule {}
