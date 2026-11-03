export const meta = {
  name: 'why',
  description: 'pstack why: one investigator per evidence source digs for design rationale in parallel, then a synthesizer writes a cited, confidence-rated answer',
  whenToUse: 'Run from the pstack why skill after Step 2 and MCP discovery. The skill builds the code anchor and the roster, this workflow runs Steps 3 and 4, and the skill presents the result.',
  phases: [
    { title: 'Investigate', detail: 'one investigator per evidence category, each owning one source' },
    { title: 'Synthesize', detail: 'one synthesizer applies the epistemics framework and spot-checks citations' },
  ],
}

const DEFAULT_INVESTIGATOR = { model: 'sonnet', effort: 'high' }
const DEFAULT_SYNTHESIZER = { model: 'opus', effort: 'xhigh' }

function need(name) {
  if (args == null || args[name] == null || args[name] === '') {
    throw new Error(`pstack:why needs args.${name}. See skills/why/SKILL.md, section "In Claude Code".`)
  }
}

function modelOpts(m) {
  const opts = {}
  if (m && m.model && m.model !== 'inherit') opts.model = m.model
  if (m && m.effort) opts.effort = m.effort
  return opts
}

need('pstackRoot')
need('question')
need('anchor')
need('investigators')
if (!Array.isArray(args.investigators) || !args.investigators.some(i => i.category === 'source control')) {
  throw new Error('pstack:why args.investigators must include a "source control" investigator. It is always spawned.')
}

const refs = `${args.pstackRoot}/skills/why/references`
const a = args.anchor
const anchorFill = [
  `{QUESTION}: ${args.question}`,
  `{FILES_WITH_LINE_RANGES}: ${a.files || 'none given'}`,
  `{SYMBOLS}: ${a.symbols || 'none given'}`,
  `{COMMIT_LIST}: ${a.commits || 'none given'}`,
  `{PR_NUMBERS}: ${a.prs || 'none given'}`,
  `{TICKET_IDS}: ${a.tickets || 'none given'}`,
].join('\n')
const investigatorModel = (args.models && args.models.investigator) || DEFAULT_INVESTIGATOR
const synthesizerModel = (args.models && args.models.synthesizer) || DEFAULT_SYNTHESIZER
const skipped = Array.isArray(args.skipped) ? args.skipped.slice() : []

function investigatorPrompt(inv) {
  return [
    `Read \`${refs}/investigator-prompt.md\` and \`${refs}/epistemics.md\`. The first is your brief. Do not write or edit anything.`,
    `Fill its placeholders with:\n\n${anchorFill}\n{SOURCE_NAME}: ${inv.source}`,
    inv.playbook
      ? `Fill {SOURCE_PLAYBOOK_SECTION} with the contents of \`${inv.playbook}\`.`
      : `Fill {SOURCE_PLAYBOOK_SECTION} by adapting the examples in \`${refs}/source-playbook.md\` to ${inv.source}.`,
    inv.incident ? `The target looks defensive, so also follow \`${refs}/sources/incident-postmortem.md\`.` : '',
    `You own exactly one evidence category, ${inv.category}, through ${inv.source}. Do not query any other source.`,
    a.notes ? `Code anchor notes:\n\n${a.notes}` : '',
  ].filter(Boolean).join('\n\n')
}

phase('Investigate')
log(`Spawning ${args.investigators.length} investigators`)
const raw = await parallel(args.investigators.map(inv => () =>
  agent(investigatorPrompt(inv), { label: `investigator:${inv.category}`, phase: 'Investigate', ...modelOpts(investigatorModel) })))

const findings = []
args.investigators.forEach((inv, i) => {
  if (raw[i]) findings.push({ category: inv.category, source: inv.source, text: raw[i] })
  else skipped.push({ category: inv.category, reason: `${inv.source} investigator did not return, so this category is a gap` })
})

phase('Synthesize')
const answer = await agent([
  `Read \`${refs}/synthesizer-prompt.md\` and \`${refs}/epistemics.md\`. The first is your brief. Follow the epistemics framework exactly. Spot-check citations through the same tools the investigators used. Do not write or edit anything.`,
  `Fill its placeholders with:\n\n${anchorFill}`,
  `{SKIPPED_SOURCES_WITH_REASONS}:\n${skipped.length ? skipped.map(s => `- ${s.category}: ${s.reason}`).join('\n') : 'none'}`,
  `{ALL_INVESTIGATOR_FINDINGS}:\n\n${findings.map(f => `### ${f.category} (${f.source})\n\n${f.text}`).join('\n\n')}`,
  'Return the finished answer in the brief\'s output format.',
].join('\n\n'), { label: 'synthesizer', phase: 'Synthesize', ...modelOpts(synthesizerModel) })

return { answer, consulted: findings.map(f => ({ category: f.category, source: f.source })), skipped }
