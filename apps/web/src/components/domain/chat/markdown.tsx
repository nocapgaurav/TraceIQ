import { Fragment } from 'react';

import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';

/**
 * Renders the supported markdown subset.
 *
 * **Nothing here builds HTML.** The parser produces a token tree and this walks it into React elements, so
 * every piece of model output is a text node React escapes. There is no `dangerouslySetInnerHTML` anywhere
 * in this file, and no markdown library whose HTML passthrough would have to be disabled and kept disabled.
 *
 * Used for **chat messages only**. Repository pages render plain data, as they always have.
 */
export function Markdown({ source }: { readonly source: string }) {
  const blocks = parseMarkdown(source);

  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}

const HEADING_SIZE: Readonly<Record<number, string>> = {
  1: 'text-base font-semibold',
  2: 'text-sm font-semibold',
  3: 'text-sm font-semibold',
  4: 'text-sm font-medium',
  5: 'text-sm font-medium',
  6: 'text-sm font-medium',
};

function BlockView({ block }: { readonly block: Block }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p>
          <InlineView children={block.children} />
        </p>
      );

    case 'heading': {
      // A heading inside a chat message is a paragraph-level emphasis, not a document outline: the page
      // already has an `h1`, and emitting `h2`–`h6` from model output would corrupt the landmark structure
      // a screen reader navigates by. Styled as a heading, marked as a paragraph.
      const Tag = 'p' as const;

      return (
        <Tag className={`${HEADING_SIZE[block.level] ?? 'text-sm font-medium'} mt-1`}>
          <InlineView children={block.children} />
        </Tag>
      );
    }

    case 'code':
      return (
        <figure className="overflow-hidden rounded-md border border-border bg-muted/50">
          {block.language === null ? null : (
            <figcaption className="border-b border-border px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {block.language}
            </figcaption>
          )}
          {/* Wide code scrolls inside its own box, so the page body never scrolls sideways. */}
          <pre className="overflow-x-auto p-3">
            <code className="font-mono text-xs">{block.text}</code>
          </pre>
        </figure>
      );

    case 'list':
      return block.ordered ? (
        <ol className="ml-5 flex list-decimal flex-col gap-1">
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineView children={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="ml-5 flex list-disc flex-col gap-1">
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineView children={item} />
            </li>
          ))}
        </ul>
      );
  }
}

function InlineView({ children }: { readonly children: readonly Inline[] }) {
  return (
    <>
      {children.map((node, index) => {
        switch (node.type) {
          case 'text':
            // A `Fragment` rather than a `span`: plain text needs no element, and wrapping it would put a
            // node between `<strong>` and its content — so `getByText` would find the span, not the strong.
            return <Fragment key={index}>{node.text}</Fragment>;
          case 'code':
            return (
              <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {node.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={index} className="font-semibold">
                <InlineView children={node.children} />
              </strong>
            );
          case 'emphasis':
            return (
              <em key={index} className="italic">
                <InlineView children={node.children} />
              </em>
            );
        }
      })}
    </>
  );
}
