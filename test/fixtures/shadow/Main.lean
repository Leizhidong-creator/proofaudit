-- A repo that defines its own version of a standard object.
-- If a proof redefines RiemannHypothesis, the "proof" may prove
-- something else entirely. This is the check that catches it.
def RiemannHypothesis : Prop := True

theorem fake_rh : RiemannHypothesis := trivial
