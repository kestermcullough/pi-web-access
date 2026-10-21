import assert from "node:assert/strict";
import { test } from "node:test";
import { DuckDuckGoBotCheckError, DuckDuckGoRateLimit } from "../duckduckgo-rate-limit.ts";

function fakeClock() {
	const clock = { now: 0, sleeps: [] };
	clock.options = {
		now: () => clock.now,
		sleep: async (ms) => {
			clock.sleeps.push(ms);
			clock.now += ms;
		},
	};
	return clock;
}

test("DuckDuckGo requests run one at a time with a minimum gap between starts", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 2000 });
	const starts = [];
	let active = 0;
	let maxActive = 0;
	const operation = async () => {
		starts.push(clock.now);
		maxActive = Math.max(maxActive, ++active);
		clock.now += 500;
		await Promise.resolve();
		active--;
		return starts.length;
	};
	const results = await Promise.all([gate.run(operation), gate.run(operation), gate.run(operation)]);
	assert.deepEqual(results, [1, 2, 3]);
	assert.deepEqual(starts, [0, 2000, 4000]);
	assert.equal(maxActive, 1);
	assert.deepEqual(clock.sleeps, [1500, 1500]);
});

test("DuckDuckGo bot check starts a cooldown that fails fast, doubles, and resets after success", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 150_000 });
	let calls = 0;
	const blocked = async () => { calls++; throw new DuckDuckGoBotCheckError(202); };
	const ok = async () => { calls++; return "ok"; };

	await assert.rejects(gate.run(blocked), /bot check \(HTTP 202, rate limited\)/);
	await assert.rejects(gate.run(ok), /not retrying for 1m .*rate limited/);
	assert.equal(calls, 1);

	clock.now += 60_000;
	await assert.rejects(gate.run(blocked));
	clock.now += 119_000;
	await assert.rejects(gate.run(ok), /not retrying for 1s/);
	clock.now += 1000;
	await assert.rejects(gate.run(blocked));
	clock.now += 149_000;
	await assert.rejects(gate.run(ok), /not retrying/, "cooldown is capped at maxCooldownMs");
	clock.now += 1000;
	assert.equal(await gate.run(ok), "ok");

	await assert.rejects(gate.run(blocked));
	clock.now += 60_000;
	assert.equal(await gate.run(ok), "ok", "success resets the cooldown to its initial length");
	assert.equal(calls, 6);
});

test("DuckDuckGo errors other than bot checks do not start a cooldown", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0 });
	await assert.rejects(gate.run(async () => { throw new Error("DuckDuckGo search error 503"); }), /503/);
	assert.equal(await gate.run(async () => "ok"), "ok");
});

test("DuckDuckGo queued requests can be aborted without running", async () => {
	const gate = new DuckDuckGoRateLimit({ minIntervalMs: 60_000 });
	let calls = 0;
	await gate.run(async () => { calls++; });
	const controller = new AbortController();
	const queued = gate.run(async () => { calls++; }, controller.signal);
	controller.abort();
	await assert.rejects(queued, /Aborted/);
	await assert.rejects(gate.run(async () => { calls++; }, AbortSignal.abort()), /Aborted/);
	assert.equal(calls, 1);
});
