import { expect, test } from "bun:test";
import { serviceFor, speakable } from "./voice";

test("chat formatting is stripped before it is spoken", () => {
  expect(speakable("**Build 37** is on your [iPhone](https://x.y) 🎉\n- item one\n`code`")).toBe("Build 37 is on your iPhone \nitem one\ncode");
  expect(speakable("See https://example.com now")).toBe("See a link now");
  expect(speakable("```ts\nconst a = 1\n```\nDone.")).toBe("Done.");
});

test("voices are routed to their service by name prefix", () => {
  expect(serviceFor("tr-xtts")).toBe("http://127.0.0.1:8882");
  expect(serviceFor("tr-piper")).toBe("http://127.0.0.1:8882");
  expect(serviceFor("chatterbox")).toBe("http://127.0.0.1:8881");
  expect(serviceFor("af_heart")).toBe("http://127.0.0.1:8880");
  expect(serviceFor(undefined)).toBe("http://127.0.0.1:8880");
});

test("cloud voices route to the Turkish service like the local ones", () => {
  expect(serviceFor("tr-hasan")).toBe("http://127.0.0.1:8882");
});
