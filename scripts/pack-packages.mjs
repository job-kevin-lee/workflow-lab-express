import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = fileURLToPath(new URL('../', import.meta.url))

const folders = ['packages/workflow-express', 'packages/workflow-react']

export function packPackages(destination = join(repo, '.packs')) {
  const directory = resolve(destination)
  const stage = mkdtempSync(join(tmpdir(), 'workflow-package-build-'))
  const sources = [
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'projects/workflow-demo/package.json',
    'packages/workflow-react/styles.css',
    ...folders.flatMap((folder) =>
      ['package.json', 'tsconfig.json', 'README.md', 'src'].map((part) => join(folder, part))
    )
  ]
  try {
    for (const source of sources) {
      const target = join(stage, source)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(repo, source), target, { recursive: true })
    }
    for (const folder of folders) {
      const packageLicense = join(repo, folder, 'LICENSE')
      const license = existsSync(packageLicense) ? packageLicense : join(repo, 'LICENSE')
      if (existsSync(license)) copyFileSync(license, join(stage, folder, 'LICENSE'))
    }
    execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: stage, stdio: 'inherit' })
    const packed = folders.map((folder) => {
      const cwd = join(stage, folder)
      const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
      const filename = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
      execFileSync('bun', ['pm', 'pack', '--filename', join(stage, filename), '--quiet'], {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit']
      })
      return filename
    })
    mkdirSync(directory, { recursive: true })
    return packed.map((filename) => {
      const artifact = join(directory, filename)
      copyFileSync(join(stage, filename), artifact)
      console.log(artifact)
      return artifact
    })
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Usage: pack-packages.mjs [destination]')
  packPackages(destination)
}
