// Importing rbac.ts transitively imports db/client.ts, which opens a PostgreSQL
// LISTEN connection at import time. That handle keeps this file's test process
// alive after the tests finish, so the backend test script runs with
// --test-force-exit. Do not call client.end() here instead: tearing the listen
// channel down raises an unhandled CONNECTION_DESTROYED rejection that the
// runner reports as a failed file even when every test passed.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MODULE_KEYS, defaultRolePermissions, emptyPermissions, mergePermissions } from './rbac'

describe('defaultRolePermissions', () => {
  test('no role except Super Admin ships with any module access', () => {
    // Module access is superadmin-controlled: every non-Super-Admin role —
    // Admin included — must default to zero modules, so a new user only ever
    // sees what a super admin has explicitly turned on for them.
    for (const name of ['Admin', 'Manager', 'Accounts', 'Purchase', 'Sales', 'Shopify Manager', 'Customer Support']) {
      assert.deepEqual(defaultRolePermissions(name), emptyPermissions(), name)
    }
  })

  test('the bootstrap owner (Super Admin) has full access everywhere', () => {
    // The install owner is created with this role and is the account that
    // turns modules on for everyone else, so it must keep full access.
    const perms = defaultRolePermissions('Super Admin')
    for (const key of MODULE_KEYS) {
      assert.equal(perms[key].view, true, `${key}.view`)
      assert.equal(perms[key].create, true, `${key}.create`)
      assert.equal(perms[key].edit, true, `${key}.edit`)
      assert.equal(perms[key].delete, true, `${key}.delete`)
    }
  })

  test('an unknown role gets no permissions rather than a crash', () => {
    const perms = defaultRolePermissions('Does Not Exist')
    assert.deepEqual(perms, emptyPermissions())
  })
})

describe('mergePermissions', () => {
  test('a null override inherits the role defaults', () => {
    const role = defaultRolePermissions('Manager')
    const merged = mergePermissions(role, null)
    assert.deepEqual(merged, role)
  })

  test('an override only replaces the actions it names', () => {
    const role = defaultRolePermissions('Manager')
    const merged = mergePermissions(role, { system: { view: true, create: false, edit: false, delete: false } })
    // Manager has no system access by default, so the override grants exactly view.
    assert.equal(merged.system.view, true)
    assert.equal(merged.system.create, false)
    assert.equal(merged.system.edit, false)
    assert.equal(merged.system.delete, false)
    // Untouched modules keep the role's permissions.
    assert.deepEqual(merged.sales, role.sales)
  })

  test('a role default is never widened by an explicit false override', () => {
    // Use a full-access role so the false override is actually narrowing it —
    // every other role is empty by default and would make this vacuous.
    const role = defaultRolePermissions('Super Admin')
    const merged = mergePermissions(role, { system: { view: true, create: true, edit: true, delete: false } })
    assert.equal(merged.system.delete, false)
    assert.equal(role.system.delete, true)
  })
})
