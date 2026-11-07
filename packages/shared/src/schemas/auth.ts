import { z } from 'zod';

export const PhoneSchema = z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的 11 位大陆手机号');
export const RequestCodeSchema = z.object({ phone: PhoneSchema });
export const LoginSchema = z.object({
  phone: PhoneSchema,
  code: z.string().regex(/^\d{6}$/, '请输入 6 位验证码'),
});
export const UserSchema = z.object({ id: z.uuid(), phone: PhoneSchema });
export const CodeResultSchema = z.object({
  resendAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  testCode: z.literal('123456'),
});
export const SessionSchema = z.object({ user: UserSchema, expiresAt: z.iso.datetime() });
export const LoginResultSchema = SessionSchema.extend({ token: z.string().min(32) });
export const SessionEndCodeSchema = z.enum([
  'SESSION_REPLACED',
  'SESSION_EXPIRED',
  'SESSION_LOGGED_OUT',
  'SESSION_INVALID',
]);
export const SessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('session-ended'), code: SessionEndCodeSchema, message: z.string() }),
]);
export type User = z.infer<typeof UserSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type SessionEndCode = z.infer<typeof SessionEndCodeSchema>;
