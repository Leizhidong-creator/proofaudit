// Lean toolchain integration: the kernel check is the real check.
// Static scans can flag red flags, but only the toolchain can confirm a
// proof is valid. Every function degrades to SKIP with a reason when the
// toolchain (or the project setup) is missing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function versionOf(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
  } catch {
    return null;
  }
}

function detectToolchain() {
  const lean = which('lean');
  const lake = which('lake');
  const elan = which('elan');
  return {
    lean: lean ? { path: lean, version: versionOf('lean') } : null,
    lake: lake ? { path: lake, version: versionOf('lake') } : null,
    elan: elan ? { path: elan, version: versionOf('elan') } : null,
  };
}

function findLakeProject(dir) {
  for (const name of ['lakefile.lean', 'lakefile.toml', 'lean-toolchain']) {
    if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function discoverLibName(dir) {
  const leanFile = path.join(dir, 'lakefile.lean');
  if (fs.existsSync(leanFile)) {
    const text = fs.readFileSync(leanFile, 'utf8');
    const m = /lean_lib\s+([A-Za-z_][\w]*)/.exec(text);
    if (m) return m[1];
  }
  const tomlFile = path.join(dir, 'lakefile.toml');
  if (fs.existsSync(tomlFile)) {
    const text = fs.readFileSync(tomlFile, 'utf8');
    const section = text.split('[[lean_lib]]')[1];
    if (section) {
      const m = /name\s*=\s*"([^"]+)"/.exec(section.split('[[')[0]);
      if (m) return m[1];
    }
  }
  return null;
}

// Run `lake build` in the project dir. This elaborates every proof and the
// kernel checks each one — the strongest single check there is.
function runBuild(dir, timeoutMs) {
  try {
    const r = spawnSync('lake', ['build'], { cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (r.error && r.error.code === 'ETIMEDOUT') return { ran: true, timedOut: true, exitCode: null, output: '' };
    if (r.error) return { ran: false, reason: String(r.error.message || r.error) };
    return { ran: true, timedOut: false, exitCode: r.status, output: (r.stdout || '') + (r.stderr || '') };
  } catch (e) {
    return { ran: false, reason: String(e.message || e) };
  }
}

// Ask the kernel which axioms each named theorem REALLY depends on, by
// generating a probe file that imports the built library and prints them.
// This is the check that matters: declarations can lie, `#print axioms`
// cannot (it reports what the elaborated proof actually uses).
function printAxiomsViaProbe(dir, libName, theoremNames, timeoutMs) {
  const probe = path.join(os.tmpdir(), `proofaudit-axioms-${process.pid}.lean`);
  const lines = [`import ${libName}`];
  for (const t of theoremNames) lines.push(`#print axioms ${t}`);
  fs.writeFileSync(probe, lines.join('\n') + '\n');
  try {
    const r = spawnSync('lake', ['env', 'lean', probe], { cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (r.error && r.error.code === 'ETIMEDOUT') return { ran: true, timedOut: true, results: {} };
    if (r.error) return { ran: false, reason: String(r.error.message || r.error) };
    const out = (r.stdout || '') + (r.stderr || '');
    const results = {};
    for (const t of theoremNames) {
      // Lean prints: 'Foo' depends on axioms [propext, Classical.choice, Quot.sound]
      // or: 'Foo' does not depend on any axioms.
      const re = new RegExp(`'${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^\\n]*?depends on axioms \\[([^\\]]*)\\]`, 's');
      const m = re.exec(out);
      if (m) {
        results[t] = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      } else if (out.includes(`'${t}'`) && /does not depend on any axioms/.test(out)) {
        results[t] = [];
      } else {
        results[t] = null; // could not determine (e.g. unknown constant)
      }
    }
    return { ran: true, timedOut: false, exitCode: r.status, results, raw: out };
  } catch (e) {
    return { ran: false, reason: String(e.message || e) };
  } finally {
    try { fs.unlinkSync(probe); } catch { /* ignore */ }
  }
}

module.exports = { detectToolchain, findLakeProject, discoverLibName, runBuild, printAxiomsViaProbe };
