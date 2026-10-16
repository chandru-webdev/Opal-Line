import PDFDocument from 'pdfkit'
import { and, gte, sql } from 'drizzle-orm'
import { db } from './db/client'
import * as schema from './db/schema'
import { logger } from './logger'
import { sendEmail } from './notifications'
import { loadNotificationPrefs, resolveOwnerRecipient } from './notificationPrefs'
import { createScheduler } from './lib/scheduler'

/**
 * Weekly Owner Insights: every Monday 08:00, email the owner a KPI summary
 * (7-day revenue, orders, gross profit) with a trend PDF of the last 8 weeks.
 */
const HOUR = 8
const MINUTE = 0

function msUntilNextRun(now = new Date()): number {
  const next = new Date(now)
  // Monday = 1
  const daysUntilMonday = (8 - next.getDay()) % 7 || 7
  next.setDate(next.getDate() + daysUntilMonday - (next.getDay() === 1 && now.getHours() < HOUR ? 7 : 0))
  next.setHours(HOUR, MINUTE, 0, 0)
  // simplest correct approach: compute upcoming Monday 08:00 strictly after now
  const candidate = new Date(now)
  candidate.setDate(candidate.getDate() + ((8 - candidate.getDay()) % 7 || 7))
  candidate.setHours(HOUR, MINUTE, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7)
  void next
  return candidate.getTime() - now.getTime()
}

interface WeekPoint {
  label: string
  revenue: number
  profit: number
  orders: number
}

