#!/usr/bin/env node
/**
 * Wait until every given HTTP URL answers, then exit 0 (exit 1 on timeout).
 *
 * Used by `npm run electron:dev`: the desktop window loads
 * http://localhost:47195 (Vite) and the UI calls the dev backend on 47191, so
 * Electron must not launch before both are up — loadAppInWindow() has no
 * retry, a too-early load would strand the window on the startup splash.
 *
 * Any HTTP response counts as ready (a server that answers is a server that
 * is up); connection errors / timeouts keep polling.
 *
 * Usage: node scripts/wait-http.mjs <url> [url ...] [--timeout <seconds>]
 */
const args = process.argv.slice(2)
const timeoutIdx = args.indexOf('--timeout')
let timeoutMs = 90_000
if (timeoutIdx !== -1) {
  timeoutMs = Number(args[timeoutIdx + 1]) * 1000
  args.splice(timeoutIdx, 2)
}
const urls = args.filter((a) => /^https?:\/\//.test(a))
if (urls.length === 0) {
  console.error('usage: node scripts/wait-http.mjs <url> [url ...] [--timeout <seconds>]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function answers(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2500)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
    return res.status > 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const deadline = Date.now() + timeoutMs
  const pending = new Set(urls)
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      console.error(`[wait-http] timed out after ${timeoutMs / 1000}s waiting for: ${[...pending].join(', ')}`)
      process.exit(1)
    }
    for (const url of [...pending]) {
      if (await answers(url)) {
        pending.delete(url)
        console.log(`[wait-http] ready: ${url}`)
      }
    }
    if (pending.size > 0) await sleep(500)
  }
}

main().catch((err) => {
  console.error('[wait-http]', err?.message ?? String(err))
  process.exit(1)
})
