import { eq } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'

/**
 * Notification Settings (Settings → Notifications) — the single source of truth
 * for which schedulers run and where owner emails go.
 */
export interface NotificationPrefs {
  dailySummaryEnabled: boolean
  weeklyReportEnabled: boolean
  monthlyStatementsEnabled: boolean
  dueRemindersEnabled: boolean
  /** Owner recipient typed into Notification Settings (may be empty). */
  recipientEmail: string
}

const DEFAULT_FLAGS = {
  dailySummaryEnabled: true,
  weeklyReportEnabled: true,
  monthlyStatementsEnabled: true,
  dueRemindersEnabled: true,
} as const

/**
 * Pure derivation of prefs from the stored `notificationSettings` JSONB.
 * Missing keys default to enabled (matches the UI defaults). When the UI
 * recipient is empty, `envEmail` (NOTIFICATION_EMAIL) acts as its fallback.
 */
export function parseNotificationPrefs(ns: unknown, envEmail = ''): NotificationPrefs {
  const rec = (ns && typeof ns === 'object' ? ns : {}) as Record<string, unknown>
  const flag = (k: keyof typeof DEFAULT_FLAGS) => (typeof rec[k] === 'boolean' ? rec[k] : DEFAULT_FLAGS[k])
  const uiRecipient = typeof rec.recipientEmail === 'string' ? rec.recipientEmail.trim() : ''
  return {
    dailySummaryEnabled: flag('dailySummaryEnabled'),
    weeklyReportEnabled: flag('weeklyReportEnabled'),
    monthlyStatementsEnabled: flag('monthlyStatementsEnabled'),
    dueRemindersEnabled: flag('dueRemindersEnabled'),
    recipientEmail: uiRecipient || envEmail.trim(),
  }
}

/** Load prefs from the DB; falls back to env/defaults when unavailable. */
export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  const envEmail = String(process.env.NOTIFICATION_EMAIL ?? '').trim()
  if (!db) return parseNotificationPrefs(null, envEmail)
  try {
    const [row] = await db
      .select({ ns: schema.settings.notificationSettings })
      .from(schema.settings)
      .where(eq(schema.settings.id, 'app'))
      .limit(1)
    return parseNotificationPrefs(row?.ns ?? null, envEmail)
  } catch (err) {
    logger.error({ err }, 'Notification prefs load failed — using defaults')
    return parseNotificationPrefs(null, envEmail)
  }
}

/**
 * Owner mailbox resolution, in priority order:
 *   1. address typed in Notification Settings (recipientEmail)
 *   2. NOTIFICATION_EMAIL env var
 *   3. business email from Settings
 */
export function resolveOwnerRecipient(prefs: NotificationPrefs, businessEmail?: string | null): string {
  return (
    prefs.recipientEmail ||
    String(process.env.NOTIFICATION_EMAIL ?? '').trim() ||
    String(businessEmail ?? '').trim()
  )
}
