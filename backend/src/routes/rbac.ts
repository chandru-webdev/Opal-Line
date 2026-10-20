import { randomUUID } from 'node:crypto'
import { Router, type Response } from 'express'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { MODULES, MODULE_KEYS, computeUserPermissions, defaultRolePermissions, emptyPermissions } from '../rbac'
import { requirePermission, requireSuperAdmin } from '../rbac'
import { actorFromRequest, recordActivity } from '../activity'
import { recountCustomerStatsBoth } from '../customerStats'
import type { Permissions } from '../types'
import { routeParam } from '../lib/routeParams'

export const rbacRouter = Router()

function requireDb(res: Response) {
  if (!db) {
    res.status(503).json({ error: 'Service temporarily unavailable' })
    return false
  }
  return true
}

function sanitizePermissions(value: unknown): Permissions {
  const out = emptyPermissions()
  if (value && typeof value === 'object') {
    for (const key of MODULE_KEYS) {
      const cell = (value as Record<string, unknown>)[key]
      if (cell && typeof cell === 'object') {
        const c = cell as Record<string, unknown>
        out[key] = {
          view: Boolean(c.view),
          create: Boolean(c.create),
          edit: Boolean(c.edit),
          delete: Boolean(c.delete),
        }
      }
    }
  }
  return out
}

rbacRouter.get('/modules', (_req, res) => {
  res.json(MODULES)
})

// One-time repair: recount customers.orders / total_spent from real order and
// invoice data. System-editors only — this rewrites derived stats in bulk.
rbacRouter.post('/customers/recount-stats', requirePermission('system', 'edit'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const result = await recountCustomerStatsBoth()
    const actor = actorFromRequest(_req)
    void recordActivity({
      action: 'Recounted Customer Stats',
      module: 'system',
      entity: 'Customers',
      details: `Recounted stats for ${result.orders} local and ${result.invoices} invoice-matched customer(s)`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Recount failed' })
  }
})

rbacRouter.get('/roles', requirePermission('system', 'view'), async (_req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(schema.roles).orderBy(schema.roles.name)
    res.json(rows)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

rbacRouter.post('/roles', requireSuperAdmin, async (req, res) => {
  if (!requireDb(res)) return
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!name) return res.status(400).json({ error: 'Role name is required' })
    const description = String(req.body?.description ?? '').trim() || null
    const permissions = sanitizePermissions(req.body?.permissions)
    const [row] = await db!
      .insert(schema.roles)
      .values({ id: randomUUID(), name, description, permissions, isSystem: false, createdAt: new Date().toISOString() })
      .returning()
    const actor = actorFromRequest(req)
    void recordActivity({ action: 'Created Role', module: 'system', entity: `Role ${name}`, userId: actor.userId, ip: actor.ip })
    res.status(201).json(row)
  } catch {
    res.status(400).json({ error: 'Failed to create role' })
  }
})

rbacRouter.patch('/roles/:id', requireSuperAdmin, async (req, res) => {
  if (!requireDb(res)) return
  try {
    const [existing] = await db!.select().from(schema.roles).where(eq(schema.roles.id, routeParam(req.params.id))).limit(1)
    if (!existing) return res.status(404).json({ error: 'Role not found' })

    const body: Record<string, unknown> = {}
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim()
      if (!name) return res.status(400).json({ error: 'Role name is required' })
      body.name = name
    }
    if (req.body?.description !== undefined) {
      body.description = String(req.body.description).trim() || null
    }
    if (req.body?.permissions !== undefined) {
      body.permissions = sanitizePermissions(req.body.permissions)
    }

    const [row] = await db!.update(schema.roles).set(body).where(eq(schema.roles.id, routeParam(req.params.id))).returning()
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated Role',
      module: 'system',
      entity: `Role ${existing.name}`,
      details: Object.keys(body).join(', '),
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json(row)
  } catch {
    res.status(400).json({ error: 'Failed to update role' })
  }
})

