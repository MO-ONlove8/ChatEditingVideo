import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const execute = promisify(execFile);

/** Small real video; each source frame has a distinct pattern and a visible index. */
export async function videoFixture(file: string, extra: string[] = [], rate = 30, duration = 1.2) {
  await mkdir(path.dirname(file), { recursive: true });
  const font = process.platform === 'win32' ? "fontfile='C\\:/Windows/Fonts/arial.ttf':" : '';
  await execute(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=320x180:rate=${rate}:duration=${duration}`,
      '-vf',
      `drawtext=${font}text='%{n}':fontsize=32:fontcolor=white:box=1:boxcolor=black:x=10:y=10`,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '1',
      ...extra,
      file,
    ],
    { windowsHide: true },
  );
  return file;
}
