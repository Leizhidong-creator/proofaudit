// Report formatting: Markdown for humans, JSON for agents.
function verdictEmoji(status) {
  return { PASS: '✅', FAIL: '❌', REVIEW: '⚠️', SKIP: '⏭️' }[status] || status;
}

function toMarkdown(result) {
  const lines = [];
  lines.push(`# ProofAudit report — ${result.target}`);
  lines.push('');
  lines.push(`**Overall verdict: ${verdictEmoji(result.verdict)} ${result.verdict}** — ${result.verdictNote}`);
  lines.push('');
  lines.push(`Checked ${result.files} Lean file(s)${result.preset ? ` · preset: ${result.preset}` : ''}.`);
  lines.push('');
  if (result.metrics) {
    const m = result.metrics;
    lines.push(`**Proof size:** ${m.files} file(s), ${m.lines} lines, ${m.theorems} theorem(s)/lemma(s), ${m.defs} definition(s), ${m.sorries} sorry(ies), ${m.axiomsDeclared} axiom declaration(s).`);
    lines.push('');
  }
  if (result.toolchain) {
    lines.push('## Toolchain (kernel check)');
    const t = result.toolchain;
    if (!t.available) {
      lines.push(`- Lean toolchain not found (${t.reason}). Install Lean with elan and re-run with \`--with-build\` for the kernel check.`);
    } else {
      lines.push(`- Lean ${t.leanVersion || 'found'} · lake ${t.lakeVersion || 'found'}`);
      if (t.build) {
        if (!t.build.ran) lines.push(`- \`lake build\` did not run: ${t.build.reason}`);
        else if (t.build.timedOut) lines.push('- `lake build` timed out — the kernel check did not finish.');
        else lines.push(`- \`lake build\`: ${t.build.exitCode === 0 ? '✅ PASS (exit 0 — every proof elaborated and kernel-checked)' : `❌ FAIL (exit ${t.build.exitCode})`}`);
      }
      if (t.axiomsProbe) {
        if (!t.axiomsProbe.ran) lines.push(`- \`#print axioms\` probe did not run: ${t.axiomsProbe.reason}`);
        else {
          for (const [name, axioms] of Object.entries(t.axiomsProbe.results)) {
            if (axioms === null) lines.push(`- \`#print axioms ${name}\`: could not determine (unknown constant or probe error).`);
            else lines.push(`- \`#print axioms ${name}\`: depends on [${axioms.join(', ') || 'none'}]`);
          }
        }
      }
    }
    lines.push('');
  }
  lines.push('| Check | Result | Summary |');
  lines.push('|---|---|---|');
  for (const c of result.checks) {
    lines.push(`| ${c.title} | ${verdictEmoji(c.status)} ${c.status} | ${c.summary.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  for (const c of result.checks) {
    if (c.id === 'gaps' && c.details.found.length) {
      lines.push(`## ${c.title} — details`);
      for (const f of c.details.found) lines.push(`- ${f.severity} \`${f.kind}\` — ${f.file}:${f.line} (${f.note})`);
      lines.push('');
    }
    if (c.id === 'axioms' && (c.details.extraDeclared.length || c.details.extraUsed.length)) {
      lines.push(`## ${c.title} — details`);
      for (const d of c.details.extraDeclared) lines.push(`- declared non-standard axiom \`${d.axiom}\` — ${d.file}:${d.line}`);
      for (const a of c.details.extraUsed) lines.push(`- used non-standard axiom \`${a}\` (from --axioms-file)`);
      lines.push('');
    }
    if (c.id === 'shadowing' && c.details.hits.length) {
      lines.push(`## ${c.title} — details`);
      for (const h of c.details.hits) lines.push(`- \`${h.name}\` (${h.kind}) — ${h.file}:${h.line}`);
      lines.push('');
    }
    if (c.id === 'statement' && c.status === 'FAIL' && c.details.statement) {
      lines.push(`## ${c.title} — details`);
      lines.push(`- proved: \`${c.details.statement}\``);
      lines.push(`- reference: \`${c.details.reference}\``);
      lines.push('');
    }
  }
  if (result.evidence && result.evidence.length) {
    lines.push('## External evidence (not re-verified locally)');
    for (const e of result.evidence) lines.push(`- ${e}`);
    lines.push('');
  }
  if (result.checks.some((c) => c.id === 'provenance' && c.details.names && c.details.names.length)) {
    const p = result.checks.find((c) => c.id === 'provenance');
    lines.push('## Name provenance — details');
    for (const n of p.details.names) lines.push(`- \`${n.name}\` — ${n.origin}: ${n.note}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('_ProofAudit audits the code and the evidence. It does not re-run the Lean kernel; a PASS here means "no red flags found by these checks", not "a human mathematician has understood the proof."_');
  return lines.join('\n');
}

function toJSON(result) {
  return JSON.stringify(result, null, 2);
}

module.exports = { toMarkdown, toJSON };
