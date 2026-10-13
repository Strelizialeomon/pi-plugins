import { test } from "node:test";
import assert from "node:assert/strict";
import { greeting } from "./greeting.ts";

test("greeting uses the given name", () => {
	assert.equal(greeting("world"), "Hello, world!");
});
