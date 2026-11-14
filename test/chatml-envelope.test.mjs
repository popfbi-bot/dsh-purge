// #107: the injected text used to keep a lone `<|im_start|>system:` opener with no
// closing `<|im_end|>`. The host never speaks ChatML, so that opener only told the
// model "a new system message starts here and never ends", swallowing every
// official section after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  peelChatmlEnvelope,
  stripChatmlTags,
  normalizeChatmlLayout,
} from "../lib/identity.js";

const count = (text, needle) => (text.match(new RegExp(needle.replace(/[|]/g, "\\|"), "g")) || []).length;

test("a lone im_start opener is removed and project_instructions still closes", () => {
  const out = peelChatmlEnvelope("<|im_start|>system:\n<project_instructions>\nBODY\n");
  assert.equal(count(out, "<|im_start|>"), 0);
  assert.equal(count(out, "</project_instructions>"), 1);
  assert.ok(out.startsWith("<project_instructions>"));
});

test("a paired envelope is preserved", () => {
  const out = peelChatmlEnvelope("<|im_start|>system:\n<project_instructions>\nBODY\n<|im_end|>\n");
  assert.equal(count(out, "<|im_start|>"), 1);
  assert.equal(count(out, "<|im_end|>"), 1);
});

test("normalize keeps CRLF/LF inputs equivalent", () => {
  const lf = normalizeChatmlLayout("<|im_start|>system:\nX\n");
  const crlf = normalizeChatmlLayout("<|im_start|>system:\r\nX\r\n");
  assert.equal(lf, crlf);
  assert.equal(count(lf, "<|im_start|>"), 0);
});

test("official sections lose both ChatML tags when they leak in", () => {
  assert.equal(stripChatmlTags("<|im_start|>system: hello <|im_end|>"), "hello ");
});
