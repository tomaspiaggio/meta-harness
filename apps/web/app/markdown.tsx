import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
/** Keep unchanged turns out of the parser on each conversation refresh. */
export const MarkdownMessage = memo(function MarkdownMessage({
  children,
}: {
  children: string;
}) {
  return (
    <div className="output markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Remote images should load only after the user chooses to open them.
          img: ({ src, alt }) =>
            typeof src === "string" && src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || "Open image"}
              </a>
            ) : (
              <span>{alt}</span>
            ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
});
