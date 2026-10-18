/// <reference lib="dom" />
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "../../src/index.js";
import { renderHtml } from "../../src/render.js";

const languages = [
  { lang: "en", dir: "ltr", text: "Hello world" },
  { lang: "ar", dir: "rtl", text: "مرحبًا بالعالم" },
  { lang: "he", dir: "rtl", text: "שלום עולם" },
] as const;

// One worker owns the browsers. Geometry checks prove native layout after the
// real parse/render/sanitize path; CSS-string snapshots cannot prove RTL behavior.
for (const engine of [chromium, firefox, webkit]) describe(engine.name(), () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await engine.launch(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 800, height: 700 } });
    page.setDefaultTimeout(5_000);
  });
  afterEach(async () => { await page.close(); });
  afterAll(async () => { await browser.close(); });

  async function show(source: string, dir: string, lang: string, width = 560): Promise<void> {
    const html = renderHtml(parse(source));
    await page.setContent(`<!doctype html><html lang="${lang}" dir="${dir}"><head><base href="https://layout.test/"><style>
      body { margin: 0; font: 16px/24px Arial, sans-serif; }
      main { width: ${width}px; display: flow-root; }
      p, blockquote, pre { margin: 0; }
    </style></head><body><main>${html}</main></body></html>`);
  }

  for (const { lang, dir, text } of languages) {
    for (const align of ["start", "center", "end"] as const) it(`${lang}: ${align} aligns the block and its text`, async () => {
      await show(`::: layout {align=${align}}\n\n<p id="content" style="width:180px">${text}</p>\n\n:::`, dir, lang);
      const host = (await page.locator("main").boundingBox())!;
      const block = (await page.locator("#content").boundingBox())!;
      const atStart = align === "start" ? dir === "ltr" : dir === "rtl";
      const expectedX = align === "center" ? host.x + (host.width - block.width) / 2 : atStart ? host.x : host.x + host.width - block.width;
      expect(block.x).toBeCloseTo(expectedX, 0);
      const glyphs = await page.locator("#content").evaluate(element => {
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      });
      const expectedTextX = align === "center" ? block.x + (block.width - glyphs.width) / 2 : atStart ? block.x : block.x + block.width - glyphs.width;
      expect(glyphs.x).toBeCloseTo(expectedTextX, 0);
    });

    for (const float of ["start", "end"] as const) it(`${lang}: float=${float} floats a group and surrounding text flows around it`, async () => {
      await show(`::: layout {float=${float} align=center}\n\n<p id="content" style="width:180px">${text}</p>\n\n> ${text}\n\n\`\`\`txt\nexample\ncode\n\`\`\`\n:::\n\n${(`${text} `).repeat(80)}`, dir, lang);
      const host = (await page.locator("main").boundingBox())!;
      const group = (await page.locator('[data-type="layout"]').boundingBox())!;
      const onLeft = float === "start" ? dir === "ltr" : dir === "rtl";
      expect(group.width).toBeCloseTo(180, 0);
      expect(group.x).toBeCloseTo(onLeft ? host.x : host.x + host.width - group.width, 0);
      const flow = await page.locator("main > p").evaluate(element => {
        const textNode = element.firstChild!;
        const range = element.ownerDocument.createRange();
        range.setStart(textNode, 0); range.setEnd(textNode, 1);
        const first = range.getBoundingClientRect();
        range.setStart(textNode, textNode.textContent!.trimEnd().length - 1);
        range.setEnd(textNode, textNode.textContent!.trimEnd().length);
        const last = range.getBoundingClientRect();
        return { first: { x: first.x, right: first.right, y: first.y }, lastY: last.y };
      });
      expect(flow.first.y).toBeLessThan(group.y + group.height);
      if (onLeft) expect(flow.first.x).toBeGreaterThanOrEqual(group.x + group.width - 1);
      else expect(flow.first.right).toBeLessThanOrEqual(group.x + 1);
      expect(flow.lastY).toBeGreaterThanOrEqual(group.y + group.height);
      expect(await page.locator('[data-type="layout"] blockquote').textContent()).toBe(text);
      expect(await page.locator('[data-type="layout"] pre').textContent()).toBe("example\ncode");
    });
  }

  it("centers in a narrow RTL host and honors nested alignment and direction", async () => {
    await page.setViewportSize({ width: 320, height: 700 });
    await show(':::: layout {align=center}\n\n<p id="center" style="width:180px">שלום עולם</p>\n\n::: layout {align=end dir=ltr}\n\n<p id="english" style="width:180px">Hello world</p>\n\n:::\n\n::: layout\n\n<p id="inherited" style="width:180px">مرحبًا بالعالم</p>\n\n:::\n::::', "rtl", "he", 300);
    const host = (await page.locator("main").boundingBox())!;
    const center = (await page.locator("#center").boundingBox())!;
    const english = (await page.locator("#english").boundingBox())!;
    const inherited = (await page.locator("#inherited").boundingBox())!;
    expect(center.x).toBeCloseTo(host.x + 60, 0);
    expect(english.x).toBeCloseTo(host.x, 0);
    expect(inherited.x).toBeCloseTo(center.x, 0);
    expect(await page.locator("#english").evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).direction)).toBe("ltr");
    expect(await page.locator("#english").evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).textAlign)).toBe("end");
    expect(await page.locator("body").evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(320);
  });

  it("uses the RTL parent's start edge when a child changes text direction", async () => {
    await show(':::: layout {align=start}\n::: layout {dir=ltr}\n\n<p id="english" style="width:180px">Hello world</p>\n\n:::\n::::', "rtl", "ar");
    const host = (await page.locator("main").boundingBox())!;
    const child = (await page.locator("#english").boundingBox())!;
    expect(child.x + child.width).toBeCloseTo(host.x + host.width, 0);
    const glyph = await page.locator("#english").evaluate(element => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().x;
    });
    expect(glyph).toBeCloseTo(child.x, 0);
  });

  it("floats an LTR group at the surrounding RTL flow's start edge", async () => {
    await show('::: layout {float=start dir=ltr}\n\n<p style="width:180px">Hello world</p>\n\n:::\n\nمرحبا بالعالم', "rtl", "ar");
    const host = (await page.locator("main").boundingBox())!;
    const group = (await page.locator('[data-type="layout"]').boundingBox())!;
    expect(group.x + group.width).toBeCloseTo(host.x + host.width, 0);
  });

  it("retains native child text overrides and keeps floats inside the containing layout", async () => {
    await show(':::: layout {align=center}\n::: layout {float=start}\n\n<p id="floated" style="width:180px">שלום עולם</p>\n\n:::\n\n<p id="override" style="width:260px;text-align:end">שלום עולם שלום עולם</p>\n\n::::\n\nAfter the layout.', "rtl", "he");
    const outer = (await page.locator('main > [data-type="layout"]').boundingBox())!;
    const floated = (await page.locator("#floated").boundingBox())!;
    const after = (await page.locator("main > p").boundingBox())!;
    expect(floated.x + floated.width).toBeCloseTo(outer.x + outer.width, 0);
    expect(outer.y + outer.height).toBeGreaterThanOrEqual(floated.y + floated.height);
    expect(after.y).toBeGreaterThanOrEqual(outer.y + outer.height);
    expect(await page.locator("#override").evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).textAlign)).toBe("end");
  });

  it("fits a wide image and caption inside a narrow RTL layout", async () => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.route("https://layout.test/diagram.svg", route => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120"><rect width="640" height="120" fill="teal"/></svg>',
    }));
    await show('::: layout {align=center}\n![תרשים](diagram.svg){width=640 height=120}\n\nשלום עולם\n:::', "rtl", "he", 300);
    const host = (await page.locator("main").boundingBox())!;
    const image = (await page.locator("img").boundingBox())!;
    expect(image.width).toBeCloseTo(host.width, 0);
    expect(image.x).toBeCloseTo(host.x, 0);
    expect(await page.locator("body").evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(320);
  });

  it("keeps a thematic break visible inside a centered RTL layout", async () => {
    await show('::: layout {align=center}\nשלום עולם\n\n---\n\nמרحبًا بالعالم\n:::', "rtl", "he");
    const rule = (await page.locator("hr").boundingBox())!;
    expect(rule.width).toBeGreaterThan(100);
  });
});
