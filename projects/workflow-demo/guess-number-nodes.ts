import { createHash } from 'node:crypto'
import {
  isRecord,
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

function compareGuess({ runId, inputs }: WorkflowNodeContext): {
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
  const seed = createHash('sha256').update('workflow-lab:guess-number:').update(runId).digest()
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
