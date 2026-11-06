import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { BadRequestException, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { StorageService } from '../storage/storage.service.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';

@Module({
  imports: [
    ProjectsModule,
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
            if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) {
              cb(null, true);
            } else {
              cb(new BadRequestException(`Unsupported media type: ${file.mimetype}`), false);
            }
          },
        };
      },
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
