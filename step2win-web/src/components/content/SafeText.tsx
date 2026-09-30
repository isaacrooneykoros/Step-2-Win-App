import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Renders staff-written text (announcements, help articles) safely: paragraphs,
 * "- " bullet lists, **bold** and [label](https://… or /in-app-path) links.
 * Never injects HTML. Mirrors step2win-admin/src/components/consoleb/SafeText.tsx.
 */
const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\((?:https:\/\/[^\s)]+|\/[^\s)]*)\))/g;

function inline(text: string, key: string, linkClass: string): ReactNode[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part, i) => {
      const k = `${key}-${i}`;
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={k} className="font-semibold text-text-primary">
            {part.slice(2, -2)}
          </strong>
        );
      }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        return link[2].startsWith('/') ? (
          <Link key={k} to={link[2]} className={linkClass}>
            {link[1]}
          </Link>
        ) : (
          <a key={k} href={link[2]} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {link[1]}
          </a>
        );
      }
      return <Fragment key={k}>{part}</Fragment>;
    });
}

export function SafeText({ text, className = '', linkClass = 'font-semibold text-brand underline underline-offset-2' }: { text: string; className?: string; linkClass?: string }) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return (
    <div className={className}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*-\s+/.test(l))) {
          return (
            <ul key={bi} className="my-1.5 list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*-\s+/, ''), `${bi}-${li}`, linkClass)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi} className="my-1.5 first:mt-0 last:mb-0">
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, `${bi}-${li}`, linkClass)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
