import {
  createContext,
  memo,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openReplyLink, replyUrl } from "./markdown-links";
import "./chat-panel.css";

const FootnotePrefix = createContext("");

function ReplyLink({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const prefix = useContext(FootnotePrefix);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  const url = replyUrl(href ?? "");
  const linkProps = {
    ...props,
    "aria-describedby": props["aria-describedby"]
      ?.split(" ")
      .map((id) => (id === "footnote-label" ? `${prefix}${id}` : id))
      .join(" "),
  };
  if (!url) return <span>{children}</span>;
  if (url.startsWith("#"))
    return (
      <a {...linkProps} href={url}>
        {children}
      </a>
    );
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    const current = ++attempt.current;
    setError(null);
    void openReplyLink(event, url).then((message) => {
      if (attempt.current === current) setError(message);
    });
  };
  return (
    <>
      <a
        {...linkProps}
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={open}
        onAuxClick={(event) => {
          if (event.button === 1) open(event);
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="chat-link-error">
          {" "}
          {error}
        </span>
      )}
    </>
  );
}

const plugins = [remarkGfm];
function ReplyHeading({ node: _node, id, ...props }: ComponentProps<"h2"> & ExtraProps) {
  const prefix = useContext(FootnotePrefix);
  return <h2 {...props} id={id === "footnote-label" ? `${prefix}${id}` : id} />;
}

const components: Components = {
  // A streamed destination change owns fresh request/error state.
  a: (props) => <ReplyLink key={props.href} {...props} />,
  h2: ReplyHeading,
  pre: ({ children }) => (
    <pre tabIndex={0} role="region" aria-label="Code block">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="chat-markdown-table" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt, title }) =>
    src ? (
      <img src={src} alt={alt ?? ""} title={title} loading="lazy" decoding="async" />
    ) : (
      <span>{alt}</span>
    ),
};

/** Primitive props keep completed messages from reparsing while a sibling streams. */
export const MarkdownReply = memo(function MarkdownReply({
  id,
  text,
}: {
  id: string;
  text: string;
}) {
  return (
    <div data-chat-selectable className="chat-markdown">
      <FootnotePrefix value={`chat-${id}-`}>
        <Markdown
          remarkPlugins={plugins}
          remarkRehypeOptions={{ clobberPrefix: `chat-${id}-` }}
          components={components}
          urlTransform={replyUrl}
          skipHtml
        >
          {text}
        </Markdown>
      </FootnotePrefix>
    </div>
  );
});
