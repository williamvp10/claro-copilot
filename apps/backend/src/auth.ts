import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { Pool } from 'pg';
import type { DataSource } from 'typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { Role, type Viewer } from '@claro/contracts';

export function createAuth(seed = false) {
  const database = new Pool({ connectionString: process.env.DATABASE_URL });
  const baseURL = process.env.BETTER_AUTH_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!baseURL || !secret || secret.length < 32) throw new Error('BETTER_AUTH_URL and a 32-character BETTER_AUTH_SECRET are required');
  const auth = betterAuth({
    database, baseURL, secret,
    emailAndPassword: { enabled: true, disableSignUp: !seed },
    trustedOrigins: [new URL(baseURL).origin]
  });
  return { auth, database };
}

export async function getViewer(request: Request, auth: ReturnType<typeof createAuth>['auth'], db: DataSource): Promise<Viewer> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw new UnauthorizedException();
  const [operator] = await db.query('SELECT role FROM operator_role WHERE user_id=$1', [session.user.id]);
  const role = Role.safeParse(operator?.role);
  if (!role.success) throw new UnauthorizedException();
  return { id: session.user.id, name: session.user.name, role: role.data };
}

export const AUTH = Symbol('BETTER_AUTH');
