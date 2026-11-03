export const meta = {
  name: 'reflect',
  description: 'pstack reflect: judgment, tooling, and divergent reviewers mine a transcript in parallel, then a synthesizer returns Accepted, Rejected, and Backlog learnings',
  whenToUse: 'Run from the pstack reflect skill after step 1 locates the transcript. This workflow runs steps 2 and 3. The skill runs the structural check and applies only what the user approves.',
  phases: [
    { title: 'Review', detail: 'three lenses read the same transcript' },
    { title: 'Synthesize', detail: 'one synthesizer routes each learning to a skill edit' },
  ],
}

const DEFAULT_JUDGMENT = { model: 'opus', effort: 'xhigh' }
const DEFAULT_TOOLING = { model: 'sonnet', effort: 'high' }

function modelOpts(m) {
  const opts = {}
  if (m && m.model && m.model !== 'inherit') opts.model = m.model
  if (m && m.effort) opts.effort = m.effort
  return opts
}

if (!args || !args.pstackRoot) throw new Error('pstack:reflect needs args.pstackRoot. See skills/reflect/SKILL.md, section "In Claude Code".')
if (!args.transcriptPath && !args.digest) throw new Error('pstack:reflect needs args.transcriptPath or args.digest.')

const refs = `${args.pstackRoot}/skills/reflect/references`
const judgmentModel = (args.models && args.models.judgment) || DEFAULT_JUDGMENT
const toolingModel = (args.models && args.models.tooling) || DEFAULT_TOOLING
const source = args.transcriptPath
  ? `Replace <ABSOLUTE_PATH> with \`${args.transcriptPath}\` and drop the digest block.`
  : `There is no transcript file. Drop the <ABSOLUTE_PATH> line and replace <DIGEST IF FILE PATH UNAVAILABLE> with:\n\n${args.digest}`

const LENSES = [
  { key: 'judgment', template: 'judgment-reviewer.md', model: judgmentModel },
  { key: 'tooling', template: 'tooling-reviewer.md', model: toolingModel },
  { key: 'divergent', template: 'divergent-reviewer.md', model: judgmentModel },
]

phase('Review')
const reviews = await parallel(LENSES.map(lens => () =>
  agent(`Read \`${refs}/${lens.template}\`. It is your brief, passed verbatim. ${source} Do not edit any file. Return your findings in the format the brief names.`, {
    label: `reviewer:${lens.key}`,
    phase: 'Review',
    ...modelOpts(lens.model),
  })))

const missing = LENSES.filter((_, i) => !reviews[i]).map(l => l.key)
if (missing.length) log(`Reviewer(s) did not return: ${missing.join(', ')}`)

phase('Synthesize')
const fill = LENSES.map((lens, i) => `<${lens.key.toUpperCase()}_OUTPUT>:\n\n${reviews[i] || `The ${lens.key} reviewer did not return.`}`).join('\n\n')
const synthesis = await agent(`Read \`${refs}/synthesizer.md\`. It is your brief, passed verbatim. Spot-verify citations through any tools the transcript references. Do not edit any file. Fill its placeholders with:\n\n${fill}\n\nReturn the Accepted, Rejected, and Backlog list in the format the brief names.`, {
  label: 'synthesizer',
  phase: 'Synthesize',
  ...modelOpts(judgmentModel),
})

return { synthesis, missingReviewers: missing }
