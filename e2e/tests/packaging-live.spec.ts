import { randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, stat, readdir, writeFile } from 'node:fs/promises';
import {
  _electron as electron,
  expect,
  test,
  request,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { videoFixture, execute } from '../../apps/chat-editing-video-server/test/support/video.js';
import type { EditorState, DesktopApi } from '../../packages/shared/src/index.js';

test.describe.configure({ mode: 'serial' });
let api: APIRequestContext, token: string, projectId: string;
const desktopDir = path.resolve('../apps/chat-editing-video-desktop');
const sharp = createRequire(path.resolve('../apps/chat-editing-video-server/package.json'))(
  'sharp',
) as typeof import('../../apps/chat-editing-video-server/node_modules/sharp/lib/index.js');
const state = async () =>
  (await api.get('projects/' + projectId + '/editor-state')).json() as Promise<EditorState>;
test.beforeAll(async () => {
  test.setTimeout(180000);
  const auth = await request.newContext({ baseURL: 'http://127.0.0.1:3000/api/' }),
    phone = '196' + randomInt(10000000, 99999999);
  await auth.post('auth/code', { data: { phone } });
  token = (await (await auth.post('auth/login', { data: { phone, code: '123456' } })).json()).token;
  await auth.dispose();
  api = await request.newContext({
    baseURL: 'http://127.0.0.1:3000/api/',
    extraHTTPHeaders: { Authorization: 'Bearer ' + token },
    timeout: 150000,
  });
  projectId = (await (await api.post('projects', { data: { name: 'D1字幕图文声音验收' } })).json())
    .id;
  const file = await videoFixture(path.resolve('test-results', 'd1-source.mp4'), [], 30, 4),
    id = randomUUID();
  const bytes = await readFile(file);
  expect(
    (
      await api.post('uploads', {
        data: {
          contextId: randomUUID(),
          projectId,
          files: [{ id, kind: 'video', fileName: 'source.mp4', sizeBytes: bytes.length }],
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await api.put('uploads/' + id + '/content', {
        headers: { 'Content-Type': 'application/octet-stream' },
        data: bytes,
      })
    ).ok(),
  ).toBe(true);
  await expect
    .poll(
      async () => (await (await api.get('projects/' + projectId + '/media')).json())[0]?.status,
      { timeout: 30000 },
    )
    .toBe('ready');
  await api.post('projects/' + projectId + '/chat/stream', {
    data: { requestId: randomUUID(), expectedRevision: 0, text: '把V1的0秒到2秒追加到末尾' },
  });
  await expect
    .poll(async () => (await state()).turns.at(-1)?.proposal?.previewStatus, { timeout: 30000 })
    .toBe('ready');
  const turn = (await state()).turns.at(-1)!,
    card = turn.proposal!;
  expect(
    (
      await api.post('projects/' + projectId + '/proposals/' + card.id + '/confirm', {
        data: {
          requestId: turn.requestId,
          generation: card.generation,
          contentHash: card.contentHash,
        },
      })
    ).ok(),
  ).toBe(true);
});
test.afterAll(async () => {
  if (projectId) await api.delete('projects/' + projectId);
  await api?.post('auth/logout');
  await api?.dispose();
});
async function commit(page: Page) {
  const button = page.getByRole('button', { name: '确认并保存', exact: true });
  await expect(button).toBeEnabled({ timeout: 30000 });
  await button.click();
  await expect(button).toHaveCount(0);
}
async function properties(page: Page, kind: string) {
  await page.getByRole('tab', { name: '属性', exact: true }).click();
  await page.getByRole('button', { name: kind, exact: true }).click();
}
test('uploads image/audio/SRT and edits, previews, saves and exports from real UI', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => sessionStorage.setItem('cev-session', t), token);
  await page.goto('/tasks/' + projectId + '/edit');
  await properties(page, '＋字幕');
  await page.getByLabel('元素文字').fill('欢迎来到北京');
  await page.getByLabel('起点', { exact: true }).fill('00:00:00');
  await page.getByLabel('尾帧', { exact: true }).fill('00:00:29');
  await page.getByRole('button', { name: '生成完整候选预览', exact: true }).click();
  await commit(page);
  expect((await state()).timeline.packaging?.subtitles[0]?.text).toBe('欢迎来到北京');
  await properties(page, '＋标题/文字');
  await page.getByLabel('元素文字').fill('秋日旅行');
  await page.getByRole('button', { name: '生成完整候选预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认并保存', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('tab', { name: '属性', exact: true }).click();
  await page.getByLabel('元素文字').fill('秋日旅行·北京');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认并保存', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '属性', exact: true }).click();
  await page.getByRole('button', { name: '更新完整候选', exact: true }).click();
  const restored = (await state()).turns.at(-1)!.proposal!.operation;
  await page.reload();
  await page.getByRole('tab', { name: '属性', exact: true }).click();
  await page.getByRole('button', { name: '编辑当前候选参数', exact: true }).click();
  await expect(page.getByLabel('元素文字')).toHaveValue('秋日旅行·北京');
  await page.getByLabel('元素文字').fill('秋日旅行·北京·已恢复');
  await page.getByRole('button', { name: '更新完整候选', exact: true }).click();
  const revised = (await state()).turns.at(-1)!.proposal!.operation;
  if (restored.kind === 'overlay' && revised.kind === 'overlay')
    expect(revised.item.id).toBe(restored.item.id);
  await commit(page);
  const logo = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  await page.getByLabel('上传素材类型').selectOption('image');
  await page
    .getByLabel('选择图音或SRT文件')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
  await expect(page.getByText('IMG1 · logo.png · 已就绪', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await properties(page, '＋图像');
  await page.getByLabel('来源文件', { exact: true }).selectOption({ label: 'IMG1 · logo.png' });
  await page.getByRole('button', { name: '生成完整候选预览', exact: true }).click();
  await commit(page);
  const audio = path.resolve('test-results', 'd1-tone.wav');
  await execute(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=1',
      audio,
    ],
    { windowsHide: true },
  );
  await page.getByLabel('上传素材类型').selectOption('audio');
  await page.getByLabel('选择图音或SRT文件').setInputFiles(audio);
  await expect(page.getByText('AUD1 · d1-tone.wav · 已就绪', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await properties(page, '＋声音');
  await page.getByLabel('来源文件', { exact: true }).selectOption({ label: 'AUD1 · d1-tone.wav' });
  await page.getByLabel('全片（随主轨长度变化）').check();
  await page.getByLabel('循环（默认关闭）').check();
  await page.getByRole('button', { name: '生成完整候选预览', exact: true }).click();
  await commit(page);
  await page.getByLabel('上传素材类型').selectOption('srt');
  await page.getByLabel('选择图音或SRT文件').setInputFiles({
    name: '字幕.srt',
    mimeType: 'application/x-subrip',
    buffer: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n新的字幕'),
  });
  const source = page
    .locator('details')
    .filter({ has: page.getByText('SRT1 · 字幕.srt · 已就绪', { exact: true }) });
  await source.locator('summary').click();
  await source.getByRole('button', { name: '整轨替换字幕…' }).click();
  await commit(page);
  await page.reload();
  await expect(page.getByRole('region', { name: '主视频预览' }).locator('img')).toHaveCount(3);
  await page.getByRole('button', { name: '下载成品', exact: true }).click();
  const revision = (await state()).timeline.revision;
  await expect(page.getByRole('button', { name: `保存MP4 v${revision}到本地` })).toBeVisible({
    timeout: 30000,
  });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: `保存MP4 v${revision}到本地` }).click();
  const mp4 = await downloading;
  expect(await mp4.failure()).toBeNull();
  await mp4.saveAs(test.info().outputPath('packaged.mp4'));
  await page.getByRole('button', { name: '导出 SRT', exact: true }).click();
  await expect(page.getByRole('button', { name: `保存SRT v${revision}到本地` })).toBeVisible({
    timeout: 15000,
  });
  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: `保存SRT v${revision}到本地` }).click();
  const srt = await textDownload;
  await srt.saveAs(test.info().outputPath('packaged.srt'));
  expect(await srt.failure()).toBeNull();
  await page.setViewportSize({ width: 960, height: 600 });
  await expect(page.getByLabel('输入剪辑指令')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(600);
  await page.screenshot({ path: test.info().outputPath('d1-web-960.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('app protocol loads packaged composition and saves both output types', async () => {
  test.setTimeout(90000);
  await mkdir(path.resolve('test-results'), { recursive: true });
  const profile = await mkdtemp(path.resolve('test-results', 'd1-electron-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: createRequire(path.join(desktopDir, 'package.json'))('electron') as string,
    args: [desktopDir],
    cwd: desktopDir,
    env: {
      ...env,
      ELECTRON_RENDERER_URL: '',
      CEV_API_BASE_URL: 'http://127.0.0.1:3000/api',
      CEV_USER_DATA_DIR: profile,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('load');
    await page.evaluate(
      (t) => (window as unknown as { desktop: DesktopApi }).desktop.saveSession(t),
      token,
    );
    await page.reload();
    await page.getByRole('link', { name: '继续编辑', exact: true }).click();
    const preview = page.getByRole('region', { name: '主视频预览' });
    await expect(preview.locator('img')).toHaveCount(3, { timeout: 20000 });
    await expect(page.getByText(/预览加载失败/)).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 600));
    await expect(page.getByLabel('输入剪辑指令')).toBeInViewport();
    const revision = (await state()).timeline.revision;
    for (const kind of ['MP4', 'SRT']) {
      const file = test.info().outputPath('desktop.' + kind.toLowerCase());
      await writeFile(file, 'existing file');
      await app.evaluate(({ dialog }, target) => {
        dialog.showSaveDialog = async (...args: unknown[]) => {
          const options = args.at(-1) as { properties?: string[] };
          if (!options.properties?.includes('showOverwriteConfirmation'))
            throw new Error('重名覆盖必须由原生对话框确认');
          return { canceled: false, filePath: target };
        };
      }, file);
      await page.getByRole('button', { name: `保存${kind} v${revision}到本地` }).click();
      await expect
        .poll(async () =>
          stat(file).then(
            (s) => s.size,
            () => 0,
          ),
        )
        .toBeGreaterThan(10);
      await expect
        .poll(async () => (await readFile(file)).equals(Buffer.from('existing file')))
        .toBe(false);
    }
    // Inject the operating system's ENOSPC error without filling the user's disk.
    const project = await (await api.get('projects/' + projectId)).json(),
      jobId = project.latestJob.id as string;
    const failedTarget = test.info().outputPath('disk-full.mp4');
    await app.evaluate(async ({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      const fs = process.getBuiltinModule('node:fs'),
        modules = process.getBuiltinModule('node:module');
      const globals = globalThis as typeof globalThis & { cevRestoreWrite?: () => void };
      const old = fs.createWriteStream;
      fs.createWriteStream = (() => {
        throw Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' });
      }) as typeof old;
      modules.syncBuiltinESMExports();
      globals.cevRestoreWrite = () => {
        fs.createWriteStream = old;
        modules.syncBuiltinESMExports();
      };
    }, failedTarget);
    const localError = await page.evaluate(async (id) => {
      try {
        await (window as unknown as { desktop: DesktopApi }).desktop.downloadRender(id);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    }, jobId);
    expect(localError).toContain('ENOSPC');
    await app.evaluate(() => {
      const globals = globalThis as typeof globalThis & { cevRestoreWrite?: () => void };
      globals.cevRestoreWrite?.();
      delete globals.cevRestoreWrite;
    });
    expect((await (await api.get('jobs/' + jobId)).json()).status).toBe('succeeded');
    expect(
      (await readdir(path.dirname(failedTarget))).filter((f) => f.startsWith('disk-full.mp4')),
    ).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('d1-desktop-960.png'), fullPage: true });
  } finally {
    await app.close();
  }
});
