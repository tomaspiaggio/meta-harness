"use client";
import DOMPurify from "dompurify";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { BRIEF_KIT_CSS } from "@/lib/brief-kit";

/** Agent-written HTML may echo web content: no scripts, forms or remote loads. */
const remote =
  /url\s*\(\s*(['"]?)(?!data:image\/)[^)]*\)|@import[^;]*;?|expression\s*\(/gi;
let hooked = false;
function sanitize(html: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style" && node.textContent)
        node.textContent = node.textContent.replace(remote, "none");
    });
    DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
      const value = data.attrValue.trim();
      if (data.attrName === "style")
        data.attrValue = value.replace(remote, "none");
      if (data.attrName === "href" || data.attrName === "xlink:href")
        data.keepAttr =
          value.startsWith("#") ||
          (value.startsWith("/") && !value.startsWith("//")) ||
          value.startsWith("https://");
      if (data.attrName === "src")
        data.keepAttr = /^data:image\/(png|jpe?g|gif|webp);/i.test(value);
    });
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (
        node.tagName === "A" &&
        node.getAttribute("href")?.startsWith("https://")
      ) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "link",
      "meta",
      "base",
      "foreignObject",
    ],
    FORBID_ATTR: ["srcset"],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
  });
}
/** Renders a brief in a shadow root: the app's theme and fonts, isolated CSS. */
export function BriefView({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${BRIEF_KIT_CSS}</style>${sanitize(html)}`;
    // Links to conversations navigate inside the app.
    const click = (event: Event) => {
      const link = (event.target as Element | null)?.closest?.("a");
      const href = link?.getAttribute("href");
      if (href?.startsWith("/") && !href.startsWith("//")) {
        event.preventDefault();
        router.push(href);
      }
    };
    root.addEventListener("click", click);
    return () => root.removeEventListener("click", click);
  }, [html, router]);
  return <div ref={host} className="min-w-0" />;
}
