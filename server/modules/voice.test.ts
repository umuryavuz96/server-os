import { expect, test } from "bun:test";
import { speakable } from "./voice";

test("chat formatting is stripped before it is spoken", () => {
  expect(speakable("**Build 37** is on your [iPhone](https://x.y) 🎉\n- item one\n`code`")).toBe("Build 37 is on your iPhone \nitem one\ncode");
  expect(speakable("See https://example.com now")).toBe("See a link now");
  expect(speakable("```ts\nconst a = 1\n```\nDone.")).toBe("Done.");
});
