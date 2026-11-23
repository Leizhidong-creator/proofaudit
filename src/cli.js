// proofaudit — agent math-code audit CLI.
// Usage: proofaudit audit <path> [--preset rh] [--theorem NAME] [--reference FILE]
//        [--axioms-file FILE] [--json] [--md FILE] [--evidence FILE]
const fs = require('fs');
const path = require('path');
const checks = require('./checks');
const report = require('./report');
const toolchain = require('./toolchain');

const VERSION = '0.2.0';

function help() {
  return `proofaudit ${VERSION} — agent math-code audit

Check whether a formal proof is what it claims to be: axioms, gaps,
redefinitions, name provenance, and statement match — plus, with
--with-build, the Lean kernel itself.

Static checks run anywhere with no toolchain. The kernel check needs
Lean installed (elan) and a lake project; it is the strongest check
there is, and the only one that can confirm a proof is valid.

Usage:
  proofaudit audit <path> [options]

Options:
  --preset <name>      Load a preset (currently: rh)
  --theorem <name>     Theorem to match against the reference statement
                       (also used for the \`#print axioms\` probe)
  --reference <file>   File holding the reference statement text
  --axioms-file <file> One axiom name per line, e.g. pasted \`#print axioms\` output
  --evidence <file>    JSON list of external evidence strings to quote in the report
  --with-build         Run \`lake build\` and a \`#print axioms\` probe with the
                       real toolchain (slow — full builds can take a long time)
  --build-timeout <s>  Timeout in seconds for each toolchain step (default 600)
  --json               Print the report as JSON (for agents)
  --md <file>          Also write the Markdown report to <file>
  --help               Show this help

Exit code: 0 when verdict is PASS or REVIEW, 1 when FAIL.

Presets:
  rh   The November 2026 Riemann Hypothesis claim: allowed axioms are the
       three Lean standard axioms; watches for redefinitions of the
       Riemann Hypothesis / zeta objects; points at the public
       verification record as external evidence.
`;
}

function parseArgs(argv) {
  const args = { positionals: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.flags.help = true;
    else if (a === '--json') args.flags.json = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      args.flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else args.positionals.push(a);
  }
  return args;
}

function loadPreset(name) {
  const file = path.join(__dirname, 'presets', `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Unknown preset: ${name}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positionals.length === 0) {
    console.log(help());
    process.exit(positionals.length === 0 && !flags.help ? 1 : 0);
  }
  if (positionals[0] !== 'audit') {
    console.error(`Unknown command: ${positionals[0]}\n${help()}`);
    process.exit(1);
  }
  const target = positionals[1];
  if (!target || !fs.existsSync(target)) {
    console.error(`Target not found: ${target}`);
    process.exit(1);
  }

  let preset = null;
  if (flags.preset) preset = loadPreset(String(flags.preset));

  const files = checks.collectLeanFiles(target);
  const docs = checks.readFiles(files);

  const allowedAxioms = preset ? preset.allowedAxioms : checks.STANDARD_AXIOMS;
  const watchlist = preset ? preset.watchlist : [];
  const axiomsFileText = flags['axioms-file'] ? fs.readFileSync(String(flags['axioms-file']), 'utf8') : null;
  const referenceText = flags.reference ? fs.readFileSync(String(flags.reference), 'utf8') : null;

  const results = [
    checks.checkAxioms(docs, allowedAxioms, axiomsFileText),
    checks.checkGaps(docs),
    checks.checkShadowing(docs, watchlist),
    checks.checkProvenance(docs, watchlist),
    checks.checkStatement(docs, flags.theorem ? String(flags.theorem) : null, referenceText),
  ];

  // --with-build: the kernel check. Runs `lake build` and, when a theorem
  // name is given, a `#print axioms` probe against the built library.
  // Kernel results override the static axiom check: what the elaborated
  // proof actually depends on beats what the source declares.
  let toolchainInfo = null;
  if (flags['with-build']) {
    const detected = toolchain.detectToolchain();
    toolchainInfo = {
      available: Boolean(detected.lean && detected.lake),
      leanVersion: detected.lean ? detected.lean.version : null,
      lakeVersion: detected.lake ? detected.lake.version : null,
      reason: !detected.lean && !detected.lake
        ? 'neither lean nor lake found on PATH'
        : !detected.lake ? 'lake not found on PATH' : null,
    };
    if (toolchainInfo.available) {
      const timeoutMs = (Number(flags['build-timeout']) || 600) * 1000;
      const absTarget = path.resolve(target);
      const lakeProject = toolchain.findLakeProject(absTarget);
      if (!lakeProject) {
        toolchainInfo.build = { ran: false, reason: 'no lakefile found in the target directory' };
      } else {
        const build = toolchain.runBuild(absTarget, timeoutMs);
        toolchainInfo.build = build;
        if (build.ran && build.exitCode === 0) {
          if (flags.theorem) {
            const libName = toolchain.discoverLibName(absTarget);
            if (!libName) {
              toolchainInfo.axiomsProbe = { ran: false, reason: 'could not discover the library name from the lakefile' };
            } else {
              const probe = toolchain.printAxiomsViaProbe(absTarget, libName, [String(flags.theorem)], timeoutMs);
              toolchainInfo.axiomsProbe = probe;
              if (probe.ran && probe.results[String(flags.theorem)]) {
                const kernelAxioms = probe.results[String(flags.theorem)];
                const extra = kernelAxioms.filter((a) => !new Set(allowedAxioms).has(a));
                const axiomCheck = results.find((c) => c.id === 'axioms');
                axiomCheck.details.kernelAxioms = kernelAxioms;
                if (extra.length) {
                  axiomCheck.status = 'FAIL';
                  axiomCheck.summary = `Kernel says the proof really depends on non-standard axiom(s): ${extra.join(', ')}.`;
                  axiomCheck.details.extraUsed = extra;
                } else {
                  axiomCheck.summary = `Kernel confirms: depends only on the standard axioms [${kernelAxioms.join(', ') || 'none'}].`;
                }
              }
            }
          }
        }
      }
    }
  }

  const verdict = checks.overallVerdict(results);
  const verdictNote = {
    PASS: 'no red flags found by these checks.',
    REVIEW: 'nothing failed, but some items need a human look.',
    FAIL: 'red flags found — see the failing checks.',
  }[verdict];

  let evidence = preset ? [...(preset.evidence || [])] : [];
  if (flags.evidence) {
    const extra = JSON.parse(fs.readFileSync(String(flags.evidence), 'utf8'));
    evidence = evidence.concat(extra);
  }

  const result = {
    tool: 'proofaudit',
    version: VERSION,
    target: path.resolve(target),
    preset: preset ? preset.name : null,
    files: files.length,
    metrics: checks.proofMetrics(docs),
    toolchain: toolchainInfo,
    verdict,
    verdictNote,
    checks: results,
    evidence,
  };

  if (flags.json) {
    console.log(report.toJSON(result));
  } else {
    console.log(report.toMarkdown(result));
  }
  if (flags.md) fs.writeFileSync(String(flags.md), report.toMarkdown(result));
  process.exit(verdict === 'FAIL' ? 1 : 0);
}

main();
