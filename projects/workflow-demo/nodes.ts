import {
  createHttpRequestNode,
  humanInputNode,
  inputNode,
  iterationNode,
  logicNode,
  loopNode,
  resultNode,
  waitNode,
  waitForCallNode,
  type WorkflowNodeRegistration
} from '@ideawithai/workflow-express'

import { finishGuess, guessRound } from './guess-number-nodes.js'
import { stockCheckNode } from './stock-check-node.js'

function demoRequest(url: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (url.hostname === 'api.github.com') headers.set('User-Agent', 'workflow-lab')
  return fetch(url, { ...init, headers })
}

export const nodesForDemo = (loopbackOrigin: string): WorkflowNodeRegistration[] => [
  logicNode,
  humanInputNode,
  iterationNode,
  loopNode,
  waitNode,
  createHttpRequestNode({
    origin: loopbackOrigin,
    allowedOrigins: ['https://api.github.com', 'https://example.com'],
    request: demoRequest
  }),
  inputNode,
  waitForCallNode,
  resultNode,
  stockCheckNode,
  guessRound,
  finishGuess
]
