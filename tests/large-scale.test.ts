import test from "node:test";
import assert from "node:assert/strict";
import {
  runLargeScaleBenchmark,
  HEAVY_SKILLS,
  HEAVY_FILES,
  REJECTED_SKILLS,
  REJECTED_FILES,
  RETAINED_SKILLS,
  RETAINED_FILES,
} from "./large-scale.benchmark.js";

test("Large-Scale Benchmark & Stress Test: 100 turns, 15 heavy sources, selective eviction, prefix-cache preservation, and sub-5ms latency", async () => {
  const result = await runLargeScaleBenchmark({ totalTurns: 100 });

  // 1. Verify Scale & Sources
  assert.equal(result.turnsTested, 100);
  assert.equal(result.sourcesLoaded.skills, 5);
  assert.equal(result.sourcesLoaded.files, 10);
  assert.equal(result.sourcesLoaded.total, 15);
  assert.equal(result.sourcesEvicted.skills, 3);
  assert.equal(result.sourcesEvicted.files, 5);
  assert.equal(result.sourcesEvicted.total, 8);
  assert.equal(result.sourcesRetained.skills, 2);
  assert.equal(result.sourcesRetained.files, 5);
  assert.equal(result.sourcesRetained.total, 7);

  // 2. Verify Context Size Before Eviction (> 50,000 chars / ~12,500+ tokens)
  assert.ok(
    result.beforeEviction.totalChars >= 50000,
    `Expected >= 50,000 chars before eviction, got ${result.beforeEviction.totalChars}`
  );
  assert.ok(
    result.beforeEviction.estimatedTokens >= 12500,
    `Expected >= 12,500 tokens before eviction, got ${result.beforeEviction.estimatedTokens}`
  );

  // 3. Verify Substantial Net Reduction
  assert.ok(
    result.netSavings.charsSaved > 30000,
    `Expected > 30,000 chars saved, got ${result.netSavings.charsSaved}`
  );
  assert.ok(
    result.netSavings.tokensSaved > 7500,
    `Expected > 7,500 tokens saved, got ${result.netSavings.tokensSaved}`
  );
  assert.ok(
    result.netSavings.percentageReduction > 40,
    `Expected > 40% reduction, got ${result.netSavings.percentageReduction.toFixed(2)}%`
  );

  // 4. Verify Prefix-Cache Preservation
  // All messages before firstEvictionIndex must maintain strict === object identity
  assert.equal(
    result.prefixCachePreservation.prefixObjectIdentityPreserved,
    true,
    "Prefix messages before the first eviction index must maintain exact === object identity"
  );
  assert.ok(
    result.prefixCachePreservation.firstEvictionIndex > 0,
    "firstEvictionIndex must be greater than 0"
  );

  // System prompt must maintain byte-identical determinism
  assert.equal(
    result.prefixCachePreservation.systemPromptPreserved,
    true,
    "System instruction must be preserved byte-identically across turns"
  );

  // Retained skills and files must be 100% byte-identical
  assert.equal(
    result.prefixCachePreservation.retainedMessagesByteIdentical,
    true,
    "All non-evicted skills and files must remain byte-identical"
  );

  // 5. Verify Latency (< 5ms per turn)
  assert.ok(
    result.latency.averageTurnLatencyMs < 5.0,
    `Expected average latency < 5ms, got ${result.latency.averageTurnLatencyMs.toFixed(3)}ms`
  );
  assert.ok(
    result.latency.p95LatencyMs < 5.0,
    `Expected p95 latency < 5ms, got ${result.latency.p95LatencyMs.toFixed(3)}ms`
  );

  // Log empirical results for README documentation
  console.log("\n=======================================================");
  console.log("       LARGE-SCALE BENCHMARK EMPIRICAL METRICS         ");
  console.log("=======================================================");
  console.log(`Conversational Turns Tested : ${result.turnsTested}`);
  console.log(`Total Messages in Transcript: ${result.totalMessagesInTranscript}`);
  console.log(`Total Sources Loaded        : ${result.sourcesLoaded.total} (5 skills, 10 files)`);
  console.log(`Sources Selectively Evicted : ${result.sourcesEvicted.total} (3 skills, 5 files)`);
  console.log(`Sources Retained 100% Intact: ${result.sourcesRetained.total} (2 skills, 5 files)`);
  console.log(`Context Size (Before)       : ${result.beforeEviction.totalChars.toLocaleString()} chars (~${result.beforeEviction.estimatedTokens.toLocaleString()} tokens)`);
  console.log(`Context Size (After)        : ${result.afterEviction.totalChars.toLocaleString()} chars (~${result.afterEviction.estimatedTokens.toLocaleString()} tokens)`);
  console.log(`Net Context Window Savings  : ${result.netSavings.charsSaved.toLocaleString()} chars (~${result.netSavings.tokensSaved.toLocaleString()} tokens, ${result.netSavings.percentageReduction.toFixed(2)}% reduction)`);
  console.log(`First Evicted Message Index : Message #${result.prefixCachePreservation.firstEvictionIndex}`);
  console.log(`Prefix-Cache Retention Rate : ${result.prefixCachePreservation.prefixCacheRetentionRate.toFixed(2)}% (Messages 0..${result.prefixCachePreservation.firstEvictionIndex - 1} exact === identity)`);
  console.log(`Average Hook Latency        : ${result.latency.averageTurnLatencyMs.toFixed(3)} ms / turn`);
  console.log(`P95 Hook Latency            : ${result.latency.p95LatencyMs.toFixed(3)} ms / turn`);
  console.log(`Total Benchmark Exec Time   : ${result.latency.totalExecutionTimeMs.toFixed(2)} ms (100 turns)`);
  console.log("=======================================================\n");
});
