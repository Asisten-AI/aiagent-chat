import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { env } from './env';

export const COOKIE = 'ruang_session';

export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: '30d' });
}

export function verifySession(token?: string): string | null {
  if (!token) return null;
  try {
    return (jwt.verify(token, env.JWT_SECRET) as { sub: string }).sub;
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function userIdOf(req: FastifyRequest): string {
  const id = verifySession(req.cookies[COOKIE]);
  if (!id) throw new HttpError(401, 'Silakan masuk dulu');
  return id;
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.isProd,
  path: '/',
  maxAge: 60 * 60 * 24 * 30,
};
