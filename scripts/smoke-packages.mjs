import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const consumer = mkdtempSync(join(tmpdir(), 'workflow-package-smoke-'))
const run = (file, args, cwd = consumer) => execFileSync(file, args, { cwd, stdio: 'inherit' })
const write = (file, data) => writeFileSync(join(consumer, file), data)
const readManifest = (directory) =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))

try {
  const tarballs = ['workflow-express', 'workflow-react'].map((name) => {
    const directory = join(repo, 'packages', name)
    const filename = `${name}.tgz`
    run('bun', ['pm', 'pack', '--filename', join(consumer, filename), '--quiet'], directory)
    return `./${filename}`
  })

  const { dependencies, devDependencies } = readManifest(join(repo, 'projects/workflow-demo'))
  const { devDependencies: tooling } = readManifest(repo)
  write('package.json', JSON.stringify({ private: true, type: 'module' }))
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--engine-strict',
    ...tarballs,
    `express@${dependencies.express}`,
    `react@${dependencies.react}`,
    `react-dom@${dependencies['react-dom']}`,
    `@types/node@${tooling['@types/node']}`,
    `@types/react@${devDependencies['@types/react']}`,
    `@types/react-dom@${devDependencies['@types/react-dom']}`,
    `typescript@${tooling.typescript}`,
    `vite@${devDependencies.vite}`
  ])

  write(
    'server.ts',
    `
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'
import {
  builtinWorkflowNodes,
  createMemoryWorkflowStore,
  createWorkflowRouter,
  type WorkflowNodeRegistration
} from '@ideawithai/workflow-express'
import { createEmptyWorkflow, type WorkflowDefinition, type WorkflowRun } from '@ideawithai/workflow-express/schema'

const greet: WorkflowNodeRegistration = {
  descriptor: { type: 'greet', version: 1, label: 'Greet', ports: [] },
  execute: ({ input }) => ({ port: null, output: { message: 'Hello, ' + input.name } })
}
const definition: WorkflowDefinition = {
  ...createEmptyWorkflow('Package smoke'),
  entry: 'greet',
  nodes: [{ id: 'greet', type: 'greet', version: 1, config: {} }]
}

const apiBase = '/api/workflow'
const app = express()
app.use(apiBase, createWorkflowRouter({
  store: createMemoryWorkflowStore(), nodes: [...builtinWorkflowNodes, greet],
  enableWorkflowTests: true
}))
const server = app.listen(0, '127.0.0.1')
try {
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = 'http://127.0.0.1:' + address.port + apiBase
  const request = async (path: string, method: string, payload: object, status: number) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    })
    const body = await response.json()
    assert.equal(response.status, status, JSON.stringify(body))
    return body
  }
  const document = await request('/workflows/smoke', 'PUT', { definition, expectedRevision: 0 }, 201)
  const testRun: WorkflowRun = await request('/workflows/smoke/test', 'POST', {
    definition, input: {}, fixtures: [{ nodeId: 'greet', port: null, output: { message: 'Fixture output' } }]
  }, 200)
  assert.equal(testRun.status, 'completed')
  assert.equal(testRun.steps[0]?.fixture, true)
  assert.deepEqual(testRun.steps[0]?.output, { message: 'Fixture output' })
  const run: WorkflowRun = await request('/workflows/smoke/runs', 'POST', {
    revision: document.revision, input: { name: 'workflow' }, runId: 'smoke-run'
  }, 201)
  assert.equal(run.status, 'completed')
  assert.deepEqual(run.steps[0]?.output, { message: 'Hello, workflow' })
} finally {
  server.close()
}
`
  )
  write('index.html', '<div id="app"></div><script type="module" src="/client.tsx"></script>')
  write(
    'client.tsx',
    `
import { createRoot } from 'react-dom/client'
import { createEmptyWorkflow } from '@ideawithai/workflow-express/schema'
import { WorkflowEditor, type WorkflowEditorProps } from '@ideawithai/workflow-react'
import '@ideawithai/workflow-react/styles.css'

const props: WorkflowEditorProps = { apiBase: '/api/workflow', workflowId: 'smoke', enableWorkflowTests: true }
const root = document.getElementById('app')!
root.dataset.workflowName = createEmptyWorkflow('Package smoke').name
createRoot(root).render(<WorkflowEditor {...props} />)
`
  )
  write(
    'vite.config.mjs',
    `
export default {
  esbuild: { jsx: 'automatic' },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.message.includes('externalized for browser compatibility')) {
          throw new Error(warning.message)
        }
        warn(warning)
      }
    }
  }
}
`
  )

  run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    'server.ts',
    'client.tsx',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--jsx',
    'react-jsx',
    '--types',
    'vite/client',
    '--noUncheckedSideEffectImports',
    '--outDir',
    'compiled'
  ])
  run(process.execPath, ['compiled/server.js'])
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'])

  const assets = join(consumer, 'dist', 'assets')
  const css = readdirSync(assets)
    .filter((file) => file.endsWith('.css'))
    .map((file) => readFileSync(join(assets, file), 'utf8'))
    .join('\n')
  assert.match(css, /\.wf-editor\b/)
  assert.match(css, /\.react-flow__node\b/)
  console.log(
    'Packed packages passed npm installation, TypeScript, Express execution, and browser bundling.'
  )
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
