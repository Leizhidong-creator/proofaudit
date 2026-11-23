// Self-test: run the CLI against the fixtures and assert verdicts.
// Usage: node test/selftest.js
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BIN = path.join(__dirname, '..', 'bin', 'proofaudit');
const FIX = path.join(__dirname, 'fixtures');

let failures = 0;
function run(args) {
  try {
    const out = execFileSync('node', [BIN, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
function expect(name, args, code, verdict) {
  const r = run(args);
  const ok = r.code === code && r.out.includes(`**Overall verdict: ${verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : '⚠️'} ${verdict}**`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (exit ${r.code}, verdict ${verdict})`);
  if (!ok) { failures++; console.log(r.out.slice(0, 800)); }
}

// 1. Clean proof + matching reference statement -> PASS, exit 0
expect('clean + matching statement', ['audit', `${FIX}/clean`, '--theorem', 'add_comm_demo', '--reference', `${FIX}/clean/reference.txt`], 0, 'PASS');

// 2. Clean proof + wrong reference statement -> FAIL, exit 1
fs.writeFileSync(`${FIX}/clean/wrong-reference.txt`, 'a + b = b\n');
expect('clean + wrong statement', ['audit', `${FIX}/clean`, '--theorem', 'add_comm_demo', '--reference', `${FIX}/clean/wrong-reference.txt`], 1, 'FAIL');

// 3. sorry -> FAIL, exit 1
expect('sorry is caught', ['audit', `${FIX}/with-sorry`], 1, 'FAIL');

// 4. extra axiom -> FAIL, exit 1
expect('extra axiom is caught', ['audit', `${FIX}/with-axiom`], 1, 'FAIL');

// 5. shadowing a standard name under the rh preset -> REVIEW, exit 0
expect('redefined RiemannHypothesis is flagged', ['audit', `${FIX}/shadow`, '--preset', 'rh'], 0, 'REVIEW');

// 6. clean proof under the rh preset -> PASS, exit 0
expect('clean under rh preset', ['audit', `${FIX}/clean`, '--preset', 'rh'], 0, 'PASS');

// 7. --json output parses
const j = run(['audit', `${FIX}/clean`, '--json']);
let parsed = null;
try { parsed = JSON.parse(j.out); } catch { /* ignore */ }
const okJson = parsed && parsed.verdict === 'PASS' && parsed.tool === 'proofaudit';
console.log(`${okJson ? 'PASS' : 'FAIL'}  --json output parses`);
if (!okJson) failures++;

// 8. Provenance: name imported from Mathlib, not defined locally -> PASS
{
  const r = run(['audit', `${FIX}/provenance-imported`, '--preset', 'rh', '--json']);
  let p = null;
  try { p = JSON.parse(r.out); } catch { /* ignore */ }
  const prov = p && p.checks.find((c) => c.id === 'provenance');
  const ok = p && prov && prov.status === 'PASS' && p.verdict === 'PASS';
  console.log(`${ok ? 'PASS' : 'FAIL'}  provenance: imported name resolves via Mathlib`);
  if (!ok) { failures++; console.log(r.out.slice(0, 600)); }
}

// 9. Provenance: name defined locally -> REVIEW with origin detail
{
  const r = run(['audit', `${FIX}/shadow`, '--preset', 'rh', '--json']);
  let p = null;
  try { p = JSON.parse(r.out); } catch { /* ignore */ }
  const prov = p && p.checks.find((c) => c.id === 'provenance');
  const ok = p && prov && prov.status === 'REVIEW' && prov.details.names[0].origin === 'defined-locally';
  console.log(`${ok ? 'PASS' : 'FAIL'}  provenance: locally defined name flagged with origin`);
  if (!ok) { failures++; console.log(r.out.slice(0, 600)); }
}

// 10. Metrics are reported
{
  const r = run(['audit', `${FIX}/clean`, '--json']);
  let p = null;
  try { p = JSON.parse(r.out); } catch { /* ignore */ }
  const ok = p && p.metrics && p.metrics.files === 1 && p.metrics.theorems === 1 && p.metrics.sorries === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  metrics reported (1 file, 1 theorem, 0 sorries)`);
  if (!ok) { failures++; console.log(r.out.slice(0, 600)); }
}

// 11. --with-build without a toolchain degrades to SKIP, verdict unaffected
{
  const r = run(['audit', `${FIX}/clean`, '--with-build']);
  const ok = r.code === 0 && r.out.includes('Lean toolchain not found') && r.out.includes('**Overall verdict: ✅ PASS**');
  console.log(`${ok ? 'PASS' : 'FAIL'}  --with-build without toolchain degrades gracefully`);
  if (!ok) { failures++; console.log(r.out.slice(0, 800)); }
}

console.log(failures === 0 ? '\nAll self-tests passed.' : `\n${failures} self-test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
