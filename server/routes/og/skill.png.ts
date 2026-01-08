import { readFile } from 'node:fs/promises'

import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { defineEventHandler, getQuery, setHeader } from 'h3'

type OgQuery = {
  slug?: string
  title?: string
  owner?: string
  version?: string
  description?: string
}

let markDataUrlPromise: Promise<string> | null = null
let wasmInitPromise: Promise<void> | null = null

async function ensureWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const wasm = await readFile(
        new URL('../../../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url),
      )
      await initWasm(wasm)
    })()
  }
  await wasmInitPromise
}

function getNitroServerRootUrl() {
  const nitroMain = (globalThis as unknown as { __nitro_main__?: unknown }).__nitro_main__
  if (typeof nitroMain !== 'string') return null
  try {
    return new URL('./', nitroMain)
  } catch {
    return null
  }
}

async function getMarkDataUrl() {
  if (!markDataUrlPromise) {
    markDataUrlPromise = (async () => {
      const candidates = [
        (() => {
          const root = getNitroServerRootUrl()
          return root ? new URL('./clawd-mark.png', root) : null
        })(),
        new URL('../../../public/clawd-mark.png', import.meta.url),
      ].filter((value): value is URL => Boolean(value))

      let lastError: unknown = null
      for (const url of candidates) {
        try {
          const buffer = await readFile(url)
          return `data:image/png;base64,${buffer.toString('base64')}`
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    })()
  }
  return markDataUrlPromise
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function wrapText(value: string, maxChars: number, maxLines: number) {
  const words = value.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length >= maxLines - 1) break
  }
  if (lines.length < maxLines && current) lines.push(current)
  if (lines.length > maxLines) lines.length = maxLines

  const usedWords = lines.join(' ').split(/\s+/).filter(Boolean).length
  if (usedWords < words.length) {
    const last = lines.at(-1) ?? ''
    const trimmed = last.length > maxChars ? last.slice(0, maxChars) : last
    lines[lines.length - 1] = `${trimmed.replace(/\s+$/g, '').replace(/[.。,;:!?]+$/g, '')}…`
  }
  return lines
}

function buildSvg(params: {
  markDataUrl: string
  title: string
  description: string
  ownerLabel: string
  versionLabel: string
  footer: string
}) {
  const rawTitle = params.title.trim() || 'ClawdHub Skill'
  const rawDescription = params.description.trim() || 'Published on ClawdHub.'

  const titleLines = wrapText(rawTitle, 22, 2)
  const descLines = wrapText(rawDescription, 52, 3)

  const titleFontSize = titleLines.length > 1 || rawTitle.length > 24 ? 72 : 80
  const titleY = titleLines.length > 1 ? 258 : 280
  const titleLineHeight = 84

  const descY = titleLines.length > 1 ? 395 : 380
  const descLineHeight = 34

  const pillText = `${params.ownerLabel} • ${params.versionLabel}`

  const titleTspans = titleLines
    .map((line, index) => {
      const dy = index === 0 ? 0 : titleLineHeight
      return `<tspan x="114" dy="${dy}">${escapeXml(line)}</tspan>`
    })
    .join('')

  const descTspans = descLines
    .map((line, index) => {
      const dy = index === 0 ? 0 : descLineHeight
      return `<tspan x="114" dy="${dy}">${escapeXml(line)}</tspan>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#14110F"/>
      <stop offset="0.55" stop-color="#1A1512"/>
      <stop offset="1" stop-color="#14110F"/>
    </linearGradient>

    <radialGradient id="glowOrange" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(260 60) rotate(120) scale(520 420)">
      <stop stop-color="#E86A47" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#E86A47" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="glowSea" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1050 120) rotate(140) scale(520 420)">
      <stop stop-color="#4AD8B7" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#4AD8B7" stop-opacity="0"/>
    </radialGradient>

    <filter id="softBlur" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="24"/>
    </filter>

    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="26" flood-color="#000000" flood-opacity="0.6"/>
    </filter>

    <linearGradient id="pill" x1="0" y1="0" x2="520" y2="0" gradientUnits="userSpaceOnUse">
      <stop stop-color="#E86A47" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#E86A47" stop-opacity="0.08"/>
    </linearGradient>

    <linearGradient id="stroke" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#FFFFFF" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0.06"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="260" cy="60" r="520" fill="url(#glowOrange)" filter="url(#softBlur)"/>
  <circle cx="1050" cy="120" r="520" fill="url(#glowSea)" filter="url(#softBlur)"/>

  <g opacity="0.08">
    <path d="M0 84 C160 120 340 40 520 86 C700 132 820 210 1200 160" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="2"/>
    <path d="M0 188 C220 240 360 160 560 204 C760 248 900 330 1200 300" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="2"/>
    <path d="M0 440 C240 380 420 520 620 470 C820 420 960 500 1200 460" stroke="#FFFFFF" stroke-opacity="0.06" stroke-width="2"/>
  </g>

  <g opacity="0.22" filter="url(#softBlur)">
    <image href="${params.markDataUrl}" x="740" y="70" width="560" height="560" preserveAspectRatio="xMidYMid meet"/>
  </g>

  <g filter="url(#cardShadow)">
    <rect x="72" y="96" width="640" height="438" rx="34" fill="#201B18" fill-opacity="0.92" stroke="url(#stroke)"/>
  </g>

  <image href="${params.markDataUrl}" x="108" y="134" width="46" height="46" preserveAspectRatio="xMidYMid meet"/>

  <g>
    <rect x="166" y="136" width="520" height="42" rx="21" fill="url(#pill)" stroke="#E86A47" stroke-opacity="0.28"/>
    <text x="186" y="163"
      fill="#F6EFE4"
      font-size="18"
      font-weight="650"
      font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif"
      opacity="0.92">${escapeXml(pillText)}</text>
  </g>

  <text x="114" y="${titleY}"
    fill="#F6EFE4"
    font-size="${titleFontSize}"
    font-weight="760"
    font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif">${titleTspans}</text>

  <text x="114" y="${descY}"
    fill="#C6B8A8"
    font-size="26"
    font-weight="520"
    font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif">${descTspans}</text>

  <rect x="114" y="472" width="110" height="6" rx="3" fill="#E86A47"/>
  <text x="114" y="530"
    fill="#F6EFE4"
    font-size="20"
    font-weight="650"
    opacity="0.90"
    font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace">${escapeXml(params.footer)}</text>
</svg>`
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event) as OgQuery
  const slug = typeof query.slug === 'string' ? query.slug.trim() : ''
  if (!slug) {
    setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
    return 'Missing `slug` query param.'
  }

  const title = typeof query.title === 'string' ? query.title : slug
  const description = typeof query.description === 'string' ? query.description : ''
  const owner = typeof query.owner === 'string' ? query.owner.trim() : ''
  const version = typeof query.version === 'string' ? query.version.trim() : ''

  const ownerLabel = owner ? `@${owner}` : 'clawdhub'
  const versionLabel = version ? `v${version}` : 'latest'
  const footer = owner ? `clawdhub.com/${owner}/${slug}` : `clawdhub.com/skills/${slug}`

  const cacheKey = version ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
  setHeader(event, 'Cache-Control', cacheKey)
  setHeader(event, 'Content-Type', 'image/png')

  const [markDataUrl] = await Promise.all([getMarkDataUrl(), ensureWasm()])
  const svg = buildSvg({
    markDataUrl,
    title,
    description,
    ownerLabel,
    versionLabel,
    footer,
  })

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { loadSystemFonts: true },
  })
  const png = resvg.render().asPng()
  resvg.free()
  return png
})
