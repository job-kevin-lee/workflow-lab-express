import {
  builtinWorkflowNodes,
  createHttpRequestNode,
  type WorkflowNodeRegistration
} from '@ideawithai/workflow-express'

import { checkGuess, finishGuess, guessPrompt, guessRound } from './guess-number-nodes.js'
import { stockCheckNode } from './stock-check-node.js'

function demoRequest(url: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (url.hostname === 'api.github.com') headers.set('User-Agent', 'workflow-lab')
  return fetch(url, { ...init, headers })
}

export const nodesForDemo = (loopbackOrigin: string): WorkflowNodeRegistration[] => [
  ...builtinWorkflowNodes,
  createHttpRequestNode({
    origin: loopbackOrigin,
    allowedOrigins: ['https://api.github.com', 'https://example.com'],
    request: demoRequest
  }),
  stockCheckNode,
  guessPrompt,
  checkGuess,
  guessRound,
  finishGuess
]
