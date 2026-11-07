import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ui';
import { FramePreview, MediaProcessingState, SaveFailureState } from './KeyStates';

afterEach(() => vi.restoreAllMocks());
describe('key interactions', () => {
  it('keeps a failed deletion open and prevents duplicate submission', async () => {
    let reject!: (error: Error) => void;
    const confirm = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const close = vi.fn();
    render(
      <ConfirmDialog open title="删除任务？" onConfirm={confirm} onClose={close}>
        删除后不可恢复。
      </ConfirmDialog>,
    );
    const button = screen.getByRole('button', { name: '确认删除' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
    reject(new Error('删除失败，请重试'));
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败，请重试');
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('copies exact frame time and reports clipboard errors', async () => {
    const clipboard = {
      writeText: vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce(undefined),
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    render(
      <FramePreview open source="V1" imageUrl="/frame.png" frame={108162} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制时间' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
    fireEvent.click(screen.getByRole('button', { name: '复制时间' }));
    expect(await screen.findByRole('status')).toHaveTextContent('时间已复制');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('01:00:05:12');
  });
  it('retains retry on failure, and cannot repeat a successful save', async () => {
    const retry = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络不可用'))
      .mockResolvedValue(undefined);
    render(<SaveFailureState onRetry={retry} />);
    await userEvent.click(screen.getByRole('button', { name: '重试保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络不可用');
    expect(screen.getByText('时间轴保持上次保存结果，重试只执行一次')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重试保存' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled());
    expect(retry).toHaveBeenCalledTimes(2);
  });
  it('processing state has no retry/edit controls', () => {
    render(<MediaProcessingState source="V3" status="processing" />);
    expect(screen.getByText('转换完成后才能查看帧图并用于剪辑')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
