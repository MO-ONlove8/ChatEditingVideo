import mediaProcessingStateStyles from '../../../../../../../../components/MediaProcessingState/index.module.less';
import { useState } from 'react';
import { retryTransfer, type Transfer } from '../../../../../../../../lib/media-upload';
import { Button } from '../../../../../../../../components/Button';
import { Notice } from '../../../../../../../../components/Notice';
import common from '../../../../../../../../styles/common.module.less';

export function TransferRow({ item }: { item: Transfer }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (item.status === 'saved' || item.status === 'cancelled') return null;
  return (
    <div className={mediaProcessingStateStyles.mediaState}>
      <div className={`${common.row} ${common.between}`}>
        <strong>{item.file.name}</strong>
        <span>
          {item.status === 'failed'
            ? '上传失败'
            : item.status === 'validating'
              ? '正在校验并保存…'
              : item.status === 'checking'
                ? '正在查询保存结果…'
                : item.status === 'waiting'
                  ? '等待上传'
                  : `上传中 ${item.progress}%`}
        </span>
      </div>
      <progress value={item.progress} max={100} />
      {item.status === 'checking' && <p>{item.error}</p>}
      {item.status === 'failed' && (
        <>
          <p>{item.error}</p>
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void retryTransfer(item)
                .catch((error) => setError(String(error.message)))
                .finally(() => setBusy(false));
            }}
          >
            查询结果 / 重新上传
          </Button>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
