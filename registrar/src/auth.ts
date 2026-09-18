import type { FastifyRequest } from 'fastify';

/**
 * Extract the Bearer token from the Authorization header.
 * Returns null when the header is absent or not a Bearer scheme —
 * callers treat that as a missing-key denial.
 */
export function extractBearer(request: FastifyRequest): string | null {
  const header: string | undefined = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const key = match[1].trim();
  return key.length > 0 ? key : null;
}