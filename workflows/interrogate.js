export const meta = {
  name: 'interrogate',
  description: 'pstack interrogate: adversaries try to break a change in isolated worktrees, and a verifier re-runs every finding so only proven failures survive',
  whenToUse: 'Run from the pstack interrogate skill after Frame. The skill sets the scope, intent, and patch, this workflow runs Fan out and Verify, and the skill merges root causes and writes the output.',
  phases: [
    { title: 'Fan out', detail: 'one adversary per model, each in its own worktree with the scope applied' },
    { title: 'Verify', detail: 'one verifier per finding re-runs it in a fresh worktree' },
  ],
}

const DEFAULT_ADVERSARIES = [{ model: 'opus', effort: 'xhigh' }, { model: 'sonnet', effort: 'high' }]
const DEFAULT_VERIFIER = { model: 'sonnet', effort: 'medium' }

function need(name) {
  if (args == null || args[name] == null || args[name] === '') {
    throw new Error(`pstack:interrogate needs args.${name}. See skills/interrogate/SKILL.md, section "In Claude Code".`)
  }
}

function modelOpts(m) {
  const opts = {}
  if (m && m.model && m.model !== 'inherit') opts.model = m.model
  if (m && m.effort) opts.effort = m.effort
  return opts
}

need('scope')
need('intent')
const adversaries = Array.isArray(args.adversaries) && args.adversaries.length ? args.adversaries : DEFAULT_ADVERSARIES
const verifierModel = args.verifier || DEFAULT_VERIFIER

const BRIEF = 'Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.'

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    setupOk: { type: 'boolean', description: 'False when the setup step failed, so no attack ran' },
    setupError: { type: 'string', description: 'The exact error when setupOk is false' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          command: { type: 'string', description: 'Exact command, runnable from the worktree root' },
          output: { type: 'string', description: 'What the command printed' },
          expected: { type: 'string', description: 'The output the intent requires' },
          files: {
            type: 'array',
            description: 'Every repro file the command needs, with full contents, relative to the worktree root',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        },
        required: ['title', 'command', 'output', 'expected', 'files'],
      },
    },
  },
  required: ['setupOk', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    reproduced: { type: 'boolean', description: 'The re-run shows the reported failure' },
    breaksIntent: { type: 'boolean', description: 'The failure breaks the stated intent' },
    output: { type: 'string', description: 'What the re-run printed' },
    reason: { type: 'string' },
  },
  required: ['reproduced', 'breaksIntent', 'output', 'reason'],
}

function setupStep(onFailure) {
  if (args.patchPath) return `First apply the scope's uncommitted changes in this worktree with \`git apply ${args.patchPath}\`. If it does not apply, stop and ${onFailure}.`
  if (args.ref) return `First check out \`${args.ref}\` in this worktree.`
  return 'This worktree already holds the scope.'
}

function adversaryPrompt(i) {
  return [
    `You are adversary ${i + 1} in a pstack interrogation. Other adversaries attack the same change independently.`,
    setupStep('report setupOk false with the exact error and an empty findings list'),
    `Scope: ${args.scope}`,
    `Intent of the change: ${args.intent}`,
    BRIEF,
    'Your worktree is deleted when you finish, and a verifier re-runs each finding in a fresh worktree with the same setup. Make each command run from the worktree root, and list every new repro file it needs in `files` with full contents. Never list a file the scope or the repository already has, because the verifier must test the real change. Use an empty `files` list when the command needs none.',
  ].join('\n\n')
}

phase('Fan out')
log(`Spawning ${adversaries.length} adversaries`)
const perAdversary = await pipeline(
  adversaries,
  (adversary, _item, i) => agent(adversaryPrompt(i), {
    label: `adversary-${i + 1}`,
    phase: 'Fan out',
    schema: FINDINGS_SCHEMA,
    isolation: 'worktree',
    ...modelOpts(adversary),
  }),
  async (report, adversary, i) => {
    if (!report) return { adversary: i + 1, model: adversary, inconclusive: 'adversary did not return', verified: [], rejected: [] }
    if (!report.setupOk) {
      log(`adversary-${i + 1} could not set up the scope: ${report.setupError || 'no error given'}`)
      return { adversary: i + 1, model: adversary, inconclusive: `setup failed: ${report.setupError || 'no error given'}`, verified: [], rejected: [] }
    }
    const verdicts = await parallel(report.findings.map((finding, j) => () =>
      agent([
        'You verify one finding from an adversarial review. You run in your own fresh git worktree. Change nothing beyond the setup and the repro files below.',
        setupStep('report reproduced as false with the git error as the reason'),
        finding.files.length
          ? `Write these new repro files, relative to the worktree root. Skip any path that already exists, and say so in the reason:\n\n${finding.files.map(f => `--- ${f.path}\n${f.content}`).join('\n\n')}`
          : 'The finding needs no repro files.',
        `Change intent: ${args.intent}`,
        `Finding: ${finding.title}`,
        `From the worktree root, run exactly:\n\n${finding.command}`,
        `The adversary saw:\n\n${finding.output}\n\nThe intent requires:\n\n${finding.expected}`,
        'Report whether your re-run shows the failure, whether that failure breaks the intent, and what the command printed.',
      ].join('\n\n'), { label: `verify:${i + 1}.${j + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA, isolation: 'worktree', ...modelOpts(verifierModel) })))
    const verified = []
    const rejected = []
    report.findings.forEach((finding, j) => {
      const v = verdicts[j]
      if (v && v.reproduced && v.breaksIntent) verified.push({ ...finding, rerunOutput: v.output })
      else rejected.push({ title: finding.title, reason: v ? v.reason : 'verifier did not return' })
    })
    return { adversary: i + 1, model: adversary, verified, rejected }
  },
)

const results = perAdversary.filter(Boolean)
const verifiedCount = results.reduce((n, r) => n + r.verified.length, 0)
const ran = results.filter(r => !r.inconclusive).length
log(`${verifiedCount} verified findings, ${ran} of ${adversaries.length} adversaries ran`)
return { intent: args.intent, inconclusive: ran === 0, results }
