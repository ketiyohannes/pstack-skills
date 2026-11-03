export const meta = {
  name: 'how',
  description: 'pstack how: read-only explorers cover 2 to 4 angles of a subsystem, then one explainer writes the walkthrough',
  whenToUse: 'Run from the pstack how skill after step 1. The skill rates complexity and picks the angles, this workflow runs steps 2 and 3, and the skill presents the result.',
  phases: [
    { title: 'Explore', detail: 'one read-only explorer per angle' },
    { title: 'Explain', detail: 'one explainer synthesizes every explorer finding' },
  ],
}

const DEFAULT_EXPLORER = { model: 'sonnet', effort: 'medium' }
const DEFAULT_EXPLAINER = { model: 'opus', effort: 'high' }

function need(name) {
  if (args == null || args[name] == null || args[name] === '') {
    throw new Error(`pstack:how needs args.${name}. See skills/how/SKILL.md, section "In Claude Code".`)
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
const refs = `${args.pstackRoot}/skills/how/references`
const complexity = args.complexity === 'complex' ? 'complex' : 'simple'
const angles = Array.isArray(args.angles) ? args.angles : []
if (complexity === 'complex' && (angles.length < 2 || angles.length > 4)) {
  throw new Error('pstack:how needs 2 to 4 args.angles for a complex question.')
}
const explorerModel = (args.models && args.models.explorer) || DEFAULT_EXPLORER
const explainerModel = (args.models && args.models.explainer) || DEFAULT_EXPLAINER
const context = args.context ? `\n\nContext from the conversation:\n${args.context}` : ''

let findings = []
if (complexity === 'complex') {
  phase('Explore')
  const raw = await parallel(angles.map((angle, i) => () =>
    agent(`Read \`${refs}/explorer-prompt.md\`. It is your brief. Fill {QUESTION} with:\n\n${args.question}\n\nFill {EXPLORATION_ANGLE} with:\n\n${angle}${context}\n\nFollow the brief and return its findings.`, {
      label: `explorer-${i + 1}`,
      phase: 'Explore',
      agentType: 'Explore',
      ...modelOpts(explorerModel),
    })))
  findings = raw.map((text, i) => ({ angle: angles[i], text })).filter(f => f.text)
  const missing = angles.length - findings.length
  if (missing) log(`${missing} explorer(s) did not return. The explainer covers those angles itself.`)
}

phase('Explain')
const explainerBrief = complexity === 'complex'
  ? `Read \`${refs}/explainer-prompt.md\`. It is your brief. Fill {QUESTION} with:\n\n${args.question}\n\nFill {EXPLORER_FINDINGS_ALL} with these findings:\n\n${findings.map(f => `### Angle: ${f.angle}\n\n${f.text}`).join('\n\n')}${context}\n\nFollow the brief and return the explanation.`
  : `Read \`${refs}/explainer-prompt.md\`. It is your brief. This is a simple question, so leave out the explorer-findings section and explore the code yourself in the same pass. Fill {QUESTION} with:\n\n${args.question}${context}\n\nFollow the brief and return the explanation.`
const explanation = await agent(explainerBrief, {
  label: 'explainer',
  phase: 'Explain',
  agentType: 'Explore',
  ...modelOpts(explainerModel),
})

return { complexity, angles: findings.map(f => f.angle), explanation }
