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
    databaseHooks:{session:{create:{before:async session=>{
      if (seed) return;
      const {rows:[operator]}=await database.query('SELECT enabled FROM operator_role WHERE user_id=$1',[session.userId]);
      if (!operator?.enabled) return false;
    }}}},
    trustedOrigins: [new URL(baseURL).origin]
  });
  return { auth, database };
}

export async function getViewer(request: Request, auth: ReturnType<typeof createAuth>['auth'], db: DataSource): Promise<Viewer> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) throw new UnauthorizedException();
  const [operator] = await db.query('SELECT role,capabilities,specialties,available,enabled FROM operator_role WHERE user_id=$1', [session.user.id]);
  const role = Role.safeParse(operator?.role);
  if (!role.success || !operator.enabled) throw new UnauthorizedException();
  return { id: session.user.id, name: session.user.name, role: role.data, capabilities:operator.capabilities, specialties:operator.specialties, available:operator.available };
}

export function canReadMockBilling(viewer: Viewer) {
  return process.env.DEMO_MODE === 'true' &&
    !!viewer.capabilities?.some(capability => capability === 'admin' || capability === 'superadmin');
}

export function canManageAdministration(viewer: Pick<Viewer,'capabilities'>) {
  return (viewer.capabilities ?? []).includes(process.env.DEMO_MODE==='true' ? 'admin' : 'superadmin');
}

export const AUTH = Symbol('BETTER_AUTH');
