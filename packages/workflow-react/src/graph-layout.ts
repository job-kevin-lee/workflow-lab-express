import type { WorkflowDefinition, WorkflowEdge } from '@ideawithai/workflow-express/schema'

type Layout = WorkflowDefinition['layout']
type Dimensions = ReadonlyMap<string, { width?: number; height?: number } | undefined>

const columnWidth = 245
const rowGap = 34
const nodeWidth = 185
const nodeHeight = 90

export function nodePosition(layout: Layout, id: string, index: number): Layout[string] {
  return Object.hasOwn(layout, id) ? layout[id] : { x: index * 200, y: 0 }
}

export function arrangeLayout(definition: WorkflowDefinition, dimensions: Dimensions): Layout {
  const incoming = new Map(definition.nodes.map(({ id }) => [id, 0]))
  const outgoing = new Map<string, Set<string>>()
  for (const edge of definition.edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue
    const targets = outgoing.get(edge.from) ?? new Set<string>()
    if (targets.has(edge.to)) continue
    targets.add(edge.to)
    outgoing.set(edge.from, targets)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  const queue = definition.nodes.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id)
  const depth = new Map(queue.map((id) => [id, 0]))
  const visited = new Set<string>()
  for (const id of queue) {
    visited.add(id)
    for (const target of outgoing.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1))
      const remaining = (incoming.get(target) ?? 1) - 1
      incoming.set(target, remaining)
      if (!remaining) queue.push(target)
    }
  }
  const fallback = 1 + Math.max(-1, ...queue.map((id) => depth.get(id) ?? 0))
  const columns = new Map<number, string[]>()
  for (const { id } of definition.nodes) {
    const column = visited.has(id) ? (depth.get(id) ?? 0) : fallback
    const ids = columns.get(column) ?? []
    ids.push(id)
    columns.set(column, ids)
  }

  const heightOf = (id: string): number => dimensions.get(id)?.height ?? nodeHeight
  const heightOfColumn = (ids: string[]): number =>
    ids.reduce((height, id) => height + heightOf(id) + rowGap, -rowGap)
  const tallestColumn = Math.max(0, ...[...columns.values()].map(heightOfColumn))
  const points: [string, Layout[string]][] = []
  for (const [column, ids] of columns) {
    let y = 30 + Math.round((tallestColumn - heightOfColumn(ids)) / 2)
    for (const id of ids) {
      points.push([id, { x: 20 + columnWidth * column, y }])
      y += heightOf(id) + rowGap
    }
  }
  return Object.fromEntries(points)
}

export function insertionPoint(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
  dimensions: Dimensions
): Layout[string] {
  const positions = new Map(
    definition.nodes.map(({ id }, index) => [id, nodePosition(definition.layout, id, index)])
  )
  const from = positions.get(edge.from)
  const to = positions.get(edge.to)
  if (!from || !to) return { x: 20, y: 30 }

  const x = (from.x + to.x) / 2
  const middleY = (from.y + to.y) / 2
  const fits = (y: number): boolean =>
    [...positions].every(([id, point]) => {
      const width = dimensions.get(id)?.width ?? nodeWidth
      const height = dimensions.get(id)?.height ?? nodeHeight
      return (
        x + nodeWidth + 20 <= point.x ||
        x >= point.x + width + 20 ||
        y + nodeHeight + 20 <= point.y ||
        y >= point.y + height + 20
      )
    })
  if (fits(middleY)) return { x, y: middleY }
  for (let step = 1; step <= positions.size; step++) {
    const below = middleY + step * (nodeHeight + rowGap)
    if (fits(below)) return { x, y: below }
    const above = middleY - step * (nodeHeight + rowGap)
    if (fits(above)) return { x, y: above }
  }
  return {
    x,
    y:
      Math.max(
        ...[...positions].map(([id, point]) => point.y + (dimensions.get(id)?.height ?? nodeHeight))
      ) + rowGap
  }
}
