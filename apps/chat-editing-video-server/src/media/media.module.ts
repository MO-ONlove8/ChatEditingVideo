import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { BadRequestException, Module, type DynamicModule } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { MediaCoreModule } from './media-core.module.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaController } from './media.controller.js';
import { MediaFilesController } from './media-files.controller.js';
import { MediaProcessor } from './media-processing.service.js';

@Module({
  imports: [
    MediaCoreModule,
    MulterModule.registerAsync({
      inject: [APP_CONFIG, StorageService],
      useFactory: (env: Env, storage: StorageService) => {
        // Stream uploads to disk (never buffer GB-sized video in memory).
        const tmpDir = path.join(storage.root, '.tmp');
        mkdirSync(tmpDir, { recursive: true });
        return {
          storage: diskStorage({ destination: tmpDir }),
          limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
          fileFilter: (_req, file, cb) => {
            if (/\.(mp4|mov)$/i.test(file.originalname)) {
              cb(null, true);
            } else {
              cb(new BadRequestException(`Unsupported media type: ${file.mimetype}`), false);
            }
          },
        };
      },
    }),
  ],
  controllers: [MediaController, MediaFilesController],
})
export class MediaModule {
  static forRoot(env: Env): DynamicModule {
    return { module: MediaModule, providers: env.MEDIA_WORKER_ENABLED ? [MediaProcessor] : [] };
  }
}
