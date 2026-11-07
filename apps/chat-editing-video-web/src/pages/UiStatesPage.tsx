import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button, ConfirmDialog, Dialog, Notice } from '../components/ui';
import { FramePreview, MediaProcessingState, SaveFailureState } from '../components/KeyStates';
import { registerUpload } from '../stores/uploads';
import placeholder from '../assets/frame-placeholder.svg';

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 400));

export function UiStatesPage() {
  const [deleting, setDeleting] = useState(false);
  const [frame, setFrame] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [upload, setUpload] = useState(false);
  const [processing, setProcessing] = useState<'failed' | 'processing'>('failed');
  const [removed, setRemoved] = useState(false);
  const [fail, setFail] = useState(false);
  const [notice, setNotice] = useState('');
  const [saveKey, setSaveKey] = useState(0);
  useEffect(() => {
    if (!upload) return;
    return registerUpload('preview-upload', async () => {
      await delay();
      setUpload(false);
    });
  }, [upload]);
  const simulate = async () => {
    await delay();
    if (fail) throw new Error('演示请求失败，请重试');
  };
  return (
    <main className="states-page page-width">
      <h1>确认、放大与异常提示</h1>
      <p className="muted">独立预览 · 以下均为演示数据，弹窗分别用于任务列表或编辑工作台。</p>
      <div className="preview-toolbar">
        <label>
          <input
            type="checkbox"
            checked={fail}
            onChange={(event) => setFail(event.target.checked)}
          />{' '}
          模拟请求失败
        </label>
        <Link to="/tasks">返回任务列表</Link>
      </div>
      {notice && <Notice>{notice}</Notice>}
      <div className="states-grid">
        <section className="panel">
          <h2>删除任务确认</h2>
          <p>将删除「片段拼接练习」及其素材、聊天记录和全部剪辑结果。</p>
          <p className="muted">删除后不可恢复。</p>
          <Button onClick={() => setDeleting(true)}>预览删除任务弹窗</Button>
        </section>
        <section className="panel">
          <h2>还有素材正在上传</h2>
          <p>离开将取消尚未完成的上传。</p>
          <p className="muted">已完整上传的素材保留；未完成的文件需要重新上传。</p>
          <div className="row">
            <Button onClick={() => setUpload((value) => !value)}>
              {upload ? '结束演示上传' : '模拟上传中'}
            </Button>
            <Link className="button" to="/tasks">
              尝试离开
            </Link>
          </div>
          {upload && <Notice>演示上传中：可点击“尝试离开”或关闭桌面窗口验证提醒。</Notice>}
        </section>
        <section className="panel">
          <h2>帧图放大 · V1</h2>
          <img src={placeholder} alt="演示帧画面" className="frame-image" />
          <div className="row between">
            <strong>时间位置：00:05:12</strong>
            <Button onClick={() => setFrame(true)}>放大查看</Button>
          </div>
          <p className="muted">即第 5 秒的第 12 帧，帧编号为 0～29。</p>
        </section>
        <section className="panel">
          <h2>处理和失败状态</h2>
          <MediaProcessingState source="V3" status="processing" />
          {!removed ? (
            <MediaProcessingState
              source="V4"
              status={processing}
              reason="转换未完成，请重试"
              onRetry={async () => {
                await simulate();
                setProcessing('processing');
              }}
              onDelete={async () => {
                await simulate();
                setRemoved(true);
              }}
            />
          ) : (
            <Notice>演示素材已删除</Notice>
          )}
          <SaveFailureState key={saveKey} onRetry={simulate} />
          <p className="muted">会话失效：账号已在其他位置登录</p>
          <Button onClick={() => setReplaced(true)}>预览登录失效提示</Button>
          <Button
            onClick={() => {
              setRemoved(false);
              setProcessing('failed');
              setSaveKey((value) => value + 1);
            }}
          >
            重置状态
          </Button>
        </section>
      </div>
      <ConfirmDialog
        open={deleting}
        title="删除任务？"
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await simulate();
          setNotice('演示任务已删除（未修改服务端数据）');
        }}
      >
        <p>将删除「片段拼接练习」及其素材、聊天记录和全部剪辑结果。</p>
        <p className="muted">删除后不可恢复。</p>
      </ConfirmDialog>
      <FramePreview
        open={frame}
        onClose={() => setFrame(false)}
        source="V1"
        imageUrl={placeholder}
        frame={162}
      />
      <Dialog
        open={replaced}
        title="登录已失效"
        onClose={() => setReplaced(false)}
        footer={
          <Button variant="primary" onClick={() => setReplaced(false)}>
            我知道了
          </Button>
        }
      >
        <p>账号已在其他位置登录</p>
        <p className="muted">正式场景会返回登录页；当前为独立交互预览。</p>
      </Dialog>
    </main>
  );
}
