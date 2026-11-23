-- Demo fixture: a deliberately flawed "proof" of the Riemann Hypothesis.
-- It shows everything proofaudit is built to catch. DO NOT use as a real proof.
import Mathlib

-- A made-up axiom the proof secretly leans on.
axiom magicStep : True

-- The repo's OWN RiemannHypothesis, shadowing Mathlib's standard one.
def RiemannHypothesis : Prop := True

theorem demo_rh : RiemannHypothesis := by
  trivial

theorem demo_gap : 1 + 1 = 2 := by
  sorry
