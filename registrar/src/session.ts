import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { Clock } from './clock.js';

/**
 * Admin console session layer.
 *
 * - Opaque random session id, HMAC-signed value in cookie `vsigma_admin`
 *   (HttpOnly; Secure; SameSite=Strict; Path=/admin).
 * - In-memory session store (single-process registrar; spec accepts this).
 * - 12h TTL enforced through the injectable clock.
 * - CSRF: per-session random token; every authenticated mutation must
 *   present it. Login (no session yet) uses a double-submit cookie.
 */

export const SESSION_COOKIE = 'vsigma_admin';
export const CSRF_COOKIE = 'vsigma_csrf';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AdminSession {
  sid: string;
  createdAt: number;
  expiresAt: number;
  csrfToken: string;
  /** admin_keys.label of the logged-in admin, for display only. */
  label: string;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class SessionManager {
  private sessions = new Map<string, AdminSession>();

  constructor(
    private secret: string,
    private clock: Clock,
  ) {}

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  /** Create a session and set the signed cookie on the reply. */
  create(reply: FastifyReply, label: string): AdminSession {
    const sid = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const session: AdminSession = {
      sid,
      createdAt: this.nowMs(),
      expiresAt: this.nowMs() + SESSION_TTL_MS,
      csrfToken,
      label,
    };
    this.sessions.set(sid, session);
    this.setCookie(reply, this.sign(sid), label);
    return session;
  }

  /** Resolve a request cookie into a live (unexpired) session, or null. */
  resolve(cookieValue: string | undefined): AdminSession | null {
    if (!cookieValue) return null;
    const sid = this.unsign(cookieValue);
    if (sid === null) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (this.nowMs() >= session.expiresAt) {
      this.sessions.delete(sid);
      return null;
    }
    return session;
  }

  /** Verify a CSRF token against the session in timing-safe compare. */
  verifyCsrf(session: AdminSession, presented: string | undefined): boolean {
    if (!presented) return false;
    return timingSafeEqualStrings(session.csrfToken, presented);
  }

  /** Double-submit cookie check for the login form (pre-session). */
  verifyLoginCsrf(cookieToken: string | undefined, presented: string | undefined): boolean {
    if (!cookieToken || !presented) return false;
    return timingSafeEqualStrings(cookieToken, presented);
  }

  destroy(reply: FastifyReply, sid?: string): void {
    if (sid !== undefined) this.sessions.delete(sid);
    this.setCookie(reply, '', '', { maxAge: 0 });
  }

  private setCookie(
    reply: FastifyReply,
    value: string,
    _label: string,
    opts?: { maxAge?: number },
  ): void {
    reply.header('set-cookie', this.buildCookie(value, opts));
  }

  private buildCookie(value: string, opts?: { maxAge?: number }): string {
    const parts = [
      `${SESSION_COOKIE}=${value}`,
      'Path=/admin',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
    ];
    if (opts?.maxAge === 0) parts.push('Max-Age=0');
    return parts.join('; ');
  }

  private sign(sid: string): string {
    const mac = createHmac('sha256', this.secret).update(sid).digest('base64url');
    return `${sid}.${mac}`;
  }

  private unsign(value: string): string | null {
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const sid = value.slice(0, dot);
    const mac = value.slice(dot + 1);
    const expected = createHmac('sha256', this.secret).update(sid).digest('base64url');
    if (!timingSafeEqualStrings(mac, expected)) return null;
    return sid;
  }
}