rbacRouter.delete('/roles/:id', requirePermission('system', 'delete'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const result = await db!.transaction(async (tx) => {
      const [existing] = await tx.select().from(schema.roles).where(eq(schema.roles.id, routeParam(req.params.id))).limit(1).for('update')
      if (!existing) return { status: 404, error: 'Role not found' }
      if (existing.isSystem) return { status: 400, error: 'System roles cannot be deleted' }

      const inUse = await tx.select({ n: schema.users.id }).from(schema.users).where(eq(schema.users.role, existing.name)).limit(1)
      if (inUse.length > 0) return { status: 400, error: `Role "${existing.name}" is assigned to users and cannot be deleted` }

      await tx.delete(schema.roles).where(eq(schema.roles.id, routeParam(req.params.id)))
      return { status: 0, name: existing.name }
    })
    if (result.status) return res.status(result.status).json({ error: result.error })
    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Deleted Role',
      module: 'system',
      entity: `Role ${result.name}`,
      userId: actor.userId,
      ip: actor.ip,
    })
    res.json({ ok: true, id: routeParam(req.params.id) })
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

rbacRouter.get('/users/:id/permissions', async (req, res) => {
  if (!requireDb(res)) return
  try {
    const isSelf = req.userId === routeParam(req.params.id)
    if (!isSelf) {
      const systemView = await computeUserPermissions(req.userId ?? '')
      if (!systemView?.effective?.system?.view) {
        return res.status(403).json({ error: 'Permission denied' })
      }
    }
    const perms = await computeUserPermissions(routeParam(req.params.id))
    if (!perms) return res.status(404).json({ error: 'User not found' })
    res.json(perms)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

rbacRouter.put('/users/:id/permissions', requireSuperAdmin, async (req, res) => {
  if (!requireDb(res)) return
  try {
    if (req.userId === routeParam(req.params.id)) {
      return res.status(403).json({ error: 'Cannot modify your own permissions' })
    }
    const [user] = await db!.select().from(schema.users).where(eq(schema.users.id, routeParam(req.params.id))).limit(1)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const raw = req.body?.permissions
    const permissions: Permissions | null = raw === null || raw === undefined ? null : sanitizePermissions(raw)
    await db!.update(schema.users).set({ permissions }).where(eq(schema.users.id, routeParam(req.params.id)))

    const actor = actorFromRequest(req)
    void recordActivity({
      action: 'Updated User Permissions',
      module: 'system',
      entity: `User ${user.name}`,
      details: permissions === null ? 'Permissions reset to role defaults' : 'Custom permissions applied',
      userId: actor.userId,
      ip: actor.ip,
    })

    const perms = await computeUserPermissions(routeParam(req.params.id))
    res.json(perms)
  } catch {
    res.status(400).json({ error: 'Failed to update permissions' })
  }
})

rbacRouter.get('/roles/defaults', (_req, res) => {
  const names = ['Super Admin', 'Admin', 'Manager', 'Accounts', 'Purchase', 'Sales', 'Shopify Manager', 'Customer Support']
  res.json(
    names.map((name) => ({
      name,
      permissions: defaultRolePermissions(name),
      isSystem: true,
    })),
  )
})

rbacRouter.get('/roles/:name', requirePermission('system', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const rows = await db!.select().from(schema.roles).where(eq(schema.roles.name, routeParam(req.params.name))).limit(1)
    if (!rows[0]) return res.status(404).json({ error: 'Role not found' })
    res.json(rows[0])
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})

rbacRouter.get('/permissions/:userId', requirePermission('system', 'view'), async (req, res) => {
  if (!requireDb(res)) return
  try {
    const perms = await computeUserPermissions(routeParam(req.params.userId))
    if (!perms) return res.status(404).json({ error: 'User not found' })
    res.json(perms.effective)
  } catch {
    res.status(500).json({ error: 'Internal server error' })
  }
})
