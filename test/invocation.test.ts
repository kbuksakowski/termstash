import { describe, expect, it } from "vitest";
import { invocation } from "../src/cli/invocation.js";

describe("invocation", () => {
  it("is npx termstash when npx is running it from its cache", () => {
    expect(invocation("/Users/you/.npm/_npx/0123456789abcdef/node_modules/.bin/termstash")).toBe("npx termstash");
  });

  it("is termstash for an installed or linked CLI", () => {
    expect(invocation("/usr/local/bin/termstash")).toBe("termstash");
    expect(invocation("/Users/you/.nvm/versions/node/v22.11.0/lib/node_modules/termstash/dist/cli.js")).toBe("termstash");
  });
});
