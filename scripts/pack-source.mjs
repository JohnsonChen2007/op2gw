// Pack tracked source files into zip + tar.gz via `git archive`.
// Uses only git-tracked files, so local secrets (~/.op2gw/config.json,
// .env, untracked media) can never leak into the artifact.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const version = require('./package.json').version
const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

const outDir = join(root, 'dist-pack')
mkdirSync(outDir, { recursive: true })

const artifacts = [`op2gw-${version}-${sha}.zip`, `op2gw-${version}-${sha}.tar.gz`]
execFileSync('git', ['archive', '-o', join(outDir, artifacts[0]), 'HEAD'], { cwd: root, stdio: 'inherit' })
execFileSync('git', ['archive', '--format=tar.gz', '-o', join(outDir, artifacts[1]), 'HEAD'], {
  cwd: root,
  stdio: 'inherit',
})

for (const name of artifacts) {
  const path = join(outDir, name)
  if (!existsSync(path)) throw new Error(`missing artifact: ${path}`)
  console.log(`${name}  ${(statSync(path).size / 1024).toFixed(1)} KiB`)
}
