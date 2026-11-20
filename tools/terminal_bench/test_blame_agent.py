import json
import shlex
import tempfile
import unittest
from pathlib import Path

from harbor.models.agent.context import AgentContext

from tools.terminal_bench.blame_agent import BlameAgent


class RunCommandTests(unittest.TestCase):
    def agent(self, extra_env=None):
        return BlameAgent(logs_dir=Path("/tmp/benchmark-adapter-test"), extra_env=extra_env or {})

    def test_runs_the_headless_runner_and_preserves_quoted_paths(self):
        command = shlex.split(self.agent()._run_command("/logs/a 'b.md"))
        self.assertIn("blame-headless", command)
        self.assertNotIn("--harness", command)
        self.assertEqual(command[command.index("--instruction-file") + 1], "/logs/a 'b.md")

    def test_isolation_is_only_forwarded_when_explicitly_configured(self):
        self.assertNotIn("BLAME_ISOLATED_ENVIRONMENT", self.agent()._optional_runtime_environment())
        agent = self.agent({"BLAME_ISOLATED_ENVIRONMENT": "true"})
        self.assertEqual(agent._optional_runtime_environment()["BLAME_ISOLATED_ENVIRONMENT"], "true")


class UsageRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.agent = BlameAgent(logs_dir=self.root)

    def context(self):
        context = AgentContext()
        self.agent.populate_context_post_run(context)
        return context

    def events(self, usages):
        lines = [json.dumps({"event": {"type": "usage", "payload": {"usage": usage}}})
                 for usage in usages]
        (self.root / "events.jsonl").write_text("\n".join(lines) + '\n{"event":')

    def test_timeout_recovers_observed_usage_without_double_counting_totals(self):
        self.events([
            {"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 50,
             "cost": 0.01, "totalInputTokens": 100},
            {"inputTokens": 120, "outputTokens": 30, "cacheReadTokens": 80,
             "cost": 0.02, "totalInputTokens": 220},
        ])
        context = self.context()
        self.assertEqual(context.n_input_tokens, 220)
        self.assertEqual(context.n_output_tokens, 50)
        self.assertEqual(context.n_cache_tokens, 130)
        self.assertAlmostEqual(context.cost_usd, 0.03)
        self.assertTrue(context.metadata["blame_usage_partial"])

    def test_final_aggregate_remains_authoritative(self):
        self.events([{"inputTokens": 10}])
        (self.root / "result.json").write_text(json.dumps({
            "status": "succeeded", "usage": {"aggregateUsage": {
                "totalInputTokens": 999, "totalOutputTokens": 80, "totalCost": 0.0,
            }},
        }))
        context = self.context()
        self.assertEqual(context.n_input_tokens, 999)
        self.assertEqual(context.cost_usd, 0)
        self.assertFalse(context.metadata["blame_usage_partial"])

    def test_missing_usage_stays_unknown(self):
        self.assertTrue(self.context().is_empty())
        self.events([{"inputTokens": 100}, {"inputTokens": 20}])
        context = self.context()
        self.assertEqual(context.n_input_tokens, 120)
        self.assertIsNone(context.n_output_tokens)
        self.assertIsNone(context.cost_usd)

    def test_partial_result_falls_back_to_events(self):
        (self.root / "result.json").write_text('{"usage":')
        self.events([{"inputTokens": 75, "outputTokens": 5}])
        self.assertEqual(self.context().n_input_tokens, 75)

    def test_unicode_line_separators_preserve_usage_records(self):
        event = {"event": {"type": "usage", "payload": {
            "usage": {"inputTokens": 75, "outputTokens": 5,
                      "cacheReadTokens": 50, "cost": 0.01},
            "diagnostic": "first\u0085second\u2028third\u2029last",
        }}}
        (self.root / "events.jsonl").write_text(
            json.dumps(event, ensure_ascii=False) + "\n")
        context = self.context()
        self.assertEqual(context.n_input_tokens, 75)
        self.assertEqual(context.n_output_tokens, 5)
        self.assertEqual(context.n_cache_tokens, 50)
        self.assertEqual(context.cost_usd, 0.01)

    def test_failed_run_marks_interrupted_generation_usage_as_partial(self):
        (self.root / "result.json").write_text(json.dumps({
            "status": "failed", "usage": {"aggregateUsage": {"totalInputTokens": 75}},
        }))
        context = self.context()
        self.assertEqual(context.n_input_tokens, 75)
        self.assertTrue(context.metadata["blame_usage_partial"])


if __name__ == "__main__":
    unittest.main()
