import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

describe("MarkdownViewer", () => {
  it("renders inline and block LaTeX via KaTeX", () => {
    const { container } = render(
      <MarkdownViewer>{"Mass–energy: $E = mc^2$.\n\n$$\\int_0^1 x^2\\,dx$$"}</MarkdownViewer>,
    );
    // KaTeX emits `.katex` nodes; a plain-text renderer would emit none.
    const math = container.querySelectorAll(".katex");
    expect(math.length).toBeGreaterThanOrEqual(2); // one inline, one display
    // The rendered output carries the variables, not the raw `$…$` delimiters.
    expect(container.textContent).toContain("E");
    expect(container.textContent).not.toContain("$E = mc^2$");
  });

  it("still renders ordinary markdown (a lone $ is not math)", () => {
    const { container } = render(<MarkdownViewer>{"It costs $5 and **works**."}</MarkdownViewer>);
    expect(container.querySelector("strong")?.textContent).toBe("works");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
  });
});
