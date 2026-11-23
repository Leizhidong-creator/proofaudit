// Static checks over Lean source files. No Lean toolchain needed:
// proofaudit audits the code and the evidence, it does not re-run the kernel.
const fs = require('fs');
const path = require('path');

function collectLeanFiles(target) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.lake' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.lean')) {
        files.push(full);
      }
    }
  };
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  walk(target);
  return files.sort();
}

function readFiles(files) {
  return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

function stripComments(text) {
  return text
    .replace(new RegExp('/-([\\s\\S]*?)-/', 'g'), '')
    .replace(/--[^\n]*/g, '');
}

// --- Check 1: axioms -------------------------------------------------------
const AXIOM_DECL = /^\s*axiom\s+([A-Za-z_][\w'.]*)/gm;
const STANDARD_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'];

function checkAxioms(docs, allowedAxioms, axiomsFileText) {
  const declared = [];
  for (const { file, text } of docs) {
    const clean = stripComments(text);
    let m;
    while ((m = AXIOM_DECL.exec(clean)) !== null) {
      declared.push({ axiom: m[1], file, line: clean.slice(0, m.index).split('\n').length });
    }
  }
  // --axioms-file: one axiom name per line, e.g. pasted `#print axioms` output.
  const used = axiomsFileText
    ? axiomsFileText.split('\n').map((s) => s.trim()).filter((s) => /^[A-Za-z_][\w'.]*$/.test(s))
    : [];
  const allowed = new Set(allowedAxioms || STANDARD_AXIOMS);
  const extraDeclared = declared.filter((d) => !allowed.has(d.axiom));
  const extraUsed = used.filter((a) => !allowed.has(a));
  const status = extraDeclared.length || extraUsed.length ? 'FAIL' : 'PASS';
  return {
    id: 'axioms',
    title: 'Axiom audit',
    status,
    summary:
      status === 'PASS'
        ? `No non-standard axioms. Declared: ${declared.length}. ${used.length ? `Used (from --axioms-file): ${used.length}, all standard.` : 'No --axioms-file given, so only declarations were checked.'}`
        : `Non-standard axioms found: ${[...extraDeclared.map((d) => d.axiom), ...extraUsed].join(', ')}`,
    details: { declared, used, extraDeclared, extraUsed },
  };
}

// --- Check 2: gaps (sorry / admit / native_decide / unsafe) ----------------
const GAP_PATTERNS = [
  { kind: 'sorry', re: /\bsorry\b/g, severity: 'FAIL', note: 'unfinished proof placeholder' },
  { kind: 'admit', re: /\badmit\b/g, severity: 'FAIL', note: 'unfinished proof placeholder' },
  { kind: 'sorryAx', re: /\bsorryAx\b/g, severity: 'FAIL', note: 'axiom injected by sorry' },
  { kind: 'native_decide', re: /\bnative_decide\b/g, severity: 'REVIEW', note: 'trusts compiled code; legitimate but worth a second look' },
  { kind: 'unsafe', re: /^\s*unsafe\s+(def|theorem|instance)\b/gm, severity: 'REVIEW', note: 'unsafe declaration bypasses the checker in places' },
];

function checkGaps(docs) {
  const found = [];
  for (const { file, text } of docs) {
    const clean = stripComments(text);
    for (const p of GAP_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(clean)) !== null) {
        found.push({ kind: p.kind, severity: p.severity, note: p.note, file, line: clean.slice(0, m.index).split('\n').length });
      }
    }
  }
  const fails = found.filter((f) => f.severity === 'FAIL');
  const status = fails.length ? 'FAIL' : found.length ? 'REVIEW' : 'PASS';
  return {
    id: 'gaps',
    title: 'Trust-gap scan',
    status,
    summary:
      status === 'PASS'
        ? 'No sorry / admit / sorryAx found.'
        : `${fails.length} hard gap(s), ${found.length - fails.length} item(s) to review.`,
    details: { found },
  };
}

// --- Check 3: shadowing of standard names ----------------------------------
const DEF_DECL = /^\s*(def|theorem|lemma|abbrev|instance|structure|class)\s+([A-Za-z_][\w'.]*)/gm;

function checkShadowing(docs, watchlist) {
  const list = watchlist || [];
  const hits = [];
  for (const { file, text } of docs) {
    const clean = stripComments(text);
    let m;
    while ((m = DEF_DECL.exec(clean)) !== null) {
      const name = m[2];
      const short = name.split('.').pop();
      if (list.includes(name) || list.includes(short)) {
        hits.push({ name, kind: m[1], file, line: clean.slice(0, m.index).split('\n').length });
      }
    }
  }
  return {
    id: 'shadowing',
    title: 'Redefinition / shadowing scan',
    status: hits.length ? 'REVIEW' : 'PASS',
    summary: hits.length
      ? `This repo defines its own version of standard object(s): ${hits.map((h) => h.name).join(', ')}. Verify the definition matches the standard one.`
      : 'No watched standard name is redefined in this repo.',
    details: { hits },
  };
}

// --- Check 4: statement match ----------------------------------------------
function normalizeStatement(text) {
  return stripComments(text).replace(/\s+/g, ' ').trim();
}

function extractTheoremStatement(text, theoremName) {
  const re = new RegExp(`\\btheorem\\s+${theoremName}\\b\\s*([\\s\\S]*?)(?::=|\\bby\\b)`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  // The statement is everything up to the proof: binders + colon + type.
  // Binders may themselves contain ':' (e.g. (a b : Nat)), so take the
  // LAST colon before the proof — the one that introduces the type.
  const head = m[0].replace(/\s*(?::=|\bby\b)\s*$/, '');
  const colon = head.lastIndexOf(':');
  if (colon === -1) return null;
  return normalizeStatement(head.slice(colon + 1));
}

function checkStatement(docs, theoremName, referenceText) {
  if (!theoremName || !referenceText) {
    return {
      id: 'statement',
      title: 'Statement match',
      status: 'SKIP',
      summary: 'Skipped: needs --theorem <name> and --reference <file>.',
      details: {},
    };
  }
  const reference = normalizeStatement(referenceText);
  let found = null;
  for (const { file, text } of docs) {
    const stmt = extractTheoremStatement(text, theoremName);
    if (stmt !== null) { found = { file, statement: stmt }; break; }
  }
  if (!found) {
    return { id: 'statement', title: 'Statement match', status: 'FAIL', summary: `Theorem "${theoremName}" not found in the audited files.`, details: {} };
  }
  const match = found.statement === reference;
  return {
    id: 'statement',
    title: 'Statement match',
    status: match ? 'PASS' : 'FAIL',
    summary: match
      ? `Theorem "${theoremName}" matches the reference statement exactly (after normalisation).`
      : `Theorem "${theoremName}" does NOT match the reference statement. This is the check that catches a redefined problem.`,
    details: { file: found.file, statement: found.statement, reference },
  };
}

function overallVerdict(checks) {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'REVIEW')) return 'REVIEW';
  return 'PASS';
}

// --- Check 5: name provenance ----------------------------------------------
// The question that decides whether a proof is about the real thing:
// where does each watched name COME from? Defined in this repo (red flag —
// the author may have proved a look-alike statement) or imported from a
// trusted library such as Mathlib (good — the standard object)?
const IMPORT_DECL = /^\s*import\s+([A-Za-z_][\w.]*)/gm;

function checkProvenance(docs, watchlist) {
  const list = watchlist || [];
  if (!list.length) {
    return { id: 'provenance', title: 'Name provenance', status: 'SKIP', summary: 'Skipped: no watchlist (use --preset rh or supply one).', details: { names: [] } };
  }
  const imports = new Set();
  const defined = new Map(); // short name -> {name, file, line}
  const referenced = new Set();
  for (const { file, text } of docs) {
    const clean = stripComments(text);
    let m;
    IMPORT_DECL.lastIndex = 0;
    while ((m = IMPORT_DECL.exec(clean)) !== null) imports.add(m[1]);
    DEF_DECL.lastIndex = 0;
    while ((m = DEF_DECL.exec(clean)) !== null) {
      defined.set(m[2].split('.').pop(), { name: m[2], kind: m[1], file, line: clean.slice(0, m.index).split('\n').length });
    }
    for (const name of list) {
      if (new RegExp(`\\b${name}\\b`).test(clean)) referenced.add(name);
    }
  }
  const hasMathlib = [...imports].some((i) => i === 'Mathlib' || i.startsWith('Mathlib.'));
  const names = [];
  for (const name of [...referenced].sort()) {
    if (defined.has(name)) {
      const d = defined.get(name);
      names.push({ name, origin: 'defined-locally', status: 'REVIEW', file: d.file, line: d.line, note: `This repo defines its own "${name}". A proof about it proves the local definition, not necessarily the standard object.` });
    } else if (hasMathlib) {
      names.push({ name, origin: 'imported-mathlib', status: 'PASS', note: `"${name}" is not defined here and Mathlib is imported — it resolves to the shared library definition.` });
    } else {
      names.push({ name, origin: 'unknown', status: 'REVIEW', note: `"${name}" is used but neither defined here nor imported from Mathlib — its origin needs checking.` });
    }
  }
  const review = names.filter((n) => n.status === 'REVIEW');
  return {
    id: 'provenance',
    title: 'Name provenance',
    status: review.length ? 'REVIEW' : 'PASS',
    summary: names.length
      ? review.length
        ? `${review.length} watched name(s) need origin checks: ${review.map((n) => n.name).join(', ')}.`
        : `All ${names.length} watched name(s) resolve to imports, none redefined locally.`
      : 'No watched names are referenced in this repo.',
    details: { names, imports: [...imports].sort() },
  };
}

// --- Proof metrics -----------------------------------------------------------
function proofMetrics(docs) {
  let lines = 0, theorems = 0, defs = 0, sorries = 0, axiomsDeclared = 0;
  for (const { text } of docs) {
    const clean = stripComments(text);
    lines += clean.split('\n').length;
    theorems += (clean.match(/^\s*theorem\s+/gm) || []).length + (clean.match(/^\s*lemma\s+/gm) || []).length;
    defs += (clean.match(/^\s*def\s+/gm) || []).length;
    sorries += (clean.match(/\bsorry\b/g) || []).length;
    axiomsDeclared += (clean.match(/^\s*axiom\s+/gm) || []).length;
  }
  return { files: docs.length, lines, theorems, defs, sorries, axiomsDeclared };
}

module.exports = {
  collectLeanFiles,
  readFiles,
  checkAxioms,
  checkGaps,
  checkShadowing,
  checkStatement,
  checkProvenance,
  proofMetrics,
  overallVerdict,
  STANDARD_AXIOMS,
};
