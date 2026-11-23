# proofaudit — Agent Math-Code Audit

**Claude Code can now prove theorems. ProofAudit checks whether the proof is what it claims to be.**

## Why this exists

On 20 November 2026, a mathematician working with Claude released a proof of the
Riemann Hypothesis — one of the seven Millennium Prize Problems, unsolved since 1859.
It did not arrive as a paper. It arrived as Lean code: 175,187 files, about 17.4
million lines, with the author writing that he had tried to write the argument out
in words and it came to more than 250,000 pages.

Within a day, the Lean and Mathlib communities certified that the formal statement
and the machine-checked proof are correct, and MIT's Andrew Sutherland independently
rebuilt the whole thing with zero errors, using only the three standard axioms. At
the same time, no human mathematician has yet understood the argument — Terence Tao
says digesting it will take time, and the author himself says he has not yet mastered
all of the mathematics around it. The Clay Mathematics Institute still lists the
problem as unsolved: its $1 million prize needs a peer-reviewed publication and two
years of scrutiny.

So we are in a new situation, and it is not going away. AI systems will keep
producing formal proofs that no human can read. The bottleneck is no longer
*generating* proofs. It is *auditing* them.

ProofAudit is the audit pipeline for that world. It automates the exact checks the
community actually ran on the Riemann proof — and that any serious reader should run
on any machine-generated proof.

## The three questions every audit must answer

1. **Is it proving the real statement?** A proof is only as good as the statement
   it proves. If the code quietly redefines the problem — its own
   `RiemannHypothesis`, its own `zeta` — then the "proof" proves a look-alike.
   ProofAudit traces where every watched name comes from: defined in this repo, or
   imported from a trusted library like Mathlib? And it compares the proved
   theorem's statement against a reference statement, word for word.
2. **Was anything smuggled in?** A proof that leans on an extra axiom, or on
   `sorry` — Lean's "trust me, this part works" placeholder — is not a proof.
   ProofAudit scans for both, and with `--with-build` it asks the kernel itself
   what the proof really depends on via `#print axioms`. Declarations can lie;
   the kernel cannot.
3. **Is it finished?** Proof size, theorem counts, gaps, and whether the whole
   project actually builds. A `lake build` that exits 0 means every proof was
   elaborated and kernel-checked. Anything else is a draft.

## What it checks

| Check | What it catches | Why it matters |
|---|---|---|
| **Axiom audit** | Extra axioms beyond the three Lean standard ones (`propext`, `Classical.choice`, `Quot.sound`) | An extra axiom is an extra assumption — the proof may be proving something weaker, or nothing at all. |
| **Trust-gap scan** | `sorry`, `admit`, `sorryAx`, plus `native_decide` / `unsafe` flagged for review | `sorry` means "unfinished". A proof full of them is a sketch. |
| **Redefinition scan** | The repo defining its own version of a standard object | The classic way to "prove" a hard theorem: prove an easier look-alike instead. |
| **Name provenance** | Where each watched name comes from — defined locally, imported from Mathlib, or unclear | This is the check that answers the "were the definitions rigged?" question. In the Riemann case the answer was: no — the statement was Mathlib's own, in the library since 2023. |
| **Statement match** | The proved theorem vs. a reference statement (`--theorem` + `--reference`) | Text-level proof that the theorem proved is the theorem claimed. |
| **Kernel check** (`--with-build`) | Runs `lake build` and a `#print axioms` probe with the real toolchain | The strongest check there is. Only the kernel can confirm a proof is valid. |

Verdicts: **PASS** (no red flags), **REVIEW** (nothing failed, needs a human look),
**FAIL** (red flags found). Exit code is 1 on FAIL, so it works in CI. `--json`
output is built for agents to consume.

## Worked example: auditing the Riemann claim

```bash
# 1. Static audit — runs anywhere, no toolchain needed
proofaudit audit ./riemann-hypothesis --preset rh

# 2. Full audit — needs Lean installed (elan) and the project to build.
#    Slow: a full build of 175,187 modules takes hours on many cores.
proofaudit audit ./riemann-hypothesis --preset rh \
  --theorem RiemannHypothesis --with-build
```

The `--preset rh` preset encodes the public facts of the November 2026 claim: the
three standard axioms are the only ones allowed, `RiemannHypothesis` / `zeta` and
related names are watched, and the report quotes the public verification record as
*external evidence* — the Lean & Mathlib certification and Sutherland's rebuild —
labelled as such. ProofAudit quotes that evidence; it does not re-verify it. Only
`--with-build` on your own machine does that.

## Install

```bash
npm install -g proofaudit
# or run from source:
node bin/proofaudit audit <path-to-lean-project>
```

Zero dependencies. Node >= 20.

## Usage

```bash
# Audit any Lean project
proofaudit audit ./my-lean-proof

# Audit with the Riemann Hypothesis preset
proofaudit audit ./riemann-hypothesis --preset rh

# Check the theorem statement against the reference (Mathlib's) statement
proofaudit audit ./riemann-hypothesis --preset rh \
  --theorem RiemannHypothesis --reference ./mathlib-rh-statement.txt

# Feed in `#print axioms` output and get JSON for an agent to consume
proofaudit audit ./riemann-hypothesis --preset rh \
  --axioms-file ./print-axioms.txt --json

# The full kernel check (needs Lean + a lake project; slow)
proofaudit audit ./riemann-hypothesis --preset rh \
  --theorem RiemannHypothesis --with-build --build-timeout 3600
```

## Honest limits

- The static checks run anywhere, but they are **not** a validity proof. Only the
  kernel check (`--with-build`) can confirm a proof is valid — and a full rebuild
  of a proof the size of the Riemann one takes hours on many cores.
- A PASS means "no red flags found by these checks", not "a human mathematician
  has understood the proof." Understanding is still a human job, and for the
  Riemann proof it has not happened yet.
- Statement matching is textual (after normalisation). It catches a redefined
  statement, not a subtly different-but-equivalent one; that judgement still needs
  a mathematician.

## Roadmap

- MCP server, so Claude Code and other agents can call the audit directly.
- Kernel replay via `leanchecker` for projects without a full `lake build`.
- More presets (other Millennium Problems, common Mathlib statements).

## License

MIT
