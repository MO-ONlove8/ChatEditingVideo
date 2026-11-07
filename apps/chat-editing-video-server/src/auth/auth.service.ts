import { createHash, randomBytes } from 'node:crypto';
import { HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { SessionEndCode, User } from '@cev/shared';
import { DB, type Database } from '../database/database.module.js';
import { loginCodes, sessions, users } from '../database/schema.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { REDIS, ensureConnected } from '../redis/redis.module.js';

export interface AuthSession {
  id: string;
  token: string;
  user: User;
  expiresAt: string;
}

export const sessionMessages: Record<SessionEndCode, string> = {
  SESSION_REPLACED: '账号已在其他位置登录',
  SESSION_EXPIRED: '登录已过期，请重新登录',
  SESSION_LOGGED_OUT: '已退出登录',
  SESSION_INVALID: '请先登录',
};

function authError(code: SessionEndCode): never {
  throw new UnauthorizedException({ statusCode: 401, code, message: sessionMessages[code] });
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async requestCode(phone: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`login:${phone}`}))`);
      const [previous] = await tx.select().from(loginCodes).where(eq(loginCodes.phone, phone));
      const now = Date.now();
      if (previous && previous.resendAt.getTime() > now) {
        throw new HttpException(
          {
            statusCode: 429,
            code: 'CODE_COOLDOWN',
            message: '请稍后再获取验证码',
            resendAt: previous.resendAt.toISOString(),
          },
          429,
        );
      }
      const expiresAt = new Date(now + this.env.AUTH_CODE_TTL_SECONDS * 1000);
      const resendAt = new Date(now + this.env.AUTH_CODE_RESEND_SECONDS * 1000);
      await tx
        .insert(loginCodes)
        .values({ phone, expiresAt, resendAt, consumed: false })
        .onConflictDoUpdate({
          target: loginCodes.phone,
          set: { expiresAt, resendAt, consumed: false },
        });
      return {
        expiresAt: expiresAt.toISOString(),
        resendAt: resendAt.toISOString(),
        testCode: '123456' as const,
      };
    });
  }

  async login(phone: string, code: string) {
    const token = randomBytes(32).toString('base64url');
    const result = await this.db.transaction(async (tx) => {
      // Serialize code consumption and logins, including first-account creation.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`login:${phone}`}))`);
      const [challenge] = await tx.select().from(loginCodes).where(eq(loginCodes.phone, phone));
      if (
        code !== '123456' ||
        !challenge ||
        challenge.consumed ||
        challenge.expiresAt.getTime() <= Date.now()
      ) {
        throw new HttpException(
          { statusCode: 400, code: 'CODE_INVALID', message: '验证码错误或已失效，请重新获取' },
          400,
        );
      }
      await tx.insert(users).values({ phone }).onConflictDoNothing();
      const [user] = await tx.select().from(users).where(eq(users.phone, phone)).for('update');
      const old = await tx
        .update(sessions)
        .set({ revokedReason: 'SESSION_REPLACED' })
        .where(and(eq(sessions.userId, user!.id), isNull(sessions.revokedReason)))
        .returning({ id: sessions.id });
      const expiresAt = new Date(Date.now() + this.env.AUTH_SESSION_TTL_SECONDS * 1000);
      const [session] = await tx
        .insert(sessions)
        .values({
          userId: user!.id,
          tokenHash: this.hash(token),
          expiresAt,
        })
        .returning();
      await tx.update(loginCodes).set({ consumed: true }).where(eq(loginCodes.phone, phone));
      return { old, session: session!, user: { id: user!.id, phone: user!.phone } };
    });
    // Notification failure must never roll back a successful login; DB remains authoritative.
    for (const old of result.old) void this.notify(old.id, 'SESSION_REPLACED');
    return { token, user: result.user, expiresAt: result.session.expiresAt.toISOString() };
  }

  async authenticate(token: string): Promise<AuthSession> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) authError('SESSION_INVALID');
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, this.hash(token)));
    if (!row) authError('SESSION_INVALID');
    if (row.session.revokedReason) authError(row.session.revokedReason as SessionEndCode);
    if (row.session.expiresAt.getTime() <= Date.now()) authError('SESSION_EXPIRED');
    return {
      id: row.session.id,
      token,
      user: { id: row.user.id, phone: row.user.phone },
      expiresAt: row.session.expiresAt.toISOString(),
    };
  }

  async logout(session: AuthSession) {
    await this.db
      .update(sessions)
      .set({ revokedReason: 'SESSION_LOGGED_OUT' })
      .where(and(eq(sessions.id, session.id), isNull(sessions.revokedReason)));
    void this.notify(session.id, 'SESSION_LOGGED_OUT');
  }
  async authenticateId(id: string): Promise<AuthSession> {
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, id));
    if (!row) authError('SESSION_INVALID');
    if (row.session.revokedReason) authError(row.session.revokedReason as SessionEndCode);
    if (row.session.expiresAt.getTime() <= Date.now()) authError('SESSION_EXPIRED');
    return {
      id: row.session.id,
      token: '',
      user: { id: row.user.id, phone: row.user.phone },
      expiresAt: row.session.expiresAt.toISOString(),
    };
  }

  /** Watches long-lived HTTP streams too, so a revoked token cannot keep receiving data. */
  watch(session: AuthSession, ended: (code: SessionEndCode) => void): () => void {
    let closed = false;
    let checking = false;
    const sub = this.redis.duplicate({ lazyConnect: true });
    sub.on('error', () => {
      /* Database validation below is the fallback. */
    });
    const finish = (code: SessionEndCode) => {
      if (!closed) {
        cleanup();
        ended(code);
      }
    };
    const check = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        if (session.token) await this.authenticate(session.token);
        else await this.authenticateId(session.id);
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          finish((error.getResponse() as { code: SessionEndCode }).code);
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 15_000);
    timer.unref();
    const cleanup = () => {
      closed = true;
      clearInterval(timer);
      sub.disconnect();
    };
    sub.on('message', (_channel, message) => {
      if (Object.hasOwn(sessionMessages, message)) finish(message as SessionEndCode);
    });
    void sub
      .connect()
      .then(async () => {
        if (!closed) {
          await sub.subscribe(`cev:session:${session.id}`);
          await check(); // Close the authenticate/subscribe race.
        }
      })
      .catch(() => {
        sub.disconnect();
      });
    void check();
    return cleanup;
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  private async notify(sessionId: string, code: SessionEndCode) {
    try {
      await ensureConnected(this.redis);
      await this.redis.publish(`cev:session:${sessionId}`, code);
    } catch {
      /* Persisted revocation and 15-second checks guarantee invalidation. */
    }
  }
}
