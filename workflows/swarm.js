export const meta = {
  name: 'swarm',
  description: 'pstack swarm: fan out N workers over slices or race arms, re-run any worker whose record is incomplete, and return one result table',
  whenToUse: 'Run from the pstack swarm skill after Phase A. The skill frames the slices and briefs, this workflow runs Phases B and C, and the skill writes the report.',
  phases: [
    { title: 'Fan out', detail: 'one worker per slice or race arm' },
    { title: 'Respawn', detail: 'one retry for a worker whose result misses the SHAs or method its brief requires' },
  ],
}

const DEFAULT_WORKER = { model: 'sonnet', effort: 'high' }
const RACE_RULES = ['first pass', 'rank all', 'best-of']

function need(name) {
  if (args == null || args[name] == null || args[name] === '') {
    throw new Error(`pstack:swarm needs args.${name}. See skills/swarm/SKILL.md, section "In Claude Code".`)
  }
}

function modelOpts(m) {
  const opts = {}
  if (m && m.model && m.model !== 'inherit') opts.model = m.model
  if (m && m.effort) opts.effort = m.effort
  return opts
}

need('pstackRoot')
need('goal')
need('donePredicate')
need('workers')
const shape = args.shape || 'coverage'
if (!['coverage', 'race', 'mixed'].includes(shape)) throw new Error('pstack:swarm args.shape must be coverage, race, or mixed.')
if (shape !== 'coverage' && !RACE_RULES.includes(args.raceRule)) {
  throw new Error(`pstack:swarm needs args.raceRule (${RACE_RULES.join(', ')}) declared before spawning a race.`)
}
if (!Array.isArray(args.workers) || !args.workers.length) throw new Error('pstack:swarm args.workers must be a non-empty array of {id, brief}.')

const defaultWorker = args.defaultWorker || DEFAULT_WORKER
const isolation = args.isolation === 'worktree' ? { isolation: 'worktree' } : {}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PASS', 'ISSUES', 'BLOCKED'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Commands run with their output, or artifact paths' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, evidence: { type: 'string' } },
        required: ['title', 'evidence'],
      },
      description: 'Every issue you can prove, not only the first',
    },
    shas: { type: 'array', items: { type: 'string' }, description: 'Exact commit SHAs verified or measured' },
    method: { type: 'string', description: 'Measurement method: sample count, what one sample is, and order' },
    score: { type: 'number', description: 'Race arms only: the number the race ranks on, when it has one' },
  },
  required: ['status', 'summary', 'evidence', 'issues'],
}

function missingRecord(result) {
  const missing = []
  if (args.requireShas && !(result.shas && result.shas.length)) missing.push('the exact SHAs')
  if (args.requireMethod && !result.method) missing.push('the measurement method')
  return missing
}

function brief(worker) {
  return [
    `You are one worker in a pstack swarm (${shape}). You cannot see the other workers.`,
    `Goal: ${args.goal}`,
    `Done predicate: ${args.donePredicate}`,
    `Your ${shape === 'coverage' ? 'slice' : 'race arm'}: ${worker.id}`,
    worker.brief,
    args.requireShas ? 'Record the exact commit SHAs you verified or measured.' : '',
    args.requireMethod ? 'Record the method: sample count, what one sample is, and the order you ran them in.' : '',
    'Report PASS, ISSUES, or BLOCKED with evidence. With ISSUES, list every issue you can prove, not only the first.',
  ].filter(Boolean).join('\n\n')
}

const finishOrder = []

phase('Fan out')
log(`Spawning ${args.workers.length} workers`)
const rows = await pipeline(
  args.workers,
  worker => agent(brief(worker), {
    label: `worker:${worker.id}`,
    phase: 'Fan out',
    schema: RESULT_SCHEMA,
    ...isolation,
    ...modelOpts(worker.model ? worker : defaultWorker),
  }),
  async (result, worker) => {
    if (!result) return { id: worker.id, gap: 'worker dropped out' }
    const missing = missingRecord(result)
    if (!missing.length) {
      finishOrder.push(worker.id)
      return { id: worker.id, ...result }
    }
    log(`${worker.id} missed ${missing.join(' and ')}, respawning once`)
    const retry = await agent(`${brief(worker)}\n\nA previous attempt left out ${missing.join(' and ')}. Include them.`, {
      label: `respawn:${worker.id}`,
      phase: 'Respawn',
      schema: RESULT_SCHEMA,
      ...isolation,
      ...modelOpts(worker.model ? worker : defaultWorker),
    })
    if (retry && !missingRecord(retry).length) {
      finishOrder.push(worker.id)
      return { id: worker.id, respawned: true, ...retry }
    }
    return { id: worker.id, gap: `missing ${missing.join(' and ')} after one respawn` }
  },
)

const gaps = rows.filter(r => r && r.gap)
let selection = null
if (shape !== 'coverage') {
  const passed = rows.filter(r => r && !r.gap && r.status === 'PASS')
  if (args.raceRule === 'first pass') {
    const firstId = finishOrder.find(id => passed.some(r => r.id === id))
    selection = { rule: 'first pass', winner: firstId || null }
  } else {
    const ranked = passed.slice().sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)).map(r => r.id)
    selection = { rule: args.raceRule, ranking: ranked, winner: args.raceRule === 'best-of' ? ranked[0] || null : null }
  }
}

return { shape, rows, gaps, selection, finishOrder }
