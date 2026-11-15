import { useRef, useState } from 'react';
import {
  EditorStateSchema,
  defaultAudio,
  defaultSubtitleStyle,
  defaultTextStyle,
  effectiveRange,
  emptyPackaging,
  formatTimecode,
  plannedRange,
  timelineFrames,
  type ElementEdit,
  type EditorState,
  type MediaAsset,
  type TextStyle,
  type Proposal,
} from '@cev/shared';
import { api } from '../../../../../../lib/api';
import { editorPath } from '../../../../../../lib/editing';
import { Button } from '../../../../../../components/Button';
import { Notice } from '../../../../../../components/Notice';
import { useMedia } from '../MediaLibrary/hooks/useMedia';
import common from '../../../../../../styles/common.module.less';
import styles from './index.module.less';

type Props = {
  projectId: string;
  state: EditorState;
  onState: (s: EditorState) => void;
  frame: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  onPreview: (start: number, end: number) => void;
  onDirty: (requestId: string, dirty: boolean) => void;
};
export function PackagingPanel(props: Props) {
  const p = props.state.timeline.packaging ?? emptyPackaging(),
    n = timelineFrames(props.state.timeline),
    assets = useMedia(props.projectId);
  const [mode, setMode] = useState<ElementEdit['kind']>('subtitle'),
    [fresh, setFresh] = useState(0),
    [candidateId, setCandidateId] = useState<string>(),
    [top, setTop] = useState(0);
  const objects = [
    ...props.state.timeline.clips.map((c, i) => ({
      id: c.id,
      label: 'Clip' + (i + 1) + ' 原声',
      kind: 'clip-audio' as const,
      range: null,
    })),
    ...p.subtitles.map((s) => ({
      id: s.id,
      label: 'S' + s.number + ' ' + s.text,
      kind: 'subtitle' as const,
      range: { mode: 'fixed' as const, startFrame: s.startFrame, endFrame: s.endFrame },
    })),
    ...p.overlays.map((o) => ({
      id: o.id,
      label:
        (o.kind === 'text' ? 'T' : 'I') + o.number + (o.kind === 'text' ? ' ' + o.text : ' 图像'),
      kind: o.kind,
      range: o.range,
    })),
    ...p.audio.map((a) => ({
      id: a.id,
      label: 'A' + a.number + ' ' + (a.role === 'bgm' ? 'BGM' : '旁白'),
      kind: 'audio' as const,
      range: a.range,
    })),
  ];
  const selected = objects.find((o) => o.id === props.selectedId),
    pending = props.state.turns.find((t) => t.status === 'pending'),
    card = pending?.proposal,
    editingCard = card && card.id === candidateId ? card : undefined,
    operation = editingCard?.operation,
    candidateKind = operation?.kind === 'overlay' ? operation.item.kind : operation?.kind,
    kind =
      candidateKind &&
      [
        'subtitle',
        'text',
        'image',
        'audio',
        'clip-audio',
        'subtitle-style',
        'subtitle-replace',
      ].includes(candidateKind)
        ? (candidateKind as ElementEdit['kind'])
        : (selected?.kind ?? mode);
  const visible = objects.slice(Math.max(0, Math.floor(top / 36) - 2), Math.floor(top / 36) + 12),
    start = Math.max(0, Math.floor(top / 36) - 2);
  const choose = (m: ElementEdit['kind']) => {
    setMode(m);
    setCandidateId(undefined);
    setFresh(fresh + 1);
    props.onSelect('');
  };
  return (
    <section className={styles.panel}>
      <h2>属性</h2>
      {card?.candidate &&
        !['delete-element', 'delete-clip', 'layer', 'add', 'move', 'copy'].includes(
          card.operation.kind,
        ) && (
          <Button
            onClick={() => {
              setCandidateId(card.id);
              setFresh((n) => n + 1);
            }}
          >
            编辑当前候选参数
          </Button>
        )}
      <div className={styles.tools}>
        {(
          [
            ['subtitle', '＋字幕'],
            ['text', '＋标题/文字'],
            ['image', '＋图像'],
            ['audio', '＋声音'],
            ['subtitle-style', '字幕统一样式'],
            ['subtitle-replace', 'SRT整轨替换'],
          ] as const
        ).map(([m, label]) => (
          <Button key={m} onClick={() => choose(m)}>
            {label}
          </Button>
        ))}
      </div>
      <div
        className={styles.objects}
        onScroll={(e) => setTop(e.currentTarget.scrollTop)}
        aria-label="元素列表"
      >
        <div style={{ height: objects.length * 36, position: 'relative' }}>
          {visible.map((o, i) => {
            const r = o.range ? effectiveRange(o.range, n) : null;
            return (
              <button
                key={o.id}
                style={{
                  position: 'absolute',
                  top: (start + i) * 36,
                  left: 0,
                  right: 0,
                  height: 36,
                }}
                aria-pressed={o.id === props.selectedId}
                onClick={() => {
                  setCandidateId(undefined);
                  props.onSelect(o.id);
                }}
              >
                {o.label}
                {o.range && !r ? ' · 暂不生效' : ''}
              </button>
            );
          })}
        </div>
      </div>
      <PropertyForm
        key={
          (editingCard?.id ?? selected?.id ?? mode) +
          ':' +
          props.state.timeline.revision +
          ':' +
          fresh
        }
        {...props}
        assets={assets.data ?? []}
        kind={kind}
        editingCard={editingCard}
      />
    </section>
  );
}
function PropertyForm({
  projectId,
  state,
  onState,
  frame,
  selectedId,
  onPreview,
  onDirty,
  assets,
  kind,
  editingCard,
}: Props & { assets: MediaAsset[]; kind: ElementEdit['kind']; editingCard?: Proposal }) {
  const original = state.timeline;
  const target =
    editingCard && 'item' in editingCard.operation
      ? editingCard.operation.item.id
      : editingCard?.operation.kind === 'clip-audio'
        ? editingCard.operation.id
        : selectedId;
  const t = state.timeline,
    draft = editingCard?.candidate ?? t,
    p = draft.packaging ?? emptyPackaging(),
    n = timelineFrames(t),
    subtitle = p.subtitles.find((s) => s.id === target),
    overlay = p.overlays.find((o) => o.id === target),
    audio = p.audio.find((a) => a.id === target),
    clip = draft.clips.find((c) => c.id === target);
  const r = subtitle
    ? { mode: 'fixed' as const, startFrame: subtitle.startFrame, endFrame: subtitle.endFrame }
    : (overlay?.range ?? audio?.range);
  const planned = r ? plannedRange(r, n) : null,
    range = r ? effectiveRange(r, n) : null,
    inactive = Boolean(r && !range);
  const [text, setText] = useState(
      subtitle?.text ?? (overlay?.kind === 'text' ? overlay.text : ''),
    ),
    [asset, setAsset] = useState(
      overlay?.kind === 'image'
        ? overlay.assetId
        : (audio?.assetId ??
            (editingCard?.operation.kind === 'subtitle-replace'
              ? editingCard.operation.sourceAssetId
              : '') ??
            ''),
    );
  const [begin, setBegin] = useState(planned ? formatTimecode(planned.startFrame) : ''),
    [end, setEnd] = useState(planned ? formatTimecode(Math.max(0, planned.endFrame)) : '');
  const [whole, setWhole] = useState(r?.mode === 'whole'),
    [role, setRole] = useState<'narration' | 'bgm'>(audio?.role ?? 'bgm');
  const [style, setStyle] = useState<TextStyle>(
    kind === 'subtitle-style'
      ? p.subtitleStyle
      : overlay?.kind === 'text'
        ? overlay.style
        : defaultTextStyle(),
  );
  const [settings, setSettings] = useState(
      audio?.settings ?? clip?.audio ?? { ...defaultAudio(), volume: kind === 'audio' ? 20 : 100 },
    ),
    [loop, setLoop] = useState(audio?.loop ?? false);
  const [sourceBegin, setSourceBegin] = useState(audio ? formatTimecode(audio.sourceStart) : ''),
    [sourceEnd, setSourceEnd] = useState(audio ? formatTimecode(audio.sourceEnd) : '');
  const [x, setX] = useState(overlay?.kind === 'image' ? overlay.x : 50),
    [y, setY] = useState(overlay?.kind === 'image' ? overlay.y : 50),
    [width, setWidth] = useState<number | undefined>(
      overlay?.kind === 'image' ? overlay.width : undefined,
    ),
    [opacity, setOpacity] = useState(overlay?.kind === 'image' ? overlay.opacity : 100);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copyStart, setCopyStart] = useState('');
  const request = useRef(
      editingCard
        ? state.turns.find((t) => t.proposal?.id === editingCard.id)!.requestId
        : crypto.randomUUID(),
    ),
    edits = useRef(0),
    lock = useRef(false);
  const pending = state.turns.find(
      (turn) => turn.status === 'pending' || turn.status === 'understanding',
    ),
    own = pending?.requestId === request.current;
  const blocked = busy || Boolean(pending && !own),
    canEdit = n > 0 && !inactive;
  const dirty = () => {
    edits.current++;
    onDirty(request.current, true);
  };
  const propose = async (patch: Partial<ElementEdit> = {}) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const submittedEdits = edits.current;
    try {
      let input: Partial<ElementEdit> = {
        requestId: request.current,
        expectedRevision: t.revision,
        kind,
        id: editingCard
          ? [
              ...original.clips,
              ...(original.packaging?.subtitles ?? []),
              ...(original.packaging?.overlays ?? []),
              ...(original.packaging?.audio ?? []),
            ].some((o) => o.id === target)
            ? target
            : undefined
          : selectedId || undefined,
        playhead: frame,
      };
      if (kind === 'subtitle' || kind === 'text') input.text = text.replace(/\r\n?/g, '\n');
      if (['image', 'audio', 'subtitle-replace'].includes(kind)) input.assetId = asset || undefined;
      if (['subtitle', 'text', 'image', 'audio'].includes(kind)) {
        input.whole = whole;
        if (whole) input.whole = true;
        else {
          if (begin) input.startTime = begin;
          if (end) input.endTime = end;
        }
      }
      if (kind === 'text' || kind === 'subtitle-style') input.style = style;
      if (kind === 'image') Object.assign(input, { x, y, width, opacity });
      if (kind === 'audio')
        Object.assign(input, {
          role,
          settings,
          loop,
          ...(sourceBegin ? { sourceStartTime: sourceBegin } : {}),
          ...(sourceEnd ? { sourceEndTime: sourceEnd } : {}),
        });
      if (kind === 'clip-audio') input.settings = settings;
      input = { ...input, ...patch };
      const url =
        editorPath(projectId) +
        '/proposals' +
        (own && pending?.proposal ? '/' + pending.proposal.id + '/update' : '');
      onState(await api(EditorStateSchema, url, { method: 'POST', body: JSON.stringify(input) }));
      if (edits.current === submittedEdits) onDirty(request.current, false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const num = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    min = 0,
    max = 100,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
  const time = (label: string, value: string, onChange: (v: string) => void) => (
    <label>
      {label}
      <input
        value={value}
        placeholder="默认值（分:秒:帧）"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
  const appearance = (s: TextStyle) => (
    <fieldset>
      <legend>文字样式</legend>
      {num('字号 / 短边 %', s.size, (v) => setStyle({ ...s, size: v }), 1, 20, 0.1)}
      {num('文本框宽度 %', s.width, (v) => setStyle({ ...s, width: v }), 10, 100)}
      <label>
        字色
        <input
          type="color"
          value={s.color}
          onChange={(e) => setStyle({ ...s, color: e.target.value })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={s.bold}
          onChange={(e) => setStyle({ ...s, bold: e.target.checked })}
        />
        粗体
      </label>
      <label>
        对齐
        <select
          value={s.align}
          onChange={(e) => setStyle({ ...s, align: e.target.value as TextStyle['align'] })}
        >
          <option value="left">左</option>
          <option value="center">中</option>
          <option value="right">右</option>
        </select>
      </label>
      {num('中心 X %', s.x, (v) => setStyle({ ...s, x: v }))}
      {num('定位 Y %', s.y, (v) => setStyle({ ...s, y: v }))}
      <label>
        垂直锚点
        <select
          value={s.anchor}
          onChange={(e) => setStyle({ ...s, anchor: e.target.value as TextStyle['anchor'] })}
        >
          <option value="top">顶部</option>
          <option value="center">中心</option>
          <option value="bottom">底部</option>
        </select>
      </label>
      {num('不透明度 %', s.opacity, (v) => setStyle({ ...s, opacity: v }))}
      {num('描边 / 短边 %', s.outline, (v) => setStyle({ ...s, outline: v }), 0, 1, 0.05)}
      <label>
        描边色
        <input
          type="color"
          value={s.outlineColor}
          onChange={(e) => setStyle({ ...s, outlineColor: e.target.value })}
        />
      </label>
      <label>
        背景色
        <input
          type="color"
          value={s.background}
          onChange={(e) => setStyle({ ...s, background: e.target.value })}
        />
      </label>
      {num('背景不透明度 %', s.backgroundOpacity, (v) => setStyle({ ...s, backgroundOpacity: v }))}
    </fieldset>
  );
  return (
    <form
      className={styles.form}
      onChange={dirty}
      onSubmit={(e) => {
        e.preventDefault();
        void propose();
      }}
    >
      <h3>
        {
          {
            subtitle: '字幕',
            text: '标题 / 说明文字',
            image: '图像 / Logo',
            audio: '旁白 / BGM',
            'clip-audio': 'Clip 原声',
            'subtitle-style': '全轨统一样式',
            'subtitle-replace': 'SRT 整轨替换',
            'delete-element': '删除',
            layer: '层级',
            'copy-overlay': '复制',
          }[kind]
        }
      </h3>
      {!n && <Notice>暂无主视频，已有计划保留；仅可查看或删除元素。</Notice>}
      {inactive && <Notice>暂不生效 · 计划保留，只可查看或删除。</Notice>}
      <fieldset disabled={blocked || !canEdit}>
        {(kind === 'subtitle' || kind === 'text') && (
          <label>
            文字（最多200字符）
            <textarea
              aria-label="元素文字"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        {kind === 'text' && !overlay && (
          <div className={common.row}>
            <Button
              type="button"
              onClick={() => {
                dirty();
                setStyle(defaultTextStyle(true));
              }}
            >
              标题默认
            </Button>
            <Button
              type="button"
              onClick={() => {
                dirty();
                setStyle(defaultTextStyle(false));
              }}
            >
              说明默认
            </Button>
          </div>
        )}
        {['image', 'audio', 'subtitle-replace'].includes(kind) && (
          <label>
            来源文件
            <select aria-label="来源文件" value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value="">请选择已就绪文件</option>
              {assets
                .filter(
                  (a) =>
                    a.kind === (kind === 'subtitle-replace' ? 'srt' : kind) && a.status === 'ready',
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {kind === 'image' ? 'IMG' : kind === 'audio' ? 'AUD' : 'SRT'}
                    {a.number} · {a.fileName}
                  </option>
                ))}
            </select>
          </label>
        )}
        {kind === 'audio' && (
          <label>
            角色
            <select
              value={role}
              onChange={(e) => {
                const v = e.target.value as typeof role;
                setRole(v);
                if (!audio) setSettings({ ...settings, volume: v === 'bgm' ? 20 : 100 });
                if (v === 'narration') {
                  setWhole(false);
                  setLoop(false);
                }
              }}
            >
              <option value="bgm">BGM（最多一个）</option>
              <option value="narration">旁白（最多一个）</option>
            </select>
          </label>
        )}
        {['text', 'image', 'subtitle', 'audio'].includes(kind) && (
          <fieldset>
            <legend>作用范围 · 包含尾帧</legend>
            {(kind === 'text' || kind === 'image' || (kind === 'audio' && role === 'bgm')) && (
              <label>
                <input
                  type="checkbox"
                  checked={whole}
                  onChange={(e) => setWhole(e.target.checked)}
                />
                全片（随主轨长度变化）
              </label>
            )}
            {!whole && (
              <>
                {time('起点', begin, setBegin)}
                {time('尾帧', end, setEnd)}
              </>
            )}
            <small>留空按播放头和需求默认值计算；明确越界会拒绝。</small>
          </fieldset>
        )}
        {(kind === 'text' || kind === 'subtitle-style') && appearance(style)}
        {kind === 'subtitle-style' && (
          <Button
            type="button"
            onClick={() => {
              dirty();
              setStyle(defaultSubtitleStyle());
            }}
          >
            恢复字幕默认样式
          </Button>
        )}
        {kind === 'image' && (
          <>
            {num('中心 X %', x, setX)}
            {num('中心 Y %', y, setY)}
            <label>
              宽度 / 画布 %
              <input
                type="number"
                min={1}
                max={100}
                value={width ?? ''}
                placeholder="默认25%，过高等比缩小"
                onChange={(e) => setWidth(e.target.value ? Number(e.target.value) : undefined)}
              />
            </label>
            {num('不透明度 %', opacity, setOpacity)}
            <div className={styles.nine} aria-label="九宫格位置">
              {Array.from({ length: 9 }, (_, i) => (
                <Button
                  type="button"
                  key={i}
                  onClick={() => {
                    dirty();
                    const info = assets.find((a) => a.id === asset)?.auxiliary,
                      w = width ?? 25,
                      h =
                        info?.width && info.height && t.canvas
                          ? (((w * t.canvas.width) / t.canvas.height) * info.height) / info.width
                          : w;
                    setX([w / 2, 50, 100 - w / 2][i % 3]!);
                    setY([h / 2, 50, 100 - h / 2][Math.floor(i / 3)]!);
                  }}
                >
                  {['左上', '上中', '右上', '左中', '居中', '右中', '左下', '下中', '右下'][i]}
                </Button>
              ))}
            </div>
          </>
        )}
        {(kind === 'audio' || kind === 'clip-audio') && (
          <fieldset>
            <legend>声音参数</legend>
            {kind === 'clip-audio' && (
              <p>
                {assets.find((a) => a.id === clip?.source)?.original?.hasAudio
                  ? '原声随Clip移动、复制和删除'
                  : '无原声，输出静音'}
              </p>
            )}
            {kind === 'audio' && (
              <>
                {time('源起帧', sourceBegin, setSourceBegin)}
                {time('源尾帧', sourceEnd, setSourceEnd)}
                {role === 'bgm' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={loop}
                      onChange={(e) => setLoop(e.target.checked)}
                    />
                    循环（默认关闭）
                  </label>
                )}
              </>
            )}
            {num(
              '线性音量 %',
              settings.volume,
              (v) => setSettings({ ...settings, volume: v }),
              0,
              200,
            )}
            <label>
              <input
                type="checkbox"
                checked={settings.muted}
                onChange={(e) => setSettings({ ...settings, muted: e.target.checked })}
              />
              静音（保留音量）
            </label>
            {num(
              '淡入 / 帧',
              settings.fadeIn,
              (v) => setSettings({ ...settings, fadeIn: v }),
              0,
              54000,
            )}
            {num(
              '淡出 / 帧',
              settings.fadeOut,
              (v) => setSettings({ ...settings, fadeOut: v }),
              0,
              54000,
            )}
          </fieldset>
        )}
        {kind === 'subtitle-replace' && (
          <Notice>
            整轨替换所有原字幕，不合并。任何条目失败则保留整个旧轨；候选会列出逐条量化结果。
          </Notice>
        )}
        <Button variant="primary" type="submit">
          {own ? '更新完整候选' : '生成完整候选预览'}
        </Button>
      </fieldset>
      {range && (
        <Button type="button" onClick={() => onPreview(range.startFrame, range.endFrame)}>
          区间预览（完整合成）
        </Button>
      )}
      {overlay && (
        <div className={styles.tools}>
          <Button
            type="button"
            disabled={blocked || !canEdit}
            onClick={() => void propose({ kind: 'layer', position: 'front' })}
          >
            置顶
          </Button>
          <Button
            type="button"
            disabled={blocked || !canEdit}
            onClick={() => void propose({ kind: 'layer', position: 'back' })}
          >
            置底
          </Button>
          {time('复制到起帧', copyStart, setCopyStart)}
          <Button
            type="button"
            disabled={blocked || !canEdit || !copyStart}
            onClick={() => void propose({ kind: 'copy-overlay', startTime: copyStart })}
          >
            复制为新元素
          </Button>
        </div>
      )}
      {(subtitle || overlay || audio) && (
        <Button
          type="button"
          disabled={blocked}
          onClick={() => void propose({ kind: 'delete-element' })}
        >
          删除当前元素…
        </Button>
      )}
      {kind === 'subtitle-style' && (
        <Button
          type="button"
          disabled={blocked || !p.subtitles.length}
          onClick={() => void propose({ kind: 'delete-element', id: 'subtitles' })}
        >
          删除全轨字幕…
        </Button>
      )}
      {pending && !own && <Notice>请先在对话中确认或取消当前候选。</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </form>
  );
}