async function collectWeeklyTrend(): Promise<WeekPoint[]> {
  if (!db) return []
  const weeks: WeekPoint[] = []
  for (let i = 7; i >= 0; i--) {
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    end.setDate(end.getDate() - i * 7)
    const start = new Date(end)
    start.setDate(start.getDate() - 6)
    start.setHours(0, 0, 0, 0)
    void start
    const startIso = new Date(end.getTime() - 6 * 86_400_000)
    startIso.setHours(0, 0, 0, 0)
    const [rev] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.salesInvoices.grandTotal}), 0)::float` })
      .from(schema.salesInvoices)
      .where(and(gte(schema.salesInvoices.date, startIso.toISOString()), sql`${schema.salesInvoices.date} <= ${end.toISOString()}`, sql`${schema.salesInvoices.status} is distinct from 'cancelled'`))
    const [profit] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.salesInvoices.grandTotal} - ${schema.salesInvoices.silverValue} - ${schema.salesInvoices.makingCharge}), 0)::float` })
      .from(schema.salesInvoices)
      .where(and(gte(schema.salesInvoices.date, startIso.toISOString()), sql`${schema.salesInvoices.date} <= ${end.toISOString()}`, sql`${schema.salesInvoices.status} is distinct from 'cancelled'`))
    const [ord] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.salesOrders)
      .where(and(gte(schema.salesOrders.date, startIso.toISOString()), sql`${schema.salesOrders.date} <= ${end.toISOString()}`))
    weeks.push({
      label: `${startIso.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}–${end.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
      revenue: Number(rev?.total ?? 0),
      profit: Number(profit?.total ?? 0),
      orders: Number(ord?.n ?? 0),
    })
  }
  return weeks
}

export async function generateWeeklyReportPDF(weeks: WeekPoint[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

  const money = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })

  doc.fontSize(20).font('Helvetica-Bold').fillColor('#111827').text('Weekly Owner Insights')
  doc.moveDown(0.2)
  doc.fontSize(10).font('Helvetica').fillColor('#6b7280').text(
    'Last 8 weeks revenue & gross profit  ·  Generated ' + new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
  )
  doc.moveDown(1)

  // Simple bar chart: revenue bars with profit overlay line values
  const chartTop = doc.y + 10
  const chartHeight = 160
  const chartWidth = 495
  const maxRevenue = Math.max(1, ...weeks.map((w) => w.revenue))
  const barWidth = chartWidth / weeks.length - 8

  weeks.forEach((w, i) => {
    const x = 50 + i * (chartWidth / weeks.length) + 4
    const h = (w.revenue / maxRevenue) * chartHeight
    doc.roundedRect(x, chartTop + chartHeight - h, barWidth, Math.max(h, 1), 3).fill('#3b82f6')
    doc.font('Helvetica').fontSize(7).fillColor('#6b7280')
    doc.text(w.label, x - 4, chartTop + chartHeight + 6, { width: barWidth + 8, align: 'center' })
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#111827')
    doc.text(money(w.revenue), x - 4, chartTop + chartHeight - h - 10, { width: barWidth + 8, align: 'center' })
  })

  doc.y = chartTop + chartHeight + 30
  doc.moveDown(1)

  // Table
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280')
  doc.text('WEEK', 50, doc.y)
  doc.text('ORDERS', 250, doc.y)
  doc.text('REVENUE', 340, doc.y)
  doc.text('GROSS PROFIT', 450, doc.y)
  doc.moveTo(50, doc.y + 14).lineTo(545, doc.y + 14).lineWidth(0.75).strokeColor('#d1d5db').stroke()
  let y = doc.y + 22
  for (const w of weeks) {
    if (y > 770) {
      doc.addPage()
      y = 60
    }
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(w.label, 50, y)
    doc.text(String(w.orders), 250, y)
    doc.text(money(w.revenue), 340, y)
    doc.font('Helvetica-Bold').fillColor(w.profit >= 0 ? '#16a34a' : '#b91c1c').text(money(w.profit), 450, y)
    y += 18
  }

  doc.end()
  return done
}

export async function runWeeklyOwnerReport(): Promise<void> {
  try {
    const prefs = await loadNotificationPrefs()
    if (!prefs.weeklyReportEnabled) {
      logger.info('Weekly owner report skipped — disabled in notification settings')
      return
    }
    const [settingsRow] = await db!.select().from(schema.settings).where(sql`${schema.settings.id} = 'app'`).limit(1)
    const recipient = resolveOwnerRecipient(prefs, settingsRow?.email)
    if (!recipient) return
    const weeks = await collectWeeklyTrend()
    if (weeks.length === 0) return
    const last = weeks[weeks.length - 1]
    const prev = weeks[weeks.length - 2] ?? last
    const revenueDelta = prev.revenue > 0 ? ((last.revenue - prev.revenue) / prev.revenue) * 100 : 0
    const money = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    const trend = weeks.slice(-4).map((w) => `<tr><td style="padding:6px 12px;color:#666;">${w.label}</td><td style="padding:6px 12px;font-weight:bold;">${money(w.revenue)}</td><td style="padding:6px 12px;color:#16a34a;">${money(w.profit)}</td><td style="padding:6px 12px;">${w.orders}</td></tr>`).join('')
    const buffer = await generateWeeklyReportPDF(weeks)
    const ok = await sendEmail({
      to: recipient,
      subject: `📈 Weekly Owner Insights — ${money(last.revenue)} revenue (${revenueDelta >= 0 ? '+' : ''}${revenueDelta.toFixed(0)}% vs last week)`,
      attachments: [{ filename: `owner-weekly-${new Date().toISOString().slice(0, 10)}.pdf`, content: buffer }],
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color:#2563eb;">📈 Weekly Owner Insights</h2>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 8px 12px; color: #666;">This week's revenue</td><td style="padding: 8px 12px; font-weight: bold; font-size: 16px;">${money(last.revenue)}</td></tr>
            <tr><td style="padding: 8px 12px; color: #666;">Gross profit</td><td style="padding: 8px 12px; font-weight: bold; color: #16a34a;">${money(last.profit)}</td></tr>
            <tr><td style="padding: 8px 12px; color: #666;">Orders</td><td style="padding: 8px 12px; font-weight: bold;">${last.orders}</td></tr>
            <tr><td style="padding: 8px 12px; color: #666;">vs previous week</td><td style="padding: 8px 12px; font-weight: bold; color: ${revenueDelta >= 0 ? '#16a34a' : '#dc2626'};">${revenueDelta >= 0 ? '+' : ''}${revenueDelta.toFixed(0)}%</td></tr>
          </table>
          <h3 style="color:#374151;">Last 4 weeks</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr style="color:#999;"><th align="left" style="padding:6px 12px;">Week</th><th align="left" style="padding:6px 12px;">Revenue</th><th align="left" style="padding:6px 12px;">Profit</th><th align="left" style="padding:6px 12px;">Orders</th></tr>
            ${trend}
          </table>
          <p style="color:#666;">Full 8-week trend chart is attached as a PDF.</p>
          <p style="color: #999; font-size: 12px;">Opal Line ERP — Weekly Report</p>
        </div>
      `,
    })
    if (ok) logger.info({ recipient }, 'Weekly owner report sent')
  } catch (err) {
    logger.error({ err }, 'Weekly owner report failed')
  }
}

const scheduler = createScheduler({
  label: 'Weekly owner report',
  msUntilNextRun,
  run: () => runWeeklyOwnerReport(),
})

export function startWeeklyOwnerReport(): void {
  if (scheduler.armed) return
  scheduler.schedule()
  logger.info({ next: new Date(Date.now() + msUntilNextRun()).toISOString() }, 'Weekly owner report scheduler started (Monday 08:00)')
}

export function stopWeeklyOwnerReport(): void {
  scheduler.stop()
}
