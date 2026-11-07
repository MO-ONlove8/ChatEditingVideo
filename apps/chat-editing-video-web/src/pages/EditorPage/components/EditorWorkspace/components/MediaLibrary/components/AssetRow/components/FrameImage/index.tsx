import { useBlob } from '../../../../hooks/useBlob';
import styles from './index.module.less';

export function FrameImage({
  path,
  frame,
  onSelect,
}: {
  path: string;
  frame: number;
  onSelect: () => void;
}) {
  const image = useBlob(path);
  return (
    <button
      className={styles.frameThumbnail}
      onClick={image.error ? image.retry : onSelect}
      aria-label={image.error ? `重试第 ${frame % 30} 帧图片` : `放大第 ${frame % 30} 帧`}
    >
      {image?.url ? (
        <img src={image.url} alt={`第 ${frame % 30} 帧`} />
      ) : (
        <span>{image?.error ? '加载失败，点击重试' : '加载中…'}</span>
      )}
      <small>{frame % 30}</small>
    </button>
  );
}
