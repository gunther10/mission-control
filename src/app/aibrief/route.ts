import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'

const BRIEF_PATH = '/home/hmac/openclaw-lab/reports/ailearn/latest/brief.html'

export async function GET() {
  try {
    const html = await readFile(BRIEF_PATH, 'utf-8')
    return new NextResponse(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    const fallback = `<!doctype html>
<html><head><meta charset="utf-8"><title>AILEARN brief unavailable</title>
<style>body{font-family:Inter,Arial,sans-serif;background:#0b1020;color:#eef2ff;padding:40px} .card{max-width:800px;margin:0 auto;background:#121833;border-radius:18px;padding:24px;border:1px solid rgba(255,255,255,.08)}</style>
</head><body><div class="card"><h1>AILEARN brief unavailable</h1><p>The latest hosted brief is not ready yet.</p><p>Expected file: <code>${path.basename(BRIEF_PATH)}</code></p></div></body></html>`
    return new NextResponse(fallback, {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }
}
