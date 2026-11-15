import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MediaTools } from './media-tools.service.js';
import { MediaProcessing, MEDIA_QUEUE, MEDIA_INDEX_QUEUE } from './media-processing.service.js';
import { MediaService } from './media.service.js';
import { MediaImages } from './media-images.service.js';
import { AuxiliaryTools } from '../composition/auxiliary-tools.service.js';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: MEDIA_QUEUE }, { name: MEDIA_INDEX_QUEUE })],
  providers: [MediaTools, MediaProcessing, MediaService, MediaImages, AuxiliaryTools],
  exports: [MediaTools, MediaProcessing, MediaService, MediaImages, AuxiliaryTools],
})
export class MediaCoreModule {}
