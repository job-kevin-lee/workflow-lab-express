import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packPackages, repo } from './pack-packages.mjs'

const paths = process.argv.slice(2)
if (paths.length !== 0 && paths.length !== 2)
  throw new Error('Usage: smoke-packages.mjs [express.tgz react.tgz]')

const consumer = mkdtempSync(join(tmpdir(), 'workflow-package-smoke-'))
const serverProject = join(consumer, 'express-app')
const editorProject = join(consumer, 'react-app')
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'inherit' })
const write = (cwd, file, data) => writeFileSync(join(cwd, file), data)
const readManifest = (directory) =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))

function npmInstall(directory, packages) {
  mkdirSync(directory)
  write(directory, 'package.json', JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--no-audit', '--no-fund', '--engine-strict', ...packages], directory)
}

function compile(directory, source, options = []) {
  run(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      source,
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--outDir',
      'compiled',
      ...options
    ],
    directory
  )
}

function checkSources(project, workspace) {
  const installed = join(project, 'node_modules', '@ideawithai', workspace)
  const dist = join(installed, 'dist')
  const maps = readdirSync(dist).filter((file) => file.endsWith('.map'))
  assert.ok(
    maps.some((file) => file.endsWith('.js.map')),
    `${workspace} runtime source maps`
  )
  assert.ok(
    maps.some((file) => file.endsWith('.d.ts.map')),
    `${workspace} declaration maps`
  )
  for (const map of maps) {
    const { sources } = JSON.parse(readFileSync(join(dist, map), 'utf8'))
    for (const source of sources) {
      assert.ok(
        existsSync(resolve(dist, source)),
        `${workspace} ${map} references missing source ${source}`
      )
    }
  }
  const packagedSources = readdirSync(join(installed, 'src'), {
    recursive: true,
    withFileTypes: true
  }).filter((entry) => entry.isFile())
  for (const { name } of packagedSources) {
    assert.match(name, /\.tsx?$/, `${workspace} shipped unexpected source ${name}`)
    assert.doesNotMatch(name, /\.test\.tsx?$/, `${workspace} shipped development test ${name}`)
  }
  return readManifest(installed)
}

try {
  const [expressTarball, reactTarball] = paths.length
    ? paths.map((path) => resolve(path))
    : packPackages(consumer)

  const { dependencies, devDependencies } = readManifest(join(repo, 'projects/workflow-demo'))
  const { devDependencies: tooling } = readManifest(repo)
  npmInstall(serverProject, [
    expressTarball,
    `express@${dependencies.express}`,
    `@types/node@${tooling['@types/node']}`,
    `typescript@${tooling.typescript}`
  ])
  npmInstall(editorProject, [
    expressTarball,
    reactTarball,
    `react@${dependencies.react}`,
    `react-dom@${dependencies['react-dom']}`,
    `@types/react@${devDependencies['@types/react']}`,
    `@types/react-dom@${devDependencies['@types/react-dom']}`,
    `typescript@${tooling.typescript}`,
    `vite@${devDependencies.vite}`
  ])
  assert.ok(!existsSync(join(serverProject, 'node_modules', 'react')))
  assert.ok(!existsSync(join(editorProject, 'node_modules', 'express')))
  const expressPackage = checkSources(serverProject, 'workflow-express')
  const reactPackage = checkSources(editorProject, 'workflow-react')
  assert.equal(
    reactPackage.dependencies[expressPackage.name],
    expressPackage.version,
    'React must depend on the Express version packaged with it'
  )

  write(
    serverProject,
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
  write(
    editorProject,
    'index.html',
    '<div id="app"></div><script type="module" src="/client.tsx"></script>'
  )
  write(
    editorProject,
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
    editorProject,
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

  compile(serverProject, 'server.ts')
  compile(editorProject, 'client.tsx', [
    '--jsx',
    'react-jsx',
    '--types',
    'vite/client',
    '--noUncheckedSideEffectImports'
  ])
  run(process.execPath, ['compiled/server.js'], serverProject)
  run(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn'],
    editorProject
  )

  const assets = join(editorProject, 'dist', 'assets')
  const css = readdirSync(assets)
    .filter((file) => file.endsWith('.css'))
    .map((file) => readFileSync(join(assets, file), 'utf8'))
    .join('\n')
  assert.match(css, /\.wf-editor\b/)
  assert.match(css, /\.react-flow__node\b/)
  console.log(
    'Packed packages passed separate npm installs, TypeScript, Express execution, and browser bundling.'
  )
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
