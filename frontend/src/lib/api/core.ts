// Core HTTP plumbing for the API modules: base URL, CSRF handling, request
// wrapper with 403-retry, list pagination and small helpers.
import type {
  Customer,
  Invoice,
  InvoiceItem,
  Payment,
  Product,
  PurchaseInvoice,
  SalesOrder,
  Supplier,
} from '@/types'

// `?.` keeps this module importable outside Vite (node --test, SSR) where
// import.meta.env does not exist; Vite still statically injects the env object.
export const API_BASE = (import.meta.env?.VITE_API_BASE ?? '/api/v1').replace(/\/$/, '')

let csrfToken: string | null = null
let csrfTokenTime: number = 0
const CSRF_TOKEN_MAX_AGE = 30 * 60 * 1000 // 30 minutes

async function fetchCsrfToken(): Promise<string> {
  if (csrfToken && (Date.now() - csrfTokenTime) < CSRF_TOKEN_MAX_AGE) return csrfToken
  csrfToken = null
  csrfTokenTime = 0
  try {
    const res = await fetch(`${API_BASE}/csrf-token`, { credentials: 'include' })
    if (!res.ok) return ''
    const data = await res.json()
    csrfToken = data.csrfToken ?? null
    csrfTokenTime = Date.now()
    return csrfToken ?? ''
  } catch {
    return ''
  }
}

function resetCsrfToken(): void {
  csrfToken = null
}

export { resetCsrfToken }

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData
  const isStateChanging = init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method)
  
  const headers: Record<string, string> = isFormData ? {} : { 'Content-Type': 'application/json' }
  
  if (isStateChanging) {
    const token = await fetchCsrfToken()
    if (token) headers['X-CSRF-Token'] = token
  }
  
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  
  if (res.status === 403 && isStateChanging) {
    resetCsrfToken()
    const newToken = await fetchCsrfToken()
    if (newToken) {
      const retryRes = await fetch(`${API_BASE}${path}`, {
        ...init,
        credentials: 'include',
        headers: { ...headers, 'X-CSRF-Token': newToken, ...(init?.headers as Record<string, string> | undefined) },
      })
      if (!retryRes.ok) {
        const body = (await retryRes.json().catch(() => null)) as { error?: string } | null
        if (retryRes.status === 401 && !path.startsWith('/auth/')) {
          if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
            window.location.href = '/login'
          }
        }
        throw new ApiError(retryRes.status, body?.error ?? `API error ${retryRes.status}`)
      }
      return retryRes.json() as Promise<T>
    }
  }
  
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (res.status === 401 && !path.startsWith('/auth/')) {
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    throw new ApiError(res.status, body?.error ?? `API error ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function list<T>(path: string, params?: Record<string, string | number>): Promise<T[]> {
  const all: T[] = []
  let page = 1
  const pageSize = 200
  while (true) {
    const query = params
      ? Object.entries({ ...params, page, limit: pageSize })
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join('&')
      : `page=${page}&limit=${pageSize}`
    const res = await request<{ data: T[]; total: number }>(`${path}${query ? `?${query}` : ''}`)
    all.push(...res.data)
    if (res.data.length < pageSize || all.length >= res.total) break
    page++
  }
  return all
}

export async function maybe<T>(path: string): Promise<T | undefined> {
  try {
    return await request<T>(path)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined
    throw err
  }
}

export type SalesInvoiceRow = Omit<Invoice, 'items'>

export async function withItems(inv: SalesInvoiceRow): Promise<Invoice> {
  const items = await request<InvoiceItem[]>(`/db/invoices/${inv.id}/items`)
  return { ...inv, items }
}

export const PAGED = { limit: 200 }

export interface SearchResults {
  products: Product[]
  customers: Customer[]
  invoices: Array<Pick<Invoice, 'id' | 'number' | 'customer' | 'shopifyOrder' | 'grandTotal'>>
  suppliers: Supplier[]
  salesOrders: SalesOrder[]
  purchaseInvoices: PurchaseInvoice[]
  payments: Payment[]
}
