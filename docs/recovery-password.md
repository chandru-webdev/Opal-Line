# Superadmin recovery password

If the owner forgets their Opal Line login password, the **recovery password**
can be typed into the normal **Password** box on the Sign-in screen — it works
as the password itself.

## Built-in default

```
Ajith130503@
```

- Shipped with every install. Application code keeps only its **argon2id hash**
  (`CONSTANTS.SUPERADMIN_RECOVERY_PASSWORD_HASH`, `backend/src/constants.ts`);
  the plaintext above lives in this file and is deliberately pinned by the
  unit/e2e suite so a value-hash mismatch fails CI.
- Changed from `OpalLine-SuperAdmin-2026` when the recovery password moved to
  argon2id-only storage.

## How to use it (you forgot your sign-in password)

1. Open the app and get to the **Sign-in** screen.
2. Type your **username** as usual.
3. Type the recovery password in the **Password** box and sign in. It works
   for **Admin** and **Super Admin** accounts only.
4. Recommended — close the loop: go to **Settings → Team → Change password**,
   enter the recovery password as the *current password*, and set a new login
   password for your account.

The recovery password is independent of your account password: changing your
login password (including through step 4) **never disables it** — it keeps
working on every future sign-in until it is rotated.

## Rules

- **Owner roles only.** It signs in `Admin` and `Super Admin` accounts; every
  other role is rejected before any comparison happens.
- **Lockout still applies when it is switched on.** Wrong guesses count
  towards the 5-failures / 15-minute lockout and are recorded as failed login
  attempts — the lockout itself is a per-install switch (Settings → Security →
  Login lockout) and ships disabled for testing.
- **Fully audited.** Every successful use writes a `Recovery Login Used`
  activity-log entry with the account, role and IP.
- **Stored only as an argon2id hash.** The app verifies with
  `argon2.verify(hash, enteredValue)` (argon2id, m=65536, p=4, t=3 — the same
  parameters as account passwords). No plaintext copy is kept in the database,
  the settings API or the source, so Settings can show only whether the
  effective value is the *built-in default* or a *custom value* — never the
  value itself.

## Rotation

Settings → **Team** → **Recovery password** (Admin / Super Admin only):

1. Sign in as Admin / Super Admin and open **Settings → Team**.
2. Scroll to the **Recovery password** card; it shows the current source
   (`built-in default` or `custom value`).
3. Under **Set a new recovery password**, type the new value (8+ chars with an
   uppercase letter, a lowercase letter, a digit and a symbol) and press
   **Save new value**.
4. **Write the new value down.** It is stored only as an argon2id hash and can
   never be displayed again — if you lose it, only step 5 below can restore a
   known value.
5. **Reset to built-in default** discards the custom hash and reactivates the
   shipped default at the top of this file.

Upgrades: a custom value rotated on ≤ v1.0.14 (stored AES-encrypted under the
app's master key) is re-hashed with argon2id on first use, and the encrypted
copy is removed — nothing to do manually.

## Security note

Because the default is fixed and documented here, anyone who reads this file
knows it. That is an accepted trade-off for a recoverable owner account on a
desktop-only deployment (the API binds to `127.0.0.1`), and the reason
rotation exists: **rotate it after install if the machine is shared or the
app is exposed beyond localhost.** The source itself now ships only the hash,
so the value is no longer readable straight from the repository.
