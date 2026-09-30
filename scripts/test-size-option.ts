import assert from "node:assert/strict";
import { sizeFromOptions, withSizeOption } from "../lib/orders/size-option";

assert.deepEqual(withSizeOption(null, "16x20 in"), [{ name: "Size", value: "16x20 in" }]);
assert.deepEqual(withSizeOption([{ name: "Style", value: "Classic" }], " A3 "), [
  { name: "Style", value: "Classic" },
  { name: "Size", value: "A3" },
]);
assert.deepEqual(
  withSizeOption([{ name: "Size:", value: "8x10" }, { name: "Frame", value: "Oak" }], "12x16"),
  [{ name: "Size", value: "12x16" }, { name: "Frame", value: "Oak" }],
);
assert.deepEqual(withSizeOption([{ name: "Canvas", value: "8x10" }, { name: "Frame", value: "Oak" }], ""), [{ name: "Frame", value: "Oak" }]);
assert.equal(sizeFromOptions([{ name: "Frame", value: "Oak" }, { name: "Print size", value: "24x36" }]), "24x36");
assert.equal(sizeFromOptions(null), "");
console.log("size-option ok");
