#!/usr/bin/env python3
"""Independent bounded admission specification; no source-code translator."""
import argparse
import hashlib
import itertools
import json
import platform
import time
from pathlib import Path
import z3

FLAGS = ["present", "revisionCurrent", "fileCurrent", "exactTask", "exactArgs", "exactCwd", "required", "scopeEvidence"]
MODES = ["observed_pass", "unobserved", "zero_tests", "no_files", "code_failure", "environment_failure"]
MUTANTS = ["drop_revision", "drop_file_hash", "drop_task", "drop_argv", "drop_cwd", "relax_test_evidence", "no_files_as_pass", "drop_required", "drop_code_failure"]


def specification(case, mutant=None):
    fresh = case["present"] and (case["revisionCurrent"] or mutant == "drop_revision") and (case["fileCurrent"] or mutant == "drop_file_hash")
    exact = (case["exactTask"] or mutant == "drop_task") and (case["exactArgs"] or mutant == "drop_argv") and (case["exactCwd"] or mutant == "drop_cwd")
    observed = case["mode"] == "observed_pass" or (mutant == "relax_test_evidence" and case["mode"] in ["unobserved", "zero_tests"]) or (mutant == "no_files_as_pass" and case["mode"] == "no_files")
    blocked = fresh and case["mode"] == "code_failure" and mutant != "drop_code_failure"
    satisfied = fresh and exact and observed
    verified = case["scopeEvidence"] and (not case["required"] or satisfied or mutant == "drop_required")
    return {"blocked": blocked, "verification": None if blocked else "verified" if verified else "unverified", "requiredSatisfied": None if blocked else not case["required"] or satisfied, "currentTestRecords": int(fresh)}


def symbolic(variables, mode, mutant=None):
    fresh = z3.And(variables["present"], z3.BoolVal(True) if mutant == "drop_revision" else variables["revisionCurrent"], z3.BoolVal(True) if mutant == "drop_file_hash" else variables["fileCurrent"])
    exact = z3.And(*[z3.BoolVal(True) if mutant == name else variables[flag] for flag, name in [("exactTask", "drop_task"), ("exactArgs", "drop_argv"), ("exactCwd", "drop_cwd")]])
    observed = z3.Or(mode == 0, z3.And(z3.BoolVal(mutant == "relax_test_evidence"), z3.Or(mode == 1, mode == 2)), z3.And(z3.BoolVal(mutant == "no_files_as_pass"), mode == 3))
    blocked = z3.And(fresh, mode == 4, z3.BoolVal(mutant != "drop_code_failure"))
    satisfied = z3.And(fresh, exact, observed)
    verified = z3.And(variables["scopeEvidence"], z3.Or(z3.Not(variables["required"]), satisfied, z3.BoolVal(mutant == "drop_required")))
    return {"blocked": blocked, "verified": z3.And(z3.Not(blocked), verified), "requiredSatisfied": z3.And(z3.Not(blocked), z3.Or(z3.Not(variables["required"]), satisfied))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise SystemExit("Refusing to overwrite model evidence")
    enum_start = time.perf_counter()
    cases = []
    for index, (flags, mode) in enumerate(itertools.product(itertools.product([False, True], repeat=len(FLAGS)), MODES)):
        case = {"id": f"bounded-{index:04}", **dict(zip(FLAGS, flags)), "mode": mode}
        cases.append({**case, "expected": specification(case)})
    enum_seconds = time.perf_counter() - enum_start
    variables = {flag: z3.Bool(flag) for flag in FLAGS}
    mode = z3.Int("mode")
    base = symbolic(variables, mode)
    domain = z3.And(mode >= 0, mode < len(MODES))
    witnesses = []
    solver_start = time.perf_counter()
    for name in MUTANTS:
        altered = symbolic(variables, mode, name)
        solver = z3.Solver()
        solver.set(timeout=3000, random_seed=0)
        solver.add(domain, z3.Or(*[base[key] != altered[key] for key in base]))
        started = time.perf_counter()
        status = solver.check()
        elapsed = time.perf_counter() - started
        if status != z3.sat:
            raise RuntimeError(f"No witness for {name}: {status}")
        found = solver.model()
        case = {"id": f"witness-{name}", **{flag: z3.is_true(found.eval(var, model_completion=True)) for flag, var in variables.items()}, "mode": MODES[found.eval(mode).as_long()]}
        expected = specification(case)
        mutated = specification(case, name)
        differences = sum(any(specification(item)[key] != specification(item, name)[key] for key in ["blocked", "verification", "requiredSatisfied"]) for item in cases)
        assert expected != mutated and differences
        witnesses.append({"mutant": name, "case": case, "expected": expected, "mutatedExpected": mutated, "solverStatus": str(status), "solverCheckSeconds": elapsed, "exhaustiveDisagreements": differences})
    solver_seconds = time.perf_counter() - solver_start
    # A separately encoded truth table checks the symbolic formula against every
    # scalar bounded expectation. Runtime comparison remains the external oracle.
    equivalence = z3.Solver()
    equivalence.set(timeout=3000, random_seed=0)
    clauses = []
    for key in base:
        positive = []
        for case in cases:
            outcome = case["expected"]
            truth = outcome["blocked"] if key == "blocked" else outcome["verification"] == "verified" if key == "verified" else not outcome["blocked"] and outcome["requiredSatisfied"]
            if truth:
                positive.append(z3.And(*[variables[flag] == case[flag] for flag in FLAGS], mode == MODES.index(case["mode"])))
        clauses.append(base[key] != z3.Or(*positive))
    equivalence.add(domain, z3.Or(*clauses))
    started = time.perf_counter()
    equality_status = equivalence.check()
    equivalence_seconds = time.perf_counter() - started
    assert equality_status == z3.unsat
    result = {"schemaVersion": 1, "purpose": "Bounded admission-state specification, not JavaScript semantics or source-correctness proof", "z3Package": "z3-solver==4.15.4.0", "z3Version": z3.get_full_version(), "python": platform.python_version(), "modelScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "domain": {"flags": FLAGS, "modes": MODES, "combinations": len(cases), "changedPaths": ["value.js"], "requiredInvocation": {"task": "test", "cwd": ".", "args": ["selected.test.js"]}, "scopeEvidence": "Separate current passing build with explicit value.js path; tests alone never grant scope"}, "timing": {"enumerationSeconds": enum_seconds, "witnessSearchAndEnumerationSeconds": solver_seconds, "solverCheckSeconds": sum(w["solverCheckSeconds"] for w in witnesses), "truthTableEquivalenceCheckSeconds": equivalence_seconds, "scope": "Local CPU wall clock, one execution; Python import/startup, runtime fixture work and model calls excluded. No performance superiority claim."}, "truthTableEquivalence": str(equality_status), "cases": cases, "witnesses": witnesses}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"output": str(output), "cases": len(cases), "witnesses": len(witnesses), "truthTableEquivalence": str(equality_status), "timing": result["timing"]}))

if __name__ == "__main__":
    main()
