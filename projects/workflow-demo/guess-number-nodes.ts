import { createHash } from 'node:crypto'
import {
  isRecord,
  type JsonObject,
  type NodeInput,
  type WorkflowNodeContext,
  type WorkflowNodeRegistration
} from '@ideawithai/workflow-express'
import { numberGame } from './examples.js'

const previousGuess: NodeInput = {
  key: 'guess',
  label: 'Previous guess',
  type: 'json',
  required: true,
  description: 'The submitted data from the previous prompt, with a numeric value.',
  example: { value: 42 }
}

function compareGuess({ runId, workflowRunId, inputs }: WorkflowNodeContext): {
  value: number
  answer: number
  correct: boolean
  hint: string
} {
  const guess = inputs.guess
  if (!isRecord(guess) || typeof guess.value !== 'number' || !Number.isFinite(guess.value)) {
    throw new Error('The previous guess must contain a numeric value.')
  }
  const { minimum, maximum } = numberGame
  const seed = createHash('sha256')
    .update('workflow-lab:guess-number:')
    .update(workflowRunId ?? runId)
    .digest()
  const answer = minimum + (seed.readUInt32BE(0) % (maximum - minimum + 1))
  return {
    value: guess.value,
    answer,
    correct: guess.value === answer,
    hint: guess.value < answer ? 'The number is higher.' : 'The number is lower.'
  }
}

export const guessRound: WorkflowNodeRegistration = {
  descriptor: {
    type: numberGame.roundType,
    version: 1,
    label: 'Next Guess',
    description: 'Check the previous guess and ask for another with a higher or lower hint.',
    category: 'Custom Nodes',
    pausesRun: true,
    fields: [{ key: 'attempt', label: 'Next attempt', type: 'number', required: true }],
    inputs: [previousGuess],
    outputs: [{ key: 'payload', label: 'Submitted data', type: 'json', required: true }],
    ports: [
      { id: 'submitted', label: 'Submitted' },
      { id: 'correct', label: 'Correct' }
    ]
  },
  execute(context) {
    const { attempt } = context.config
    if (
      typeof attempt !== 'number' ||
      !Number.isInteger(attempt) ||
      attempt < 2 ||
      attempt > numberGame.attempts
    ) {
      throw new Error(`Next attempt must be a whole number from 2 to ${numberGame.attempts}.`)
    }
    const { value, correct, hint } = compareGuess(context)
    if (correct) return { port: 'correct', output: { payload: { value } } }
    return {
      waitForCall: {
        port: 'submitted',
        message: `${hint} Guess ${attempt} of ${numberGame.attempts}.`,
        form: { type: 'number', label: 'Your guess' }
      }
    }
  }
}

export const finishGuess: WorkflowNodeRegistration = {
  descriptor: {
    type: numberGame.finishType,
    version: 1,
    label: 'Final Guess',
    description: 'Check the last guess and end the game with the result.',
    category: 'Custom Nodes',
    inputs: [previousGuess],
    ports: []
  },
  execute(context) {
    const { value, answer, correct, hint } = compareGuess(context)
    return {
      port: null,
      output: {
        message: correct
          ? `You guessed ${answer} on your final attempt.`
          : `${hint} You used all ${numberGame.attempts} guesses. The number was ${answer}.`,
        tone: correct ? 'success' : 'warning',
        value: { guess: value, answer, correct }
      }
    }
  }
}

function guessAttempt(input: JsonObject): number {
  const { index } = input
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index + 1 : 1
}

export const guessPrompt: WorkflowNodeRegistration = {
  descriptor: {
    type: numberGame.promptType,
    version: 1,
    label: 'Guess Prompt',
    category: 'Custom Nodes',
    description: 'Show the hint and number of attempts remaining.',
    outputs: [{ key: 'text', label: 'Next prompt', type: 'string', required: true }],
    ports: [{ id: 'next', label: 'Continue' }]
  },
  execute({ input }) {
    const attempt = guessAttempt(input)
    const previous = input.previous
    const hint =
      isRecord(previous) && typeof previous.hint === 'string'
        ? previous.hint
        : `I picked a whole number from ${numberGame.minimum} to ${numberGame.maximum}.`
    return { port: 'next', output: { text: `${hint} Guess ${attempt} of ${numberGame.attempts}.` } }
  }
}

export const checkGuess: WorkflowNodeRegistration = {
  descriptor: {
    type: numberGame.checkType,
    version: 1,
    label: 'Check Guess',
    category: 'Custom Nodes',
    description: 'Compare a guess and return a hint or the final result.',
    inputs: [previousGuess],
    outputs: [
      { key: 'correct', label: 'Correct', type: 'boolean', required: true },
      { key: 'hint', label: 'Next hint', type: 'string', required: true },
      { key: 'message', label: 'Result message', type: 'string', required: true }
    ],
    ports: []
  },
  execute(context) {
    const attempt = guessAttempt(context.input)
    const { correct, answer, hint } = compareGuess(context)
    const message = correct
      ? `You guessed ${answer} on attempt ${attempt}.`
      : attempt >= numberGame.attempts
        ? `${hint} You used all ${numberGame.attempts} guesses. The number was ${answer}.`
        : hint
    return { port: null, output: { correct, hint, message } }
  }
}
