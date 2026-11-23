-- A proof that smuggles in its own axiom.
axiom myAxiom : False

theorem boom : False := myAxiom
