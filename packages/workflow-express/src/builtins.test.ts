import { expect, test } from 'bun:test'
import { conditionNode, createHttpRequestNode, logicNode } from './builtins.js'

const context = { runId: 'run', nodeId: 'node', input: {}, signal: new AbortController().signal }

test('HTTP forwards bound null and routes business rejection to its error port', async () => {
  const node = createHttpRequestNode({
    origin: 'http://example.test',
    request: async (url, init) => {
      expect(url.href).toBe('http://example.test/robot')
      expect(init.method).toBe('POST')
      expect(init.body).toBe('null')
      expect(init.redirect).toBe('error')
      expect(init.signal).toBe(context.signal)
      return Response.json({ success: false, message: 'rejected' })
    }
  })
  expect(
    await node.execute({
      ...context,
      config: { url: '/robot', method: 'POST', body: '{"fallback":true}', successPath: 'success' },
      inputs: { body: null }
    })
  ).toEqual({
    port: 'error',
    output: { status: 200, body: { success: false, message: 'rejected' } },
    httpRequest: {
      method: 'POST',
      url: 'http://example.test/robot',
      headers: { 'content-type': 'application/json' }
    }
  })
})

test('HTTP rejects other origins and routes network failures to the error port', async () => {
  let calls = 0
  const node = createHttpRequestNode({
    origin: 'http://example.test',
    request: async () => {
      calls++
      throw new Error('offline')
    }
  })
  expect(
    await node.execute({ ...context, config: { url: '/status', method: 'GET' }, inputs: {} })
  ).toEqual({
    port: 'error',
    output: { status: 0, body: 'offline' },
    httpRequest: { method: 'GET', url: 'http://example.test/status', headers: {} }
  })
  await expect(
    Promise.resolve(
      node.execute({
        ...context,
        config: { url: 'http://other.test/status', method: 'GET' },
        inputs: {}
      })
    )
  ).rejects.toThrow('outside the configured origin')
  expect(calls).toBe(1)
})

test('HTTP binds a URL and replaces selected query fields before the request', async () => {
  const node = createHttpRequestNode({
    origin: 'http://example.test',
    request: async (url) => {
      expect(url.pathname).toBe('/orders/A-01')
      expect([...url.searchParams]).toEqual([
        ['source', 'lab'],
        ['tag', 'north/west'],
        ['tag', 'ready for pickup'],
        ['size', '10'],
        ['active', 'false']
      ])
      return Response.json({ found: true })
    }
  })
  expect(
    await node.execute({
      ...context,
      config: { method: 'GET', url: '/unused' },
      inputs: {
        url: '/orders/A-01?source=lab&tag=old&obsolete=1',
        query: { tag: ['north/west', 'ready for pickup'], size: 10, active: false, obsolete: null }
      }
    })
  ).toMatchObject({
    port: 'ok',
    httpRequest: {
      url: 'http://example.test/orders/A-01?source=lab&tag=north%2Fwest&tag=ready+for+pickup&size=10&active=false'
    }
  })
})

test('HTTP rejects invalid dynamic targets and query values before any request', async () => {
  let calls = 0
  const node = createHttpRequestNode({
    origin: 'https://example.test',
    request: async () => {
      calls++
      return Response.json({})
    }
  })
  const fixed = { ...context, config: { method: 'GET', url: '/fallback' } }
  for (const url of ['https://another.test/orders', 'blob:https://example.test/identifier']) {
    await expect(node.execute({ ...fixed, inputs: { url } })).rejects.toMatchObject({
      code: 'invalid_http_origin'
    })
  }
  await expect(node.execute({ ...fixed, inputs: { url: '' } })).rejects.toMatchObject({
    code: 'invalid_http_url'
  })
  await expect(
    node.execute({ ...fixed, inputs: { query: { invalid: { nested: true } } } })
  ).rejects.toMatchObject({ code: 'invalid_http_query' })
  expect(calls).toBe(0)
})

test('conditions compare nested JSON with strict value types', async () => {
  const config = { path: 'data.0.power', operator: 'lt', expected: '25' }
  expect(
    await conditionNode.execute({
      ...context,
      config,
      inputs: { value: { data: [{ power: 18 }] } }
    })
  ).toEqual({ port: 'yes', output: { matched: true } })
  expect(
    await conditionNode.execute({
      ...context,
      config,
      inputs: { value: { data: [{ power: 25 }] } }
    })
  ).toEqual({ port: 'no', output: { matched: false } })
  expect(() =>
    conditionNode.execute({
      ...context,
      config,
      inputs: { value: { data: [{ power: '18' }] } }
    })
  ).toThrow('requires numbers')
})

test('Logic combines Dify-style conditions with AND or OR', async () => {
  const conditions = [
    { path: 'profile.name', operator: 'contains', expected: '"Ada"' },
    { path: 'profile.completed', operator: 'eq', expected: 'true' }
  ]
  const inputs = { value: { profile: { name: 'Ada Lovelace', completed: false } } }
  expect(
    await logicNode.execute({ ...context, config: { mode: 'all', conditions }, inputs })
  ).toMatchObject({ port: 'no' })
  expect(
    await logicNode.execute({ ...context, config: { mode: 'any', conditions }, inputs })
  ).toMatchObject({ port: 'yes' })
})
