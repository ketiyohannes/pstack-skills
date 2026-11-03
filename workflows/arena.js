export const meta = {
  name: 'arena',
  description: 'pstack arena: N parallel candidates at one task, then a blinded cross-judge scores each against the rubric',
  whenToUse: 'Run from the pstack arena skill after Phase A. The skill frames the task and rubric, this workflow runs Phases B and C, and the skill picks, grafts, and verifies.',
  phases: [
    { title: 'Fan out', detail: 'one candidate per runner, each in its own worktree or scratch directory' },
    { title: 'Cross-judge', detail: 'one blinded judge scores every candidate per rubric criterion' },
  ],
}

const DEFAULT_RUNNERS = [{ model: 'opus', effort: 'xhigh' }, { model: 'sonnet', effort: 'high' }]
const DEFAULT_JUDGE = { model: 'sonnet', effort: 'high' }
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function need(name) {
  if (args == null || args[name] == null || args[name] === '') {
    throw new Error(`pstack:arena needs args.${name}. See skills/arena/SKILL.md, section "In Claude Code".`)
  }
}

function modelOpts(m) {
  const opts = {}
  if (m && m.model && m.model !== 'inherit') opts.model = m.model
  if (m && m.effort) opts.effort = m.effort
  return opts
}

need('pstackRoot')
need('task')
need('artifact')
need('rubric')
need('slug')
if (!Array.isArray(args.rubric) || args.rubric.length < 3 || args.rubric.length > 6) {
  throw new Error('pstack:arena needs args.rubric as an array of 3 to 6 gradeable criteria.')
}
const writesCode = args.writesCode !== false
if (!writesCode) need('scratchDir')

const root = args.pstackRoot
const runners = Array.isArray(args.runners) && args.runners.length ? args.runners : DEFAULT_RUNNERS
const judgeModel = args.judge || DEFAULT_JUDGE
const agentType = args.candidateAgentType || 'pstack:poteto-agent'

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    location: { type: 'string', description: 'Absolute path where the artifact lives' },
    branch: { type: 'string', description: 'Branch holding the work, when it is in git' },
    commit: { type: 'string', description: 'Commit SHA of the final state, when it is in git' },
    rationale: { type: 'string', description: 'Short rationale for the approach taken' },
    alternativesRejected: { type: 'array', items: { type: 'string' }, description: 'Alternatives considered and why each was rejected' },
  },
  required: ['location', 'rationale', 'alternativesRejected'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate: { type: 'string' },
          criterion: { type: 'string' },
          score: { type: 'integer', minimum: 1, maximum: 5 },
          evidence: { type: 'string' },
        },
        required: ['candidate', 'criterion', 'score', 'evidence'],
      },
    },
    recommendedBase: { type: 'string', description: 'Candidate label to use as the base' },
    rationale: { type: 'string' },
    converged: { type: 'boolean', description: 'True when the candidates converge on one shape' },
  },
  required: ['scores', 'recommendedBase', 'rationale', 'converged'],
}

function candidatePrompt(i) {
  const label = LABELS[i]
  const output = writesCode
    ? `You run in your own git worktree. Commit your work on a new branch named \`arena/${args.slug}/candidate-${label}\`. Report the worktree's absolute path as the location, plus the branch and the final commit SHA.`
    : `Write your output only under \`${args.scratchDir}/candidate-${label}/\`. Report that absolute path as the location.`
  return [
    `You are candidate ${label} in a pstack arena. Other candidates get the same task. You cannot see them.`,
    `Before any work, read \`${root}/skills/poteto-mode/SKILL.md\` in full, including its Principles index.`,
    args.grounding ? `Read the shared grounding at \`${args.grounding}\` before you start.` : '',
    `Artifact to produce: ${args.artifact}`,
    `Task, verbatim:\n\n${args.task}`,
    output,
    'Also return a short rationale and the alternatives you considered and rejected, each with its reason.',
  ].filter(Boolean).join('\n\n')
}

phase('Fan out')
log(`Spawning ${runners.length} candidates for "${args.artifact}"`)
const raw = await parallel(runners.map((runner, i) => () =>
  agent(candidatePrompt(i), {
    label: `candidate-${LABELS[i]}`,
    phase: 'Fan out',
    schema: CANDIDATE_SCHEMA,
    agentType,
    ...(writesCode ? { isolation: 'worktree' } : {}),
    ...modelOpts(runner),
  })))

const candidates = []
const dropouts = []
raw.forEach((result, i) => {
  if (result) candidates.push({ label: LABELS[i], runner: runners[i], ...result })
  else dropouts.push({ label: LABELS[i], runner: runners[i] })
})
if (dropouts.length) log(`Dropped out: ${dropouts.map(d => d.label).join(', ')}`)

let judge = null
if (candidates.length >= 2) {
  phase('Cross-judge')
  const listing = candidates.map(c =>
    `- Candidate ${c.label}: ${c.location}${c.branch ? ` (branch ${c.branch}, commit ${c.commit || 'unknown'})` : ''}\n  Rationale: ${c.rationale}`).join('\n')
  judge = await agent([
    'You are the blinded cross-judge for a pstack arena. Do not edit, commit, or delete anything.',
    `Artifact: ${args.artifact}`,
    `Task the candidates got:\n\n${args.task}`,
    `Rubric:\n${args.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
    `Candidates, by label only:\n${listing}`,
    'Read every candidate end to end. Score each candidate on each criterion from 1 to 5 with concrete evidence (file and line, or a command you ran and its output). Recommend the base a future maintainer can extend most easily without breaking invariants. When two tie, prefer the cleaner boundary or smaller API. Say whether the candidates converge on one shape.',
  ].join('\n\n'), { label: 'cross-judge', phase: 'Cross-judge', schema: JUDGE_SCHEMA, ...modelOpts(judgeModel) })
  if (!judge) log('The cross-judge did not return. The skill picks the base alone.')
} else {
  log('Fewer than two candidates returned, so the cross-judge was skipped.')
}

return { candidates, dropouts, judge, judgeModel: judge ? judgeModel : null }
