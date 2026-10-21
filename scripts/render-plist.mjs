#!/usr/bin/env node
/**
 * render-plist.mjs — turn the tracked launchd templates into installable plists.
 *
 * The tracked files under scripts/*.plist are TEMPLATES: they carry
 * `__PLACEHOLDER__` tokens instead of absolute paths, so the repository never
 * records the maintainer's home directory, user name, or machine layout.
 *
 * This script substitutes the placeholders with the values of the machine it
 * runs on and writes the result to a destination (default: ~/Library/LaunchAgents).
 *
 *   node scripts/render-plist.mjs                     # render both, install
 *   node scripts/render-plist.mjs --out /tmp/x        # render into /tmp/x
 *   node scripts/render-plist.mjs --print             # print, do not write
 *   node scripts/render-plist.mjs --only watchdog     # render one job
 *
 * Placeholders
 *   __OP2GW_ROOT__    absolute path of the op2gw checkout
 *   __HOME__          the user's home directory
 *   __PATH__          a PATH that includes the node install + common bins
 *   __XRAY_BIN__      absolute path of the xray binary
 *   __XRAY_POOL_DIR__ directory holding the generated xray config
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const HOME = homedir()

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const outDir = resolve(opt('--out', join(HOME, 'Library/LaunchAgents')))
const printOnly = has('--print')
const only = opt('--only', '')

/** v2rayN ships xray inside the app bundle; fall back to a PATH lookup. */
const xrayCandidates = [
  join(HOME, 'Library/Application Support/v2rayN/bin/xray/xray'),
  '/usr/local/bin/xray',
  '/opt/homebrew/bin/xray',
]
const xrayBin = xrayCandidates.find((p) => existsSync(p)) ?? xrayCandidates[0]

const PATH_VALUE = [
  join(HOME, '.nvm/versions/node', 'v24.15.0/bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/homebrew/bin',
].join(':')

const JOBS = [
  { file: 'com.op2gw.watchdog.plist', job: 'watchdog' },
  { file: 'com.op2gw.xraypool.plist', job: 'xraypool' },
]

const replacements = {
  __OP2GW_ROOT__: ROOT,
  __HOME__: HOME,
  __PATH__: PATH_VALUE,
  __XRAY_BIN__: xrayBin,
  __XRAY_POOL_DIR__: join(HOME, '.op2gw/xray-pool'),
}

let rendered = 0
for (const { file, job } of JOBS) {
  if (only && only !== job) continue
  const src = join(SCRIPT_DIR, file)
  let text = readFileSync(src, 'utf8')
  for (const [token, value] of Object.entries(replacements)) {
    text = text.split(token).join(value)
  }
  const leftover = text.match(/__[A-Z0-9_]+__/g)
  if (leftover) {
    console.error(`render-plist: ${file} still has unresolved tokens: ${[...new Set(leftover)].join(', ')}`)
    process.exitCode = 1
    continue
  }
  if (printOnly) {
    process.stdout.write(text)
    continue
  }
  mkdirSync(outDir, { recursive: true })
  const dest = join(outDir, file)
  writeFileSync(dest, text, 'utf8')
  console.log(`render-plist: wrote ${dest}`)
  rendered += 1
}

if (!printOnly) {
  console.log(`render-plist: ${rendered} job(s) rendered into ${outDir}`)
  console.log('render-plist: load them with:')
  for (const { file, job } of JOBS) {
    if (only && only !== job) continue
    console.log(`  launchctl load ${join(outDir, file)}`)
  }
}
