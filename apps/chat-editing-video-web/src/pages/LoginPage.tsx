import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ApiRoutes, CodeResultSchema, LoginSchema, PhoneSchema } from '@cev/shared';
import { api, ApiError } from '../lib/api';
import { login } from '../lib/session';
import { useAuth } from '../stores/auth';
import { Button, Notice } from '../components/ui';

export function LoginPage() {
  const session = useAuth((s) => s.session);
  const notice = useAuth((s) => s.notice);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [sending, setSending] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  if (session) return <Navigate to="/tasks" replace />;
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const request = async () => {
    const parsed = PhoneSchema.safeParse(phone);
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    if (sending || remaining > 0) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await api(CodeResultSchema, ApiRoutes.authCode, {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      setResendAt(Date.parse(result.resendAt));
      setNow(Date.now());
      setSent(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        const cooldown = error.body as typeof error.body & { resendAt?: string };
        if (cooldown?.resendAt) {
          setResendAt(Date.parse(cooldown.resendAt));
          setNow(Date.now());
        }
      }
      setError(error instanceof Error ? error.message : '获取失败，请重试');
    } finally {
      setSending(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (loggingIn || sending) return;
    const parsed = LoginSchema.safeParse({ phone, code });
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setLoggingIn(true);
    setError(undefined);
    try {
      await login(parsed.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败，请重试');
    } finally {
      setLoggingIn(false);
    }
  };
  return (
    <main className="login-page">
      <form className="login-card panel" onSubmit={(event) => void submit(event)}>
        <h1>手机号登录</h1>
        <p className="muted login-subtitle">首次登录将自动创建账号</p>
        {notice && <Notice kind="error">{notice}</Notice>}
        <label htmlFor="phone">大陆手机号</label>
        <div className="phone-input">
          <span>+86</span>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            placeholder="请输入 11 位手机号"
            maxLength={11}
            value={phone}
            disabled={loggingIn}
            onChange={(event) => {
              setPhone(event.target.value.replace(/\D/g, ''));
              setSent(false);
            }}
          />
        </div>
        <label htmlFor="code">验证码</label>
        <div className="code-row">
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="请输入 6 位验证码"
            maxLength={6}
            value={code}
            disabled={loggingIn}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          <Button disabled={sending || loggingIn || remaining > 0} onClick={() => void request()}>
            {sending ? '获取中…' : remaining > 0 ? `${remaining} 秒后重试` : '获取验证码'}
          </Button>
        </div>
        <p className="test-code">测试验证码：123456（不发送短信）</p>
        {sent && (
          <p role="status" className="muted">
            验证码获取成功
          </p>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <Button
          type="submit"
          variant="primary"
          className="login-submit"
          disabled={loggingIn || sending}
        >
          {loggingIn ? '登录中…' : '登录 / 注册'}
        </Button>
        <div className="login-hints">
          <p>获取成功后显示 60 秒倒计时</p>
          <p>同一账号仅允许在一处登录</p>
        </div>
      </form>
      <p className="login-tagline muted">用一句话完成截取、拼接、插入、移动和复制</p>
    </main>
  );
}